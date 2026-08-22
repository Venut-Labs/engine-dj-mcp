import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from "node:fs";
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
    const returned: string[] = [];
    for (let i = 0; i < 12; i++) {
      const path = await snapshotLibrary(dbPath, "uuid-b", backups);
      returned.push(path as string);
    }
    // The kept snapshots must be exactly the last 10 returned, in sorted order
    const expectedPaths = returned.slice(-10).sort();
    const keptPaths = readdirSync(backups)
      .filter((f) => f.startsWith("uuid-b-") && f.endsWith(".db"))
      .map((f) => join(backups, f))
      .sort();
    expect(keptPaths).toEqual(expectedPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps two libraries that share a uuid in separate namespaces", async () => {
    // A library cloned onto a second drive carries the original's uuid --
    // ordinary for a DJ, and the reason server.ts moves the second claimant's
    // sidecar aside. Keyed on uuid alone, these two shared one namespace and
    // one KEEP window: twelve writes to the drive would silently evict the
    // laptop library's only pre-write snapshot, and the backup_path handed
    // back did not say which drive it came from.
    const dir = mkdtempSync(join(tmpdir(), "bk-clone-"));
    const laptop = makeLibrary(join(dir, "laptop"), { tracks: 2, uuid: "shared-uuid" });
    const usb = makeLibrary(join(dir, "usb"), { tracks: 3, uuid: "shared-uuid" });
    const backups = join(dir, "backups");

    const laptopSnap = (await snapshotLibrary(laptop, "shared-uuid", backups)) as string;
    const usbSnaps: string[] = [];
    for (let i = 0; i < 12; i++) {
      usbSnaps.push((await snapshotLibrary(usb, "shared-uuid", backups)) as string);
    }

    // The laptop's one snapshot is older than all twelve of the USB's and
    // would sort first in a shared namespace -- it must still be here.
    expect(existsSync(laptopSnap)).toBe(true);
    const laptopCopy = new DatabaseSync(laptopSnap, { readOnly: true });
    expect((laptopCopy.prepare("SELECT COUNT(*) c FROM Track").get() as any).c).toBe(2);
    laptopCopy.close();

    // ...and the USB rotated within its own namespace, untouched by the
    // laptop's file sitting in the same directory.
    const kept = readdirSync(backups).filter((f) => f.endsWith(".db"));
    expect(kept.length).toBe(11);
    expect(usbSnaps.slice(-10).every((p) => existsSync(p))).toBe(true);
    expect(usbSnaps.slice(0, 2).some((p) => existsSync(p))).toBe(false);
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
