// tests/privacy.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks, DEFAULT_FIELDS } from "../src/tools/search.js";
import { getTracks } from "../src/tools/tracks.js";
import { listLibraries } from "../src/tools/libraries.js";
import { redactPath } from "../src/paths.js";
import { isEngineError } from "../src/errors.js";

let dir: string, mdb: string, qp: QueryProcess;

/**
 * Track.path is normally stored relative to the "Engine Library" folder
 * (see src/paths.ts), so the fixture generator's paths never contain $HOME
 * to begin with -- a "does not contain $HOME" assertion against them would
 * pass whether or not redaction did anything. The design note this task
 * closes (§9: "absolute paths contain the username") is about the case
 * where a stored path *is* absolute, so track 1's path is rewritten to a
 * realistic absolute path under $HOME after indexing, directly on the
 * fixture file. Track 2 is left with its original relative path, to prove
 * redaction leaves an unrelated value alone in the same result set.
 */
const ABS_UNDER_HOME = join(homedir(), "Music", "external", "track1.mp3");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-priv-"));
  mdb = makeLibrary(dir, { tracks: 50 });
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();

  const raw = new DatabaseSync(mdb);
  raw.exec("PRAGMA busy_timeout=3000");
  raw.prepare("UPDATE Track SET path = ? WHERE id = 1").run(ABS_UNDER_HOME);
  raw.close();
});
afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("privacy", () => {
  it("keeps listening history out of the default projection", () => {
    expect(DEFAULT_FIELDS).not.toContain("last_played");
    expect(DEFAULT_FIELDS).not.toContain("path");
  });

  it("replaces the home directory with a tilde, leaving unrelated paths untouched", () => {
    expect(redactPath(join(homedir(), "Music", "x.mp3"))).toBe(join("~", "Music", "x.mp3"));
    expect(redactPath(homedir())).toBe("~");
    expect(redactPath("/Volumes/USB/x.mp3")).toBe("/Volumes/USB/x.mp3");
    // A sibling directory that merely shares the home directory as a string
    // prefix (not a path-segment prefix) must not be folded.
    expect(redactPath(homedir() + "-backup/x.mp3")).toBe(homedir() + "-backup/x.mp3");
  });

  it("redacts an absolute home path in search results by default, without mangling it", async () => {
    // redact_paths: false first, both to know the raw value the pipeline
    // actually read off disk and to confirm the crafted fixture row really
    // is absolute and under $HOME -- otherwise the assertions below would
    // pass vacuously.
    const off = await searchTracks(qp, { fields: ["id", "path"], limit: 1, redact_paths: false });
    expect(isEngineError(off)).toBe(false);
    if (isEngineError(off)) return;
    expect(off.tracks[0]!.id).toBe(1);
    expect(off.tracks[0]!.path).toBe(ABS_UNDER_HOME);

    const on = await searchTracks(qp, { fields: ["id", "path"], limit: 1 }); // redact_paths defaults to true
    expect(isEngineError(on)).toBe(false);
    if (isEngineError(on)) return;
    const redacted = String(on.tracks[0]!.path);

    expect(redacted).not.toContain(homedir());
    // Still the same file: only the home prefix changed, not the rest of
    // the path. A redaction that truncated or otherwise mangled the tail
    // would satisfy the "not.toContain" check above but fail this one.
    expect(redacted).toBe("~" + ABS_UNDER_HOME.slice(homedir().length));
  });

  it("leaves a path outside the home directory unchanged, on or off", async () => {
    const off = await searchTracks(qp, { fields: ["id", "path"], limit: 2 });
    expect(isEngineError(off)).toBe(false);
    if (isEngineError(off)) return;
    const track2 = off.tracks.find((t) => t.id === 2);
    expect(track2).toBeDefined();
    const rawPath = String(track2!.path);
    expect(rawPath.startsWith(homedir())).toBe(false);

    const on = await searchTracks(qp, { fields: ["id", "path"], limit: 2, redact_paths: false });
    expect(isEngineError(on)).toBe(false);
    if (isEngineError(on)) return;
    const track2Off = on.tracks.find((t) => t.id === 2);
    expect(String(track2Off!.path)).toBe(rawPath);
  });

  it("can be turned off explicitly to get the raw path back", async () => {
    const r = await searchTracks(qp, { fields: ["id", "path"], limit: 1, redact_paths: false });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks[0]!.path).toBe(ABS_UNDER_HOME);
  });
});

describe("get_tracks path redaction", () => {
  // Reuses the shared fixture above: track 1's path was rewritten to
  // ABS_UNDER_HOME, track 2 keeps its original relative (non-home) path.
  it("redacts an absolute home path by default, without mangling it", async () => {
    const off = await getTracks(qp, { ids: [1], fields: ["id", "path"], redact_paths: false });
    expect(isEngineError(off)).toBe(false);
    if (isEngineError(off)) return;
    expect(off.tracks[0]!.path).toBe(ABS_UNDER_HOME);

    const on = await getTracks(qp, { ids: [1], fields: ["id", "path"] }); // redact_paths defaults to true
    expect(isEngineError(on)).toBe(false);
    if (isEngineError(on)) return;
    const redacted = String(on.tracks[0]!.path);

    expect(redacted).not.toContain(homedir());
    expect(redacted).toBe("~" + ABS_UNDER_HOME.slice(homedir().length));
  });

  it("leaves a path outside the home directory unchanged, on or off", async () => {
    const off = await getTracks(qp, { ids: [2], fields: ["id", "path"] });
    expect(isEngineError(off)).toBe(false);
    if (isEngineError(off)) return;
    const rawPath = String(off.tracks[0]!.path);
    expect(rawPath.startsWith(homedir())).toBe(false);

    const on = await getTracks(qp, { ids: [2], fields: ["id", "path"], redact_paths: false });
    expect(isEngineError(on)).toBe(false);
    if (isEngineError(on)) return;
    expect(String(on.tracks[0]!.path)).toBe(rawPath);
  });
});

describe("abs_path SQL function", () => {
  // abs_path exists precisely to turn a relative Track.path into an
  // absolute one, so it is the newest way for the user's account name to
  // reach a model provider -- through run_sql, which has no redact_paths
  // switch of its own. It folds the home prefix like every other absolute
  // path this project hands back.
  it("folds the home prefix on a path it resolves under $HOME", async () => {
    const r = await qp.run("SELECT abs_path(t.path) FROM Track t WHERE t.id = 1");
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    const resolved = String(r.rows[0]![0]);
    // The fixture's track 1 path was rewritten to an absolute path under
    // $HOME in beforeAll, so this really does exercise the home branch.
    expect(ABS_UNDER_HOME.startsWith(homedir() + "/")).toBe(true);
    expect(resolved).not.toContain(homedir());
    expect(resolved).toBe(redactPath(ABS_UNDER_HOME));
  });
});

describe("list_libraries path redaction", () => {
  let homeDir: string, homeMdb: string;
  let outsideDir: string, outsideMdb: string;

  beforeAll(() => {
    // A library's own path (m.db's location) is routinely absolute in real
    // use, unlike Track.path elsewhere in this suite -- so this fixture is
    // rooted directly under $HOME rather than crafted after the fact.
    homeDir = mkdtempSync(join(homedir(), ".edj-mcp-lib-priv-"));
    homeMdb = makeLibrary(homeDir, { tracks: 5 });

    outsideDir = mkdtempSync(join(tmpdir(), "edj-lib-priv-outside-"));
    outsideMdb = makeLibrary(outsideDir, { tracks: 5 });
  });
  afterAll(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("redacts a library path under $HOME without mangling it", () => {
    expect(homeMdb.startsWith(homedir() + "/")).toBe(true); // sanity: fixture really is under $HOME
    const homeLib = readLibraryInfo(homeMdb);
    if (isEngineError(homeLib)) throw new Error("fixture library unreadable");

    const result = listLibraries(new Map(), [homeLib]);
    const reported = result.libraries[0]!.path;
    expect(reported).not.toContain(homedir());
    expect(reported).toBe("~" + homeMdb.slice(homedir().length));
  });

  it("leaves a library path outside $HOME unchanged", () => {
    expect(outsideMdb.startsWith(homedir())).toBe(false);
    const outsideLib = readLibraryInfo(outsideMdb);
    if (isEngineError(outsideLib)) throw new Error("fixture library unreadable");

    const result = listLibraries(new Map(), [outsideLib]);
    expect(result.libraries[0]!.path).toBe(outsideMdb);
  });
});
