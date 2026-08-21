import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo, discoverLibraries, defaultRoots } from "../src/discovery.js";
import { isEngineError } from "../src/errors.js";
import { IndexManager } from "../src/store/index-manager.js";
import type { QueryProcess } from "../src/proc/query-client.js";

// Same magic as store/connections.ts's HOT_JOURNAL_MAGIC, duplicated here
// (as readonly-guarantees.test.ts also does) rather than exported from src
// for a test-only constant.
const HOT_JOURNAL_MAGIC = "d9d505f920a163d7";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "edj-disc-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("discovery", () => {
  it("reads a supported library", () => {
    const info = readLibraryInfo(makeLibrary(dir, { tracks: 10 }));
    expect(isEngineError(info)).toBe(false);
    if (isEngineError(info)) return;
    expect(info.schema).toEqual([3, 0, 2]);
    expect(info.supported).toBe(true);
    expect(info.trackCount).toBe(10);
  });

  it("reads a library whose currentPlayedIndiciator overflows a JS number", () => {
    // Measured on two independent real Engine libraries: Information.
    // currentPlayedIndiciator holds -8676408967926364917, a 64-bit value far
    // outside Number.MAX_SAFE_INTEGER. node:sqlite throws rather than
    // returning it unless the statement opts into BigInt reads, and that
    // throw used to be caught and reported as unsupported_schema -- dropping
    // every real library from discoverLibraries() and leaving list_libraries
    // permanently empty. gen-library.ts now bakes in the real value, so this
    // is what discoverLibraries() would actually see against a real library.
    const info = readLibraryInfo(makeLibrary(dir, { tracks: 3 }));
    expect(isEngineError(info), JSON.stringify(info)).toBe(false);
    if (isEngineError(info)) return;
    expect(info.schema).toEqual([3, 0, 2]);
    expect(info.supported).toBe(true);
    expect(info.trackCount).toBe(3);
  });

  it("reports an unsupported schema instead of failing silently", () => {
    const other = mkdtempSync(join(tmpdir(), "edj-old-"));
    const info = readLibraryInfo(makeLibrary(other, { tracks: 5, schema: [2, 18, 0] }));
    expect(isEngineError(info)).toBe(false);
    if (isEngineError(info)) return;
    // Must still be listable: the user has to see WHY it is unusable.
    expect(info.schema).toEqual([2, 18, 0]);
    expect(info.supported).toBe(false);
    rmSync(other, { recursive: true, force: true });
  });

  it("tells an unsupported version, an unreadable database and a hot journal apart", async () => {
    // The regression this guards: all three used to be, or could be,
    // reported as unsupported_schema -- an unreadable database because
    // readLibraryInfo's catch-all used that code for any SELECT failure,
    // and a hot journal because that catch-all is exactly what "attempt to
    // write a readonly database" landed in. Three different real
    // conditions must produce three different codes, not the same one
    // three times over.

    // 1) Unsupported version: a fully readable library outside
    // SUPPORTED_SCHEMAS. readLibraryInfo succeeds -- this was never its
    // error to report -- and IndexManager.ensureFresh() is what turns
    // `supported: false` into the unsupported_schema EngineError a caller
    // actually sees, without ever touching the query process (the
    // unsupported branch returns first), so a stub stands in for it.
    const oldDir = mkdtempSync(join(tmpdir(), "edj-disc-old2-"));
    const oldInfo = readLibraryInfo(makeLibrary(oldDir, { tracks: 5, schema: [2, 18, 0] }));
    expect(isEngineError(oldInfo)).toBe(false);
    if (isEngineError(oldInfo)) return;
    const mgr = new IndexManager(oldInfo, {} as unknown as QueryProcess, join(oldDir, "sidecars"));
    const unsupported = await mgr.ensureFresh();
    expect(isEngineError(unsupported)).toBe(true);
    if (!isEngineError(unsupported)) return;
    expect(unsupported.error).toBe("unsupported_schema");

    // 2) Unreadable database: a version-supported library whose SELECT
    // fails for a reason unrelated to schema -- a real SQLite EXCLUSIVE
    // lock, the same technique degraded.test.ts uses.
    const lockedDir = mkdtempSync(join(tmpdir(), "edj-disc-locked-"));
    const lockedMdb = makeLibrary(lockedDir, { tracks: 5 });
    const holder = new DatabaseSync(lockedMdb);
    holder.exec("BEGIN EXCLUSIVE");
    holder.exec("UPDATE Track SET rating = 3 WHERE id = 1");
    let unreadable: ReturnType<typeof readLibraryInfo>;
    try {
      unreadable = readLibraryInfo(lockedMdb);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(isEngineError(unreadable), JSON.stringify(unreadable)).toBe(true);
    if (!isEngineError(unreadable)) return;
    expect(unreadable.error).toBe("library_unreadable");

    // 3) Hot journal: a rollback journal carrying SQLite's real hot-journal
    // magic -- the same synthetic technique readonly-guarantees.test.ts
    // uses to unit-test hasHotJournal() itself.
    const hotDir = mkdtempSync(join(tmpdir(), "edj-disc-hot-"));
    const hotMdb = makeLibrary(hotDir, { tracks: 5 });
    writeFileSync(`${hotMdb}-journal`, Buffer.from(HOT_JOURNAL_MAGIC + "00".repeat(16), "hex"));
    const hot = readLibraryInfo(hotMdb);
    expect(isEngineError(hot)).toBe(true);
    if (!isEngineError(hot)) return;
    expect(hot.error).toBe("library_needs_recovery");

    // The actual point: three different codes, not one code three times.
    expect(new Set([unsupported.error, unreadable.error, hot.error]).size).toBe(3);

    rmSync(oldDir, { recursive: true, force: true });
    rmSync(lockedDir, { recursive: true, force: true });
    rmSync(hotDir, { recursive: true, force: true });
  });

  it("returns library_not_found for a missing file", () => {
    const info = readLibraryInfo(join(dir, "nope", "m.db"));
    expect(isEngineError(info)).toBe(true);
    if (!isEngineError(info)) return;
    expect(info.error).toBe("library_not_found");
  });

  it("finds libraries under a given root", () => {
    const found = discoverLibraries([dir]);
    expect(found.length).toBe(1);
    expect(found[0]!.supported).toBe(true);
  });

  it("opens a library whose folder name contains a hash, an apostrophe and spaces", () => {
    // readLibraryInfo used to hand-build `file:<path>?mode=ro`, and SQLite's
    // URI syntax cuts a filename at `#`. The result was not an error a user
    // could act on: discoverLibraries drops any candidate that fails to
    // read, so the whole library vanished and the server reported
    // library_not_found -- while openQueryConnection, which escapes
    // properly, opened the very same file without complaint.
    const oddRoot = mkdtempSync(join(tmpdir(), "edj-odd-"));
    try {
      const oddDir = join(oddRoot, "Rock 'n' Roll #1 Mix");
      mkdirSync(oddDir, { recursive: true });
      const oddMdb = makeLibrary(oddDir, { tracks: 7 });
      expect(oddMdb).toContain("#");

      const info = readLibraryInfo(oddMdb);
      expect(isEngineError(info), JSON.stringify(info)).toBe(false);
      if (isEngineError(info)) return;
      expect(info.trackCount).toBe(7);
      expect(info.supported).toBe(true);

      const found = discoverLibraries([oddDir]);
      expect(found.map((l) => l.path)).toEqual([oddMdb]);
    } finally {
      rmSync(oddRoot, { recursive: true, force: true });
    }
  });
});

describe("defaultRoots", () => {
  // Every other test in this suite passes explicit roots, so nothing else
  // would notice defaultRoots() regressing to an empty (or otherwise inert)
  // list -- which would silently disable both discoverLibraries()'s own
  // default lookup and server.ts's hot-journal fallback that reuses this
  // same function. Assert the real value, not just that it returns.
  it("includes the real home Music directory", () => {
    expect(defaultRoots()).toContain(join(homedir(), "Music"));
  });

  it("includes every real /Volumes mount, when /Volumes exists", () => {
    let volumes: string[] = [];
    try {
      volumes = readdirSync("/Volumes");
    } catch {
      return; // /Volumes does not exist off macOS; nothing to assert here
    }
    const roots = defaultRoots();
    for (const vol of volumes) expect(roots).toContain(join("/Volumes", vol));
  });
});
