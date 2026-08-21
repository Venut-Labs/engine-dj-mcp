// tests/playlists.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary, addPlaylists, type PlaylistSpec } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { getPlaylists, getPlaylistTracks } from "../src/tools/playlists.js";
import { searchTracks } from "../src/tools/search.js";
import {
  orderByChain,
  buildPlaylistTree,
  findPlaylistByName,
  loadPlaylistTree,
  type PlaylistRow,
} from "../src/playlists.js";
import { isEngineError } from "../src/errors.js";

/**
 * The playlist fixture, and the reason it has to exist.
 *
 * Both available real libraries agree, in all ten of their non-empty
 * playlists, between `nextEntityId` chain order and row-id order: every
 * track was added at the end and none was ever dragged. So an implementation
 * that wrote `ORDER BY id` instead of walking the chain would pass every
 * assertion a real library can support, and would produce a wrong answer the
 * first time a DJ reorders a playlist. Every chain here is therefore laid
 * out so that following it gives a *different* answer from sorting by id,
 * and each ordering assertion below states both — what the chain says, and
 * that id order would have said something else.
 *
 * Top-level chain (heads first): Split Run -> Orphans -> Broken Ring ->
 * Reordered -> Loose Ends -> Sets. Ids ascend in the opposite grouping
 * (10 Sets, 20 Reordered, 30 Loose Ends, 40 Broken Ring, 50 Split Run,
 * 60 Orphans), so the two disagree at the tree level too.
 */
const MISSING_TRACK_A = 999_998;
const MISSING_TRACK_B = 999_999;

const PLAYLISTS: PlaylistSpec[] = [
  // --- top level, chain order deliberately unlike id order -----------------
  { id: 10, title: "Sets", nextListId: 0 },
  {
    id: 20,
    title: "Reordered",
    nextListId: 30,
    // Chain 103 -> 101 -> 105 -> 102 -> 104 -> 0, i.e. tracks 13, 11, 15,
    // 12, 14 -- while id order would give 11, 12, 13, 14, 15.
    entries: [
      { id: 101, trackId: 11, next: 105 },
      { id: 102, trackId: 12, next: 104 },
      { id: 103, trackId: 13, next: 101 },
      { id: 104, trackId: 14, next: 0 },
      { id: 105, trackId: 15, next: 102 },
    ],
  },
  {
    id: 30,
    title: "Loose Ends",
    nextListId: 10,
    // 502 points at itself: a chain that ends by looping onto one node.
    entries: [
      { id: 501, trackId: 51, next: 502 },
      { id: 502, trackId: 52, next: 502 },
    ],
  },
  {
    id: 40,
    title: "Broken Ring",
    nextListId: 20,
    // A closed loop with no start at all.
    entries: [
      { id: 201, trackId: 21, next: 202 },
      { id: 202, trackId: 22, next: 203 },
      { id: 203, trackId: 23, next: 201 },
    ],
  },
  {
    id: 50,
    title: "Split Run",
    nextListId: 60,
    // Two disconnected runs: 302 -> 301 -> 0, and 304 -> 303 -> (gone).
    // Only one run may end at 0 in a real library, so the other ends on a
    // link to a row that is not there.
    entries: [
      { id: 301, trackId: 31, next: 0 },
      { id: 302, trackId: 32, next: 301 },
      { id: 303, trackId: 33, next: 888_888 },
      { id: 304, trackId: 34, next: 303 },
    ],
  },
  {
    id: 60,
    title: "Orphans",
    nextListId: 40,
    // Chain 401 -> 403 -> 402: one real track then two holes, so a hole is
    // never merely the last thing in the list.
    entries: [
      { id: 401, trackId: 41, next: 403 },
      { id: 402, trackId: MISSING_TRACK_B, next: 0 },
      { id: 403, trackId: MISSING_TRACK_A, next: 402 },
    ],
  },

  // --- inside "Sets": chain House -> Cooldown -> Peak -> Warmup ------------
  {
    id: 11,
    title: "Warmup",
    parentId: 10,
    nextListId: 0,
    // Tracks 1..12 in exactly reverse order, for paging.
    entries: Array.from({ length: 12 }, (_, i) => ({
      id: 600 + i + 1,
      trackId: i + 1,
      next: i === 0 ? 0 : 600 + i,
    })),
  },
  { id: 12, title: "Peak", parentId: 10, nextListId: 11 },
  { id: 13, title: "Cooldown", parentId: 10, nextListId: 12 },
  {
    id: 16,
    title: "House",
    parentId: 10,
    nextListId: 13,
    entries: [
      { id: 711, trackId: 30, next: 0 },
      { id: 712, trackId: 31, next: 711 },
    ],
  },

  // --- inside "Sets/Peak": a second "House", so a bare name is ambiguous ---
  {
    id: 14,
    title: "House",
    parentId: 12,
    nextListId: 0,
    entries: [
      { id: 701, trackId: 20, next: 0 },
      { id: 702, trackId: 21, next: 701 },
    ],
  },
  { id: 15, title: "Techno", parentId: 12, nextListId: 14 },
];

/** Engine's display order for the fixture above: pre-order, chain-ordered. */
const EXPECTED_TREE = [
  ["Split Run", 0, "Split Run"],
  ["Orphans", 0, "Orphans"],
  ["Broken Ring", 0, "Broken Ring"],
  ["Reordered", 0, "Reordered"],
  ["Loose Ends", 0, "Loose Ends"],
  ["Sets", 0, "Sets"],
  ["House", 1, "Sets/House"],
  ["Cooldown", 1, "Sets/Cooldown"],
  ["Peak", 1, "Sets/Peak"],
  ["Techno", 2, "Sets/Peak/Techno"],
  ["House", 2, "Sets/Peak/House"],
  ["Warmup", 1, "Sets/Warmup"],
] as const;

let dir: string, mdb: string, qp: QueryProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-playlists-"));
  mdb = makeLibrary(dir, { tracks: 60 });
  addPlaylists(mdb, PLAYLISTS);
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  const mgr = new IndexManager(lib, qp, join(dir, "sidecars"));
  const fresh = await mgr.ensureFresh();
  if (isEngineError(fresh)) throw new Error(`fixture index: ${JSON.stringify(fresh)}`);
});

afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("orderByChain", () => {
  it("follows next, not id — and would give a different answer if it sorted by id", () => {
    const nodes = [
      { id: 1, next: 0 },
      { id: 2, next: 1 },
      { id: 3, next: 2 },
    ];
    const { order, warnings } = orderByChain(nodes, "x");
    expect(order.map((n) => n.id)).toEqual([3, 2, 1]);
    // Without this, the assertion above would also hold for a chain that
    // happened to agree with id order, and the test would prove nothing.
    expect(order.map((n) => n.id)).not.toEqual(nodes.map((n) => n.id).sort((a, b) => a - b));
    expect(warnings).toEqual([]);
  });

  it("terminates on a closed loop and still returns every node", () => {
    const nodes = [
      { id: 1, next: 2 },
      { id: 2, next: 3 },
      { id: 3, next: 1 },
    ];
    const { order, warnings } = orderByChain(nodes, "Ring");
    // Reaching this line at all is half the assertion: an unbounded walk
    // never returns.
    expect(order.map((n) => n.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(order).toHaveLength(3);
    expect(warnings.join(" ")).toMatch(/no start/i);
    expect(warnings.join(" ")).toContain("Ring");
  });

  it("keeps both runs when a chain is split, and says which link is dangling", () => {
    const nodes = [
      { id: 1, next: 0 },
      { id: 2, next: 1 },
      { id: 3, next: 4242 },
      { id: 4, next: 3 },
    ];
    const { order, warnings } = orderByChain(nodes, "Split");
    expect(order.map((n) => n.id)).toEqual([2, 1, 4, 3]);
    expect(warnings.join(" ")).toMatch(/2 disconnected runs/);
    expect(warnings.join(" ")).toContain("#3 links to #4242");
  });

  it("treats a self-link as an ending rather than losing the node it is on", () => {
    // A self-linked node is still pointed at by nothing else, so a naive
    // "referenced" test would mark it referenced and leave the group
    // headless -- silently downgrading a perfectly readable chain to id
    // order.
    const nodes = [
      { id: 7, next: 9 },
      { id: 9, next: 9 },
    ];
    const { order, warnings } = orderByChain(nodes, "Self");
    expect(order.map((n) => n.id)).toEqual([7, 9]);
    expect(warnings.join(" ")).toMatch(/link to themselves/);
    expect(warnings.join(" ")).not.toMatch(/no start/i);
  });

  it("returns a single node untouched and without complaint", () => {
    const { order, warnings } = orderByChain([{ id: 5, next: 0 }], "One");
    expect(order.map((n) => n.id)).toEqual([5]);
    expect(warnings).toEqual([]);
  });
});

/**
 * Nesting shapes no available library can produce.
 *
 * Neither the USB library nor the local one contains a single folder — every
 * one of their 16 playlists sits at parentListId 0 — so folders, dangling
 * parents and parentListId loops cannot be exercised by reading real data at
 * all. The tree fixture above covers the ordinary two-level case end to end
 * through SQL; these cover the damaged shapes directly against the pure
 * function, which is the only place they can be constructed honestly.
 */
describe("buildPlaylistTree on shapes no available library has", () => {
  const list = (
    id: number,
    title: string,
    parent: number,
    next: number,
  ): PlaylistRow => ({
    id, title, parent, next, isPersisted: true, entryCount: 0, missingCount: 0,
  });

  it("nests to any depth, in chain order at every level", () => {
    const { items, warnings } = buildPlaylistTree([
      list(1, "Root", 0, 0),
      list(2, "B", 1, 0),
      list(3, "A", 1, 2), // chain A -> B, id order B, A
      list(4, "Deep", 3, 0),
    ]);
    expect(items.map((i) => [i.path, i.depth])).toEqual([
      ["Root", 0],
      ["Root/A", 1],
      ["Root/A/Deep", 2],
      ["Root/B", 1],
    ]);
    expect(items.map((i) => i.is_folder)).toEqual([true, true, false, false]);
    expect(warnings).toEqual([]);
  });

  it("surfaces a playlist whose parent folder is gone instead of hiding it", () => {
    const { items, warnings } = buildPlaylistTree([
      list(1, "Kept", 0, 0),
      list(2, "Widow", 77, 1),
    ]);
    expect(items.map((i) => i.path)).toContain("Widow");
    expect(items.find((i) => i.name === "Widow")!.depth).toBe(0);
    expect(items.find((i) => i.name === "Widow")!.parent_id).toBeNull();
    expect(warnings.join(" ")).toContain("names parent #77");
  });

  it("still lists playlists caught in a parentListId loop", () => {
    // A's parent is B and B's parent is A, so no root traversal reaches
    // either. A recursive walk that trusted parentListId would either lose
    // both or spin forever.
    const { items, warnings } = buildPlaylistTree([
      list(1, "Normal", 0, 0),
      list(2, "A", 3, 0),
      list(3, "B", 2, 0),
    ]);
    expect(items.map((i) => i.name).sort()).toEqual(["A", "B", "Normal"]);
    expect(warnings.join(" ")).toMatch(/parentListId loop/);
  });

  it("does not recurse without bound on an absurdly deep tree", () => {
    const rows = Array.from({ length: 200 }, (_, i) => list(i + 1, `L${i + 1}`, i, 0));
    const { items, warnings } = buildPlaylistTree(rows);
    expect(items).toHaveLength(200); // nothing lost to the depth guard
    expect(warnings.join(" ")).toMatch(/nests deeper than 64 levels/);
    expect(Math.max(...items.map((i) => i.depth))).toBeLessThanOrEqual(64);
  });

  it("carries isPersisted through rather than filtering on it", () => {
    // Both values occur on lists Engine displays: 7 of the reference
    // library's 16 playlists have isPersisted = 1 and 9 have 0, and all 16
    // appear in its sidebar. Filtering would hide more than half of them.
    const { items } = buildPlaylistTree([
      { ...list(1, "Saved", 0, 0), isPersisted: true },
      { ...list(2, "Transient", 0, 1), isPersisted: false },
    ]);
    expect(items.map((i) => [i.name, i.is_persisted])).toEqual([
      ["Transient", false],
      ["Saved", true],
    ]);
  });
});

describe("findPlaylistByName", () => {
  const item = (id: number, name: string, path: string) => ({
    id, name, path, parent_id: null, depth: 0, is_folder: false,
    is_persisted: true, track_count: 0, missing_count: 0,
  });

  it("prefers an exact match over a differently-cased sibling", () => {
    // Both are legal at the same time, since uniqueness is on the exact
    // title. A case-insensitive-only match would call this ambiguous and
    // refuse a request that has one obvious answer.
    const items = [item(1, "Peak", "Peak"), item(2, "peak", "peak")];
    expect(findPlaylistByName(items, "Peak").map((i) => i.id)).toEqual([1]);
    expect(findPlaylistByName(items, "peak").map((i) => i.id)).toEqual([2]);
    expect(findPlaylistByName(items, "PEAK").map((i) => i.id).sort()).toEqual([1, 2]);
  });

  it("prefers a path match over a bare name that collides with it", () => {
    const items = [item(1, "A/B", "A/B"), item(2, "B", "A/B (other)")];
    expect(findPlaylistByName(items, "A/B").map((i) => i.id)).toEqual([1]);
  });
});

describe("get_playlists", () => {
  it("returns the tree in Engine's display order, which is not id order", async () => {
    const r = await getPlaylists(qp, {});
    expect(isEngineError(r), JSON.stringify(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.playlists.map((p) => [p.name, p.depth, p.path])).toEqual(
      EXPECTED_TREE.map((row) => [...row]),
    );
    // The claim that matters: an implementation ordering by id would have
    // produced a different list. Pin that here so the assertion above cannot
    // quietly become vacuous.
    const byId = [...r.playlists].sort((a, b) => a.id - b.id).map((p) => p.path);
    expect(r.playlists.map((p) => p.path)).not.toEqual(byId);
    expect(r.total).toBe(PLAYLISTS.length);
    expect(r.truncated).toBe(false);
  });

  it("disagrees with the PlaylistPath view's `position`, which runs from the tail", async () => {
    // The trap this whole module exists to avoid, executed rather than
    // asserted from documentation: Engine ships a view whose column is
    // literally called `position`, and ordering by it reverses a flat list.
    const flatDir = mkdtempSync(join(tmpdir(), "edj-plview-"));
    const flatMdb = makeLibrary(flatDir, { tracks: 5, uuid: "00000000-0000-4000-8000-00000000f1a7" });
    addPlaylists(flatMdb, [
      { id: 1, title: "Alpha", nextListId: 0 },
      { id: 2, title: "Bravo", nextListId: 1 },
      { id: 3, title: "Charlie", nextListId: 2 },
    ]);
    const flatQp = new QueryProcess(flatMdb, null, 5000);
    try {
      const tree = await loadPlaylistTree(flatQp);
      expect(isEngineError(tree), JSON.stringify(tree)).toBe(false);
      if (isEngineError(tree)) return;
      const ours = tree.items.map((p) => p.name);
      expect(ours).toEqual(["Charlie", "Bravo", "Alpha"]);

      const view = await flatQp.run(
        "SELECT p.title FROM PlaylistPath v JOIN Playlist p ON p.id = v.id ORDER BY v.position",
      );
      expect(isEngineError(view), JSON.stringify(view)).toBe(false);
      if (isEngineError(view)) return;
      const viewOrder = view.rows.map((row) => String(row[0]));
      expect(viewOrder).not.toEqual(ours);
      expect(viewOrder).toEqual([...ours].reverse());
    } finally {
      flatQp.dispose();
      rmSync(flatDir, { recursive: true, force: true });
    }
  });

  it("marks a list with children as a folder and one without as not", async () => {
    const r = await getPlaylists(qp, {});
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    const byPath = new Map(r.playlists.map((p) => [p.path, p]));
    expect(byPath.get("Sets")!.is_folder).toBe(true);
    expect(byPath.get("Sets/Peak")!.is_folder).toBe(true);
    expect(byPath.get("Sets/Warmup")!.is_folder).toBe(false);
    expect(byPath.get("Reordered")!.is_folder).toBe(false);
    // parent_id is the folder's id, null at the top -- not 0, which would
    // read as "playlist number zero".
    expect(byPath.get("Sets/Peak")!.parent_id).toBe(10);
    expect(byPath.get("Sets/Peak/House")!.parent_id).toBe(12);
    expect(byPath.get("Sets")!.parent_id).toBeNull();
  });

  it("counts a folder's own entries, never its children's", async () => {
    const r = await getPlaylists(qp, {});
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    const byPath = new Map(r.playlists.map((p) => [p.path, p]));
    // "Sets" holds 16 tracks across its descendants and none of its own.
    expect(byPath.get("Sets/Warmup")!.track_count).toBe(12);
    expect(byPath.get("Sets/House")!.track_count).toBe(2);
    expect(byPath.get("Sets/Peak/House")!.track_count).toBe(2);
    expect(byPath.get("Sets")!.track_count).toBe(0);
    expect(byPath.get("Sets/Peak")!.track_count).toBe(0);
  });

  it("reports how many entries name a track this library does not have", async () => {
    const r = await getPlaylists(qp, {});
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    const byPath = new Map(r.playlists.map((p) => [p.path, p]));
    expect(byPath.get("Orphans")!.track_count).toBe(3);
    expect(byPath.get("Orphans")!.missing_count).toBe(2);
    expect(byPath.get("Reordered")!.missing_count).toBe(0);
  });

  it("names every malformed chain in warnings, and still lists every playlist", async () => {
    const r = await getPlaylists(qp, {});
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    // The tree's own chains are sound, so the only warnings come from
    // reading the tree, not the entries -- there should be none at all here.
    expect(r.warnings).toBeUndefined();
    expect(r.playlists).toHaveLength(PLAYLISTS.length);
  });

  it("truncates to a genuine prefix of the display order and says so", async () => {
    const r = await getPlaylists(qp, { limit: 3 });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.playlists.map((p) => p.name)).toEqual(["Split Run", "Orphans", "Broken Ring"]);
    expect(r.truncated).toBe(true);
    // total is the library's count, not the page's -- otherwise "truncated"
    // is the only sign anything is missing and there is no way to size it.
    expect(r.total).toBe(PLAYLISTS.length);
  });
});

describe("get_playlist_tracks: order", () => {
  it("returns tracks in chain order, which is not the order of the entry ids", async () => {
    // THE test. The fixture's chain is 103 -> 101 -> 105 -> 102 -> 104,
    // carrying tracks 13, 11, 15, 12, 14; sorting the same rows by
    // PlaylistEntity.id gives 11, 12, 13, 14, 15. Both orders are asserted,
    // so this fails for an ORDER BY id implementation rather than passing
    // for both.
    const r = await getPlaylistTracks(qp, { playlist_id: 20, fields: ["id"] });
    expect(isEngineError(r), JSON.stringify(r)).toBe(false);
    if (isEngineError(r)) return;

    const chainOrder = [13, 11, 15, 12, 14];
    const rowIdOrder = [11, 12, 13, 14, 15];
    expect(chainOrder).not.toEqual(rowIdOrder); // the fixture is still doing its job
    expect(r.tracks.map((t) => t.id)).toEqual(chainOrder);
    expect(r.tracks.map((t) => t.id)).not.toEqual(rowIdOrder);
    expect(r.tracks.map((t) => t.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("numbers positions along the chain, so position n is the nth track Engine shows", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 11, fields: ["id"], limit: 200 });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    // Warmup holds tracks 1..12 linked in exact reverse.
    expect(r.tracks.map((t) => t.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(r.tracks.map((t) => t.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("resolves by name and by id to the same ordered answer", async () => {
    const byId = await getPlaylistTracks(qp, { playlist_id: 20, fields: ["id"] });
    const byName = await getPlaylistTracks(qp, { playlist_name: "Reordered", fields: ["id"] });
    if (isEngineError(byId) || isEngineError(byName)) throw new Error("resolution failed");
    expect(byName.tracks).toEqual(byId.tracks);
    expect(byName.playlist.id).toBe(20);
  });
});

describe("get_playlist_tracks: entries whose track is gone", () => {
  it("keeps the hole in place instead of shortening the playlist", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 60, fields: ["id"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.entry_count).toBe(3);
    expect(r.missing_count).toBe(2);
    // Three rows for three entries: the count a caller sees must agree with
    // the playlist's own length, or a 43-entry playlist coming back with one
    // row looks like a paging bug.
    expect(r.tracks).toHaveLength(3);
    expect(r.tracks[0]).toMatchObject({ position: 1, id: 41 });
    expect(r.tracks[0]!.missing).toBeUndefined();
    expect(r.tracks[1]).toEqual({
      position: 2,
      entry_id: 403,
      track_id: MISSING_TRACK_A,
      missing: true,
    });
    expect(r.tracks[2]).toEqual({
      position: 3,
      entry_id: 402,
      track_id: MISSING_TRACK_B,
      missing: true,
    });
  });

  it("flags a hole by name rather than by null-filled fields", async () => {
    // A missing row must not look like a track whose artist and title happen
    // to be null -- those are different facts and a model has to be able to
    // tell them apart.
    const r = await getPlaylistTracks(qp, { playlist_id: 60, fields: ["id", "artist", "title"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    const hole = r.tracks[1]!;
    expect(hole.missing).toBe(true);
    expect(hole).not.toHaveProperty("artist");
    expect(hole).not.toHaveProperty("title");
    expect(r.tracks[0]).toHaveProperty("artist");
  });
});

describe("get_playlist_tracks: chains this server does not control", () => {
  it("does not hang on a closed loop, and returns every entry with an explanation", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 40, fields: ["id"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.entry_count).toBe(3);
    expect(r.tracks).toHaveLength(3);
    expect(r.tracks.map((t) => t.id).sort()).toEqual([21, 22, 23]);
    expect(r.warnings, "a degraded order must be reported, not implied").toBeDefined();
    expect(r.warnings!.join(" ")).toMatch(/no start/i);
    expect(r.warnings!.join(" ")).toContain("Broken Ring");
  });

  it("returns both runs of a split chain rather than the first one alone", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 50, fields: ["id"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    // 302 -> 301 -> 0 then 304 -> 303 -> (gone): tracks 32, 31, 34, 33.
    expect(r.tracks.map((t) => t.id)).toEqual([32, 31, 34, 33]);
    expect(r.entry_count).toBe(4);
    const text = r.warnings!.join(" ");
    expect(text).toMatch(/2 disconnected runs/);
    expect(text).toContain("#303 links to #888888");
  });

  it("ends the chain at a self-link without dropping that entry", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 30, fields: ["id"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.tracks.map((t) => t.id)).toEqual([51, 52]);
    expect(r.warnings!.join(" ")).toMatch(/link to themselves/);
  });

  it("says nothing when the chain is sound", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 20, fields: ["id"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.warnings).toBeUndefined();
  });
});

describe("get_playlist_tracks: naming a playlist", () => {
  it("refuses an ambiguous name and names every candidate with its full path", async () => {
    // "House" exists under Sets and under Sets/Peak. Picking one would give
    // a confidently wrong answer.
    const r = await getPlaylistTracks(qp, { playlist_name: "House" });
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("invalid_argument");
    expect(r.message).toContain("2 playlists");
    expect(r.detail).toContain("Sets/House");
    expect(r.detail).toContain("Sets/Peak/House");
    expect(r.detail).toContain("16 --");
    expect(r.detail).toContain("14 --");
    // Actionable: it has to say how to fix it, not just that it is broken.
    expect(r.detail).toMatch(/playlist_id/);
  });

  it("resolves the ambiguity by full path, and picks the right one of the two", async () => {
    // Both lists are named "House" and hold two tracks, so only the track
    // ids can show that the right one was selected.
    const outer = await getPlaylistTracks(qp, { playlist_name: "Sets/House", fields: ["id"] });
    const inner = await getPlaylistTracks(qp, { playlist_name: "Sets/Peak/House", fields: ["id"] });
    if (isEngineError(outer) || isEngineError(inner)) throw new Error("path resolution failed");
    expect(outer.playlist.id).toBe(16);
    expect(outer.tracks.map((t) => t.id)).toEqual([31, 30]);
    expect(inner.playlist.id).toBe(14);
    expect(inner.tracks.map((t) => t.id)).toEqual([21, 20]);
  });

  it("matches a name whose case differs, but prefers an exact match", async () => {
    const r = await getPlaylistTracks(qp, { playlist_name: "reordered", fields: ["id"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.playlist.id).toBe(20);
  });

  it("lists what is available when the name matches nothing", async () => {
    const r = await getPlaylistTracks(qp, { playlist_name: "Nonexistent" });
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("invalid_argument");
    expect(r.detail).toContain("Sets/Peak/Techno");
    expect(r.detail).toContain("Reordered");
  });

  it("rejects an unknown id, and both/neither selectors", async () => {
    const unknown = await getPlaylistTracks(qp, { playlist_id: 4242 });
    expect(isEngineError(unknown)).toBe(true);
    if (isEngineError(unknown)) expect(unknown.message).toContain("4242");

    const both = await getPlaylistTracks(qp, { playlist_id: 20, playlist_name: "Reordered" });
    expect(isEngineError(both)).toBe(true);
    if (isEngineError(both)) expect(both.message).toMatch(/not both/);

    const neither = await getPlaylistTracks(qp, {});
    expect(isEngineError(neither)).toBe(true);
    if (isEngineError(neither)) expect(neither.message).toMatch(/playlist_id or playlist_name/);
  });
});

describe("get_playlist_tracks: projection and paging", () => {
  it("defaults to the same projection as search_tracks, plus position", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 20 });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(Object.keys(r.tracks[0]!)).toEqual([
      "position", "id", "artist", "title", "bpm", "camelot", "rating",
    ]);
  });

  it("rejects an unknown field and an empty field list exactly as the other tools do", async () => {
    const unknown = await getPlaylistTracks(qp, { playlist_id: 20, fields: ["id", "nope"] });
    expect(isEngineError(unknown)).toBe(true);
    if (isEngineError(unknown)) {
      expect(unknown.message).toContain("Unknown field(s): nope");
      expect(unknown.detail).toContain("Recognised fields:");
    }
    const empty = await getPlaylistTracks(qp, { playlist_id: 20, fields: [] });
    expect(isEngineError(empty)).toBe(true);
    if (isEngineError(empty)) {
      expect(empty.message).toBe("No fields requested");
      expect(empty.detail ?? "").not.toMatch(/syntax error/i);
    }
  });

  it("pages without losing or repeating a position, and keeps chain order across pages", async () => {
    const seen: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await getPlaylistTracks(qp, {
        playlist_id: 11,
        fields: ["id"],
        limit: 5,
        cursor,
      });
      if (isEngineError(r)) throw new Error(JSON.stringify(r));
      seen.push(...r.tracks.map((t) => t.id));
      cursor = r.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    // The concatenated pages must equal the single-call chain order, not
    // merely contain the same ids.
    expect(seen).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("stops paging at the end rather than handing back a cursor to nothing", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 11, fields: ["id"], limit: 12 });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.tracks).toHaveLength(12);
    expect(r.next_cursor).toBeUndefined();
  });

  it("refuses a cursor from a different playlist instead of paging the wrong list", async () => {
    const first = await getPlaylistTracks(qp, { playlist_id: 11, fields: ["id"], limit: 5 });
    if (isEngineError(first)) throw new Error(JSON.stringify(first));
    const misused = await getPlaylistTracks(qp, {
      playlist_id: 20,
      fields: ["id"],
      cursor: first.next_cursor,
    });
    // Position 6 exists in neither list's sense of the other, and "Reordered"
    // has only five entries -- so a cursor that was silently accepted would
    // return an empty page that reads like an empty playlist.
    expect(isEngineError(misused)).toBe(true);
    if (isEngineError(misused)) expect(misused.message).toMatch(/different playlist/);
  });

  it("rejects a malformed cursor", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 11, cursor: "not-a-cursor" });
    expect(isEngineError(r)).toBe(true);
    if (isEngineError(r)) expect(r.message).toBe("Malformed cursor");
  });
});

describe("search_tracks: playlist filter", () => {
  it("narrows the search to that playlist's members and no others", async () => {
    const r = await searchTracks(qp, {
      playlist: { id: 20 },
      fields: ["id"],
      limit: 200,
    });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.tracks.map((t) => t.id).sort((a, b) => Number(a) - Number(b))).toEqual([
      11, 12, 13, 14, 15,
    ]);
    // Same search without the filter reaches the whole library, so the
    // filter is doing the narrowing rather than the limit.
    const unfiltered = await searchTracks(qp, { fields: ["id"], limit: 200 });
    if (isEngineError(unfiltered)) throw new Error(JSON.stringify(unfiltered));
    expect(unfiltered.tracks.length).toBeGreaterThan(r.tracks.length);
  });

  it("picks the right list when a full path disambiguates two same-named playlists", async () => {
    const outer = await searchTracks(qp, {
      playlist: { name: "Sets/House" },
      fields: ["id"],
      limit: 200,
    });
    const inner = await searchTracks(qp, {
      playlist: { name: "Sets/Peak/House" },
      fields: ["id"],
      limit: 200,
    });
    if (isEngineError(outer) || isEngineError(inner)) throw new Error("path resolution failed");
    expect(outer.tracks.map((t) => t.id).sort((a, b) => Number(a) - Number(b))).toEqual([30, 31]);
    expect(inner.tracks.map((t) => t.id).sort((a, b) => Number(a) - Number(b))).toEqual([20, 21]);
    expect(outer.playlist).toEqual({ id: 16, name: "House", path: "Sets/House" });
  });

  it("combines with the other filters rather than replacing them", async () => {
    const all = await searchTracks(qp, { playlist: { id: 11 }, fields: ["id", "bpm"], limit: 200 });
    if (isEngineError(all)) throw new Error(JSON.stringify(all));
    expect(all.tracks).toHaveLength(12);
    const cutoff = 128;
    const expected = all.tracks.filter((t) => Number(t.bpm) >= cutoff).map((t) => t.id);
    // A meaningless assertion if every track already qualifies, or none does.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(12);

    const narrowed = await searchTracks(qp, {
      playlist: { id: 11 },
      bpm: { min: cutoff },
      fields: ["id", "bpm"],
      limit: 200,
    });
    if (isEngineError(narrowed)) throw new Error(JSON.stringify(narrowed));
    expect(narrowed.tracks.map((t) => t.id)).toEqual(expected);
  });

  it("counts only the playlist's members when include_total is asked for", async () => {
    const r = await searchTracks(qp, {
      playlist: { id: 20 },
      fields: ["id"],
      limit: 2,
      include_total: true,
    });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.tracks).toHaveLength(2);
    expect(r.total).toBe(5);
  });

  it("refuses to page a filtered search with a cursor from an unfiltered one", async () => {
    // The cursor fingerprint covers the filter set; a playlist filter that
    // did not reach it would page through the wrong result set silently.
    const unfiltered = await searchTracks(qp, { fields: ["id"], limit: 2 });
    if (isEngineError(unfiltered)) throw new Error(JSON.stringify(unfiltered));
    expect(unfiltered.next_cursor).toBeDefined();
    const reused = await searchTracks(qp, {
      playlist: { id: 11 },
      fields: ["id"],
      limit: 2,
      cursor: unfiltered.next_cursor,
    });
    expect(isEngineError(reused)).toBe(true);
    if (isEngineError(reused)) expect(reused.message).toMatch(/different search/);
  });

  it("reports an ambiguous or unknown playlist instead of returning nothing", async () => {
    const ambiguous = await searchTracks(qp, { playlist: { name: "House" }, fields: ["id"] });
    expect(isEngineError(ambiguous)).toBe(true);
    if (isEngineError(ambiguous)) {
      expect(ambiguous.message).toContain("2 playlists");
      // Each tool blames its own argument names.
      expect(ambiguous.detail).toContain("playlist.id");
    }
    const unknown = await searchTracks(qp, { playlist: { name: "Nope" }, fields: ["id"] });
    expect(isEngineError(unknown)).toBe(true);

    const bothWays = await searchTracks(qp, { playlist: { id: 20, name: "Reordered" } });
    expect(isEngineError(bothWays)).toBe(true);
    if (isEngineError(bothWays)) expect(bothWays.message).toMatch(/playlist\.id or playlist\.name/);
  });

  it("does not report a playlist when no playlist filter was used", async () => {
    const r = await searchTracks(qp, { fields: ["id"], limit: 1 });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.playlist).toBeUndefined();
  });
});

describe("a library with no playlists at all", () => {
  let emptyDir: string, emptyQp: QueryProcess;
  beforeAll(() => {
    emptyDir = mkdtempSync(join(tmpdir(), "edj-nopl-"));
    const emptyMdb = makeLibrary(emptyDir, {
      tracks: 5,
      uuid: "00000000-0000-4000-8000-00000000e999",
    });
    emptyQp = new QueryProcess(emptyMdb, null, 5000);
  });
  afterAll(() => {
    emptyQp.dispose();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("returns an empty tree rather than an error", async () => {
    const r = await getPlaylists(emptyQp, {});
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    expect(r.playlists).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("says so when a playlist is named against a library that has none", async () => {
    const r = await getPlaylistTracks(emptyQp, { playlist_name: "Anything" });
    expect(isEngineError(r)).toBe(true);
    if (isEngineError(r)) expect(r.detail).toBe("This library has no playlists.");
  });
});
