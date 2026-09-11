// tests/streaming-fields.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks, DEFAULT_FIELDS } from "../src/tools/search.js";
import { getTracks } from "../src/tools/tracks.js";
import { getPlaylistTracks } from "../src/tools/playlists.js";
import { redactUri } from "../src/paths.js";
import { isEngineError } from "../src/errors.js";

/**
 * Track.streamingSource, uri and streamingFlags (#8). Reported to decide
 * whether Engine OS streams a track rather than reading it from disk; not
 * measured here -- in both reference libraries streamingSource and uri are
 * NULL on every track. The fixture sets them by hand so the projection can be
 * seen to carry them at all.
 */
const DROPBOX_URI =
  "streaming://Dropbox/Track/" + encodeURIComponent("/Engine Library/Music/a.flac");
// Percent-encoded, a home directory is `%2FUsers%2F<name>` -- a redaction that
// only looks for a leading `/Users/<name>` would never fire on it.
const HOME_ENCODED_URI =
  "streaming://Dropbox/Track/" + encodeURIComponent(join(homedir(), "Dropbox", "Engine Library", "b.flac"));

let dir: string, mdb: string, qp: QueryProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-stream-"));
  mdb = makeLibrary(dir, { tracks: 5 });
  addPlaylists(mdb, [{ id: 1, title: "Set", nextListId: 0, entries: [
    { id: 1, trackId: 1, next: 2 }, { id: 2, trackId: 2, next: 0 },
  ] }]);
  const raw = new DatabaseSync(mdb);
  const set = raw.prepare("UPDATE Track SET streamingSource = ?, streamingFlags = ?, uri = ? WHERE id = ?");
  set.run("Dropbox", 5, DROPBOX_URI, 1);
  set.run("Dropbox", 5, HOME_ENCODED_URI, 2);
  raw.close();
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});
afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const FIELDS = ["id", "streaming_source", "streaming_flags", "uri"];

describe("streaming columns as fields", () => {
  it("are selectable in search_tracks and carry the stored values", async () => {
    const r = await searchTracks(qp, { fields: FIELDS, limit: 5, redact_paths: false });
    if (isEngineError(r)) throw new Error(r.message);
    const t1 = r.tracks.find((t) => t.id === 1)!;
    expect(t1).toEqual({ id: 1, streaming_source: "Dropbox", streaming_flags: 5, uri: DROPBOX_URI });
    const t3 = r.tracks.find((t) => t.id === 3)!;
    expect(t3).toEqual({ id: 3, streaming_source: null, streaming_flags: null, uri: null });
  });

  it("are selectable in get_tracks", async () => {
    const r = await getTracks(qp, { ids: [1], fields: FIELDS, redact_paths: false });
    if (isEngineError(r)) throw new Error(r.message);
    expect(r.tracks[0]).toEqual({ id: 1, streaming_source: "Dropbox", streaming_flags: 5, uri: DROPBOX_URI });
  });

  it("are selectable in get_playlist_tracks", async () => {
    const r: any = await getPlaylistTracks(qp, { playlist_id: 1, fields: FIELDS, redact_paths: false });
    expect(r.error).toBeUndefined();
    expect(r.tracks[0]).toMatchObject({ id: 1, streaming_source: "Dropbox", streaming_flags: 5, uri: DROPBOX_URI });
  });

  it("stay out of the default projection", () => {
    // Diagnostic columns that are NULL on every measured track: asked for,
    // not handed over with every search result.
    for (const f of FIELDS.slice(1)) expect(DEFAULT_FIELDS as readonly string[]).not.toContain(f);
  });
});

describe("uri redaction", () => {
  it("folds a percent-encoded home directory inside a uri, by default", async () => {
    const off = await searchTracks(qp, { fields: ["id", "uri"], limit: 5, redact_paths: false });
    const on = await searchTracks(qp, { fields: ["id", "uri"], limit: 5 });
    if (isEngineError(off) || isEngineError(on)) throw new Error("search failed");
    const rawUri = String(off.tracks.find((t) => t.id === 2)!.uri);
    const shown = String(on.tracks.find((t) => t.id === 2)!.uri);
    // Guard against a vacuous pass: the raw value really does carry the
    // account name, encoded.
    expect(rawUri).toContain(encodeURIComponent(homedir()));
    expect(shown).not.toContain(encodeURIComponent(homedir()));
    expect(shown).toBe(redactUri(rawUri));
    expect(shown.startsWith("streaming://Dropbox/Track/~")).toBe(true);
  });

  it("is redacted by get_tracks and get_playlist_tracks too, not only by search", async () => {
    // The point of one presentField: a path-bearing field redacted in one of
    // the three projecting tools and leaked by the other two.
    const t: any = await getTracks(qp, { ids: [2], fields: ["id", "uri"] });
    const p: any = await getPlaylistTracks(qp, { playlist_id: 1, fields: ["id", "uri"] });
    const enc = encodeURIComponent(homedir());
    expect(String(t.tracks[0].uri)).not.toContain(enc);
    expect(String(p.tracks.find((x: any) => x.id === 2).uri)).not.toContain(enc);
    expect(String(t.tracks[0].uri).startsWith("streaming://Dropbox/Track/~")).toBe(true);
  });

  it("leaves a uri with no home directory in it untouched, on or off", async () => {
    const on = await searchTracks(qp, { fields: ["id", "uri"], limit: 5 });
    if (isEngineError(on)) throw new Error("search failed");
    expect(on.tracks.find((t) => t.id === 1)!.uri).toBe(DROPBOX_URI);
  });
});

describe("redactUri", () => {
  const home = homedir();
  const enc = encodeURIComponent(home);

  it("folds the home directory raw or percent-encoded, in either case of hex", () => {
    expect(redactUri(`file://${home}/Music/x.flac`)).toBe("file://~/Music/x.flac");
    expect(redactUri(`s://D/T/${enc}%2FMusic`)).toBe("s://D/T/~%2FMusic");
    // Encoders differ on hex case; %2f is as valid as %2F.
    expect(redactUri(`s://D/T/${enc.replace(/%2F/g, "%2f")}%2fMusic`)).toBe("s://D/T/~%2fMusic");
  });

  it("does not fold a different account whose name merely starts the same", () => {
    // /Users/ann must not eat the start of /Users/anna.
    const sibling = `${home}x`;
    expect(redactUri(`file://${sibling}/a`)).toBe(`file://${sibling}/a`);
    expect(redactUri(`s://${encodeURIComponent(sibling)}%2Fa`)).toBe(`s://${encodeURIComponent(sibling)}%2Fa`);
  });

  it("leaves everything else alone", () => {
    expect(redactUri(DROPBOX_URI)).toBe(DROPBOX_URI);
    expect(redactUri("")).toBe("");
  });
});
