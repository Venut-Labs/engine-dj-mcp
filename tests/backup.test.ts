import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { snapshotLibrary, evictable } from "../src/store/backup.js";
import { isEngineError } from "../src/errors.js";

describe("evictable", () => {
  const U = "u";
  const names = (tag: string, stamps: string[], legacy: string[]) => [
    ...stamps.map((x) => `${U}-${tag}-${x}.db`),
    ...legacy.map((x) => `${U}-${x}.db`),
  ];

  it("orders by the stamp, not by the filename, so a low tag cannot evict the newest", () => {
    // The defect this exists for. Sorting whole names compares a tag against
    // a year at the same offset, and a tag is hex: "1e269292c523" < "2026",
    // so with a low tag the newest snapshot sorted to the head of the list
    // and was deleted -- the very file the caller had just been handed as
    // its way back. It passed locally under tag "cf11e2d00f88" and failed in
    // CI under "1e269292c523" on identical code, which is exactly how a bug
    // that depends on a hash behaves.
    // The mix is what exposes it: among names sharing one tag, sorting by
    // name and sorting by stamp agree. It takes an untagged neighbour, whose
    // name carries a year where the tagged one carries hex, to put them in
    // conflict.
    const tagged = Array.from({ length: 6 }, (_, i) => `2026-08-2${i}T00-00-00-000Z`);
    const legacy = Array.from({ length: 6 }, (_, i) => `2020-01-0${i}T00-00-00-000Z`);
    for (const tag of ["1e269292c523", "cf11e2d00f88"]) {
      const out = evictable(names(tag, tagged, legacy), U, tag);
      // Twelve files, ten kept: the two evicted are the oldest untagged ones,
      // never the freshly written snapshot.
      expect(out, tag).toEqual([`${U}-${legacy[0]}.db`, `${U}-${legacy[1]}.db`]);
      expect(out, tag).not.toContain(`${U}-${tag}-${tagged[5]}.db`);
    }
  });

  it("ages untagged names out first, whatever their stamp says", () => {
    // They predate the tagged scheme, so they predate anything written since
    // -- including an untagged file whose stamp reads later than a tagged
    // one, which a clock change or a restored backup can produce.
    const tag = "1e269292c523";
    const tagged = Array.from({ length: 10 }, (_, i) => `2020-01-0${i}T00-00-00-000Z`);
    const out = evictable(names(tag, tagged, ["2099-01-01T00-00-00-000Z"]), U, tag);
    expect(out).toEqual([`${U}-2099-01-01T00-00-00-000Z.db`]);
  });

  it("keeps everything while the window is not full, and ignores other libraries", () => {
    const out = evictable(
      [...names("aa11", ["2026-01-01T00-00-00-000Z"], []), "other-uuid-bb22-2026-01-01T00-00-00-000Z.db", "notes.txt"],
      U,
      "aa11",
    );
    expect(out).toEqual([]);
  });
});

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

  it("rotates snapshots left by a version that did not tag them", async () => {
    // Names gained the path tag after the first release that wrote them, so an
    // upgrading user has files shaped `${uuid}-${stamp}.db` sitting outside
    // every tagged namespace. The rotation filter matched only the new shape,
    // so those were never reclaimed -- up to KEEP full copies of a library per
    // uuid, kept forever. They are older than anything written since, so
    // folding them into the same window evicts them first, which is the point.
    const dir = mkdtempSync(join(tmpdir(), "bk-legacy-"));
    const dbPath = makeLibrary(dir, { tracks: 2, uuid: "uuid-legacy" });
    const backups = join(dir, "backups");
    mkdirSync(backups, { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(backups, `uuid-legacy-2026-08-2${i % 10}T00-00-0${i % 10}-000Z-0000000001.db`), "old");
    }
    const out = await snapshotLibrary(dbPath, "uuid-legacy", backups);
    expect(isEngineError(out)).toBe(false);

    const kept = readdirSync(backups).filter((f) => f.endsWith(".db"));
    expect(kept.length).toBe(10);
    // The one just written is never the one evicted.
    expect(kept).toContain((out as string).split("/").pop());
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
