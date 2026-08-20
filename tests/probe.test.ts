import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readChangeCounter } from "../src/probe.js";

let dir: string, dbPath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-probe-"));
  dbPath = makeLibrary(dir, { tracks: 200 });
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("staleness probe", () => {
  it("detects a change even when mtime and size are preserved", () => {
    // Pin mtime to whole-second granularity, as rsync -t and cloud sync do.
    const sec = Math.floor(statSync(dbPath).mtimeMs / 1000) * 1000;
    utimesSync(dbPath, new Date(sec), new Date(sec));
    const before = { counter: readChangeCounter(dbPath), size: statSync(dbPath).size, mtime: statSync(dbPath).mtimeMs };

    const w = new DatabaseSync(dbPath);
    w.exec("UPDATE Track SET rating = 4 WHERE id = 1");
    w.close();
    utimesSync(dbPath, new Date(sec), new Date(sec));

    const after = { counter: readChangeCounter(dbPath), size: statSync(dbPath).size, mtime: statSync(dbPath).mtimeMs };

    // This is precisely the case mtime+size misses.
    expect(after.mtime).toBe(before.mtime);
    expect(after.size).toBe(before.size);
    expect(after.counter).not.toBe(before.counter);
  });

  it("is stable when nothing is written", () => {
    const a = readChangeCounter(dbPath);
    expect(readChangeCounter(dbPath)).toBe(a);
  });
});
