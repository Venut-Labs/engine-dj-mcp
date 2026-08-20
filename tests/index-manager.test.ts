// tests/index-manager.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
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
});
