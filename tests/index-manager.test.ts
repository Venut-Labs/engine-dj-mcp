// tests/index-manager.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { SIDECAR_FORMAT } from "../src/sidecar/schema.js";
import { isEngineError } from "../src/errors.js";

let dir: string, mdb: string, qp: QueryProcess, mgr: IndexManager;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-mgr-"));
  mdb = makeLibrary(dir, { tracks: 300 });
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  mgr = new IndexManager(lib, qp, join(dir, "sidecars"));
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("index lifecycle", () => {
  it("builds on first use", async () => {
    const r = await mgr.ensureFresh();
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(true);
    expect(r.indexed).toBe(300);
  });

  it("does not rebuild when nothing changed", async () => {
    const r = await mgr.ensureFresh();
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(false);
    // null, not a sentinel count: nothing was rebuilt, so there is no
    // "tracks indexed just now" number. A caller must not read this as -1
    // (or any other number) of tracks.
    expect(r.indexed).toBeNull();
  });

  it("rebuilds after a write and the query process sees the new index", async () => {
    const w = new DatabaseSync(mdb);
    w.exec("UPDATE Track SET title = 'freshly renamed marker' WHERE id = 7");
    w.close();

    const r = await mgr.ensureFresh();
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(true);

    const hit = await qp.run(
      "SELECT m.track_id FROM side.fts_track f JOIN side.fts_map m ON m.rowid = f.rowid WHERE f.fts_track MATCH 'freshly'",
    );
    expect(isEngineError(hit)).toBe(false);
    if (isEngineError(hit)) return;
    expect(hit.rows).toEqual([[7]]);
  });

  it("rebuilds a sidecar written by a different index format, even though the library has not changed", async () => {
    // The staleness probe compares the library's change counter, and the
    // change counter does not move when *this code's* idea of a column
    // changes. has_cues did change meaning (from "a quickCues blob exists"
    // to "a hot cue is set"), so without a format check a user whose
    // library sits untouched would go on being served the old answer off
    // disk for as long as they left it alone.
    const fresh = await mgr.ensureFresh();
    expect(isEngineError(fresh)).toBe(false);
    if (isEngineError(fresh)) return;
    expect(fresh.rebuilt).toBe(false); // nothing has changed: the baseline

    // Only the format marker is touched -- the change counter still matches
    // the library exactly, so a rebuild here can only be the format check.
    const w = new DatabaseSync(mgr.path);
    w.exec(`UPDATE index_meta SET index_format = ${SIDECAR_FORMAT - 1}`);
    w.close();

    const r = await mgr.ensureFresh();
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(true);
    expect(r.indexed).toBe(300);

    const after = new DatabaseSync(mgr.path, { readOnly: true });
    const meta = after.prepare("SELECT index_format FROM index_meta").get() as {
      index_format: number;
    };
    after.close();
    expect(meta.index_format).toBe(SIDECAR_FORMAT);
  });

  it("returns a structured error instead of throwing when the sidecar directory cannot be created", async () => {
    // A base directory made unwritable stands in for a permissions failure
    // or a full disk: mkdirSync must not be allowed to throw out of
    // ensureFresh, since errors at this layer are structured returns.
    const roRoot = mkdtempSync(join(tmpdir(), "edj-mgr-ro-"));
    chmodSync(roRoot, 0o500); // read + execute only: no write, so no child can be created

    const lib2 = readLibraryInfo(mdb);
    if (isEngineError(lib2)) throw new Error("fixture library unreadable");
    const qp2 = new QueryProcess(mdb, null, 5000);
    try {
      const mgr2 = new IndexManager(lib2, qp2, join(roRoot, "sidecars"));
      const r = await mgr2.ensureFresh();
      expect(isEngineError(r)).toBe(true);
      if (!isEngineError(r)) return;
      expect(r.error).toBe("library_busy");
      expect(r.detail).toBeTruthy();
    } finally {
      qp2.dispose();
      chmodSync(roRoot, 0o700);
      rmSync(roRoot, { recursive: true, force: true });
    }
  });
});

describe("peekGeneration", () => {
  // The cheap half of ensureFresh(), used by list_libraries so that asking
  // "what libraries do I have" is never the call that pays for a first (or
  // renewed) index build. Both tests below would fail if peekGeneration()
  // ever called ensureFresh() (or buildSidecar) internally: a fresh library
  // would end up with a sidecar file on disk and an attached query
  // connection, neither of which this method is allowed to cause.
  it("reads 0 without building or attaching anything, on a library never indexed", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "edj-mgr-peek-fresh-"));
    const freshMdb = makeLibrary(freshDir, { tracks: 50 });
    const lib = readLibraryInfo(freshMdb);
    if (isEngineError(lib)) throw new Error("fixture library unreadable");
    const freshQp = new QueryProcess(freshMdb, null, 5000);
    const freshMgr = new IndexManager(lib, freshQp, join(freshDir, "sidecars"));
    try {
      expect(freshMgr.peekGeneration()).toBe(0);
      expect(existsSync(freshMgr.path)).toBe(false);
      expect(freshQp.hasSidecar).toBe(false);
    } finally {
      freshQp.dispose();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("reads a generation a previous IndexManager instance actually built, without calling ensureFresh", async () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "edj-mgr-peek-shared-"));
    const sharedMdb = makeLibrary(sharedDir, { tracks: 20 });
    const lib = readLibraryInfo(sharedMdb);
    if (isEngineError(lib)) throw new Error("fixture library unreadable");
    const sidecars = join(sharedDir, "sidecars");

    const qpA = new QueryProcess(sharedMdb, null, 5000);
    const mgrA = new IndexManager(lib, qpA, sidecars);
    try {
      const built = await mgrA.ensureFresh();
      expect(isEngineError(built)).toBe(false);
      if (isEngineError(built)) return;
      expect(built.generation).toBe(1);
    } finally {
      qpA.dispose();
    }

    // A second instance over the same sidecar directory, standing in for a
    // fresh server process (or list_libraries reading a library another
    // tool call already indexed): peekGeneration() must report the real
    // on-disk generation without ever calling ensureFresh() on this
    // instance, and without attaching the sidecar to this qp either.
    const qpB = new QueryProcess(sharedMdb, null, 5000);
    const mgrB = new IndexManager(lib, qpB, sidecars);
    try {
      expect(mgrB.peekGeneration()).toBe(1);
      expect(qpB.hasSidecar).toBe(false);
    } finally {
      qpB.dispose();
      rmSync(sharedDir, { recursive: true, force: true });
    }
  });
});
