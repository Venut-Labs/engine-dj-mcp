import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { snapshotLibrary } from "../src/store/backup.js";
import { isEngineError } from "../src/errors.js";

describe("snapshotLibrary", () => {
  it("copies a readable library and the copy holds the same rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    const dbPath = makeLibrary(dir, { tracks: 12, uuid: "uuid-a" });
    const out = await snapshotLibrary(dbPath, "uuid-a", join(dir, "backups"));
    expect(isEngineError(out)).toBe(false);

    const copy = new DatabaseSync(out as string, { readOnly: true });
    expect((copy.prepare("SELECT COUNT(*) c FROM Track").get() as any).c).toBe(12);
    expect((copy.prepare("PRAGMA integrity_check").get() as any)["integrity_check"]).toBe("ok");
    copy.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps only the newest ten snapshots for one library", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-rot-"));
    const dbPath = makeLibrary(dir, { tracks: 2, uuid: "uuid-b" });
    const backups = join(dir, "backups");
    for (let i = 0; i < 12; i++) await snapshotLibrary(dbPath, "uuid-b", backups);
    const kept = readdirSync(backups).filter((f) => f.startsWith("uuid-b-"));
    expect(kept.length).toBe(10);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports library_unreadable rather than throwing when the source is not a database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-bad-"));
    const bad = join(dir, "not-a.db");
    writeFileSync(bad, "this is not sqlite");
    const out = await snapshotLibrary(bad, "uuid-c", join(dir, "backups"));
    expect(isEngineError(out)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
