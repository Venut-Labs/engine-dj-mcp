import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { snapshotLibrary, evictable, abandonedPartials } from "../src/store/backup.js";
import { spawnSync } from "node:child_process";
import { libraryTag } from "../src/paths.js";
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

/** A pid that belonged to a real process which has since exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid!;
}

describe("a snapshot that does not finish (#3)", () => {
  // backup() writing straight to the final name meant a copy that died
  // partway left an incomplete database under a name indistinguishable from a
  // good snapshot. Rotation counted it as the newest and evicted a real one to
  // make room, and "restore the most recent backup" would have restored the
  // truncated file.
  //
  // It is copied under a temporary name now and renamed only once backup()
  // has resolved. The piece that was missing before is a way to make backup()
  // fail *after* it has started writing -- no real failure reachable from a
  // test does that -- and that is what injecting it provides.

  function lib() {
    const dir = mkdtempSync(join(tmpdir(), "snap-partial-"));
    const mdb = makeLibrary(dir, { tracks: 5, uuid: "snap-uuid" });
    return { dir, mdb, base: join(dir, "backups") };
  }

  it("leaves no file under a snapshot's name when the copy dies partway", async () => {
    const { dir, mdb, base } = lib();
    const good = await snapshotLibrary(mdb, "snap-uuid", base);
    expect(isEngineError(good)).toBe(false);
    const before = readdirSync(base).sort();

    // Starts writing the destination, then fails: the shape of a disk filling
    // or a drive going away mid-copy.
    const dying = async (_src: unknown, dest: string) => {
      writeFileSync(dest, "SQLite format 3\0 -- and then nothing");
      throw new Error("ENOSPC: no space left on device");
    };
    const r = await snapshotLibrary(mdb, "snap-uuid", base, { backup: dying as any });

    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("library_unreadable");
    // Nothing new under a .db name -- so nothing rotation would count, and
    // nothing anyone would restore -- and the partial copy is gone too.
    expect(readdirSync(base).sort()).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the journal the dying copy left beside it, too", async () => {
    const { dir, mdb, base } = lib();
    await snapshotLibrary(mdb, "snap-uuid", base);
    const before = readdirSync(base).sort();
    const dying = async (_src: unknown, dest: string) => {
      writeFileSync(dest, "partial");
      writeFileSync(`${dest}-journal`, "journal of a copy that will never finish");
      throw new Error("ENOSPC: no space left on device");
    };
    await snapshotLibrary(mdb, "snap-uuid", base, { backup: dying as any });
    expect(readdirSync(base).sort()).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never lets a dead copy evict a good snapshot", async () => {
    // Fill the window, then fail once. With the old behaviour the failed copy
    // took the newest slot and the oldest good snapshot was deleted for it.
    const { dir, mdb, base } = lib();
    for (let i = 0; i < 10; i++) await snapshotLibrary(mdb, "snap-uuid", base);
    const good = readdirSync(base).filter((n) => n.endsWith(".db")).sort();
    expect(good.length).toBe(10);

    const dying = async (_src: unknown, dest: string) => {
      writeFileSync(dest, "partial");
      throw new Error("drive went away");
    };
    await snapshotLibrary(mdb, "snap-uuid", base, { backup: dying as any });
    expect(readdirSync(base).filter((n) => n.endsWith(".db")).sort()).toEqual(good);
    rmSync(dir, { recursive: true, force: true });
  });

  it("finishes with a complete snapshot under its final name and no partial left", async () => {
    const { dir, mdb, base } = lib();
    const r = await snapshotLibrary(mdb, "snap-uuid", base);
    expect(isEngineError(r)).toBe(false);
    expect(String(r).endsWith(".db")).toBe(true);
    const copy = new DatabaseSync(String(r), { readOnly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM Track").get() as any).n).toBe(5);
    copy.close();
    expect(readdirSync(base).filter((n) => n.includes(".partial-"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("clears a partial copy left by a process that died, before copying again", async () => {
    // A process killed mid-copy never reaches its own cleanup. Its leftover is
    // recognisable -- the pid is in the name -- and removable once that pid
    // is gone. Removed before the next copy rather than after it, because a
    // disk that filled up is exactly when that space is needed back.
    const { dir, mdb, base } = lib();
    mkdirSync(base, { recursive: true });
    const prefix = `snap-uuid-${libraryTag(mdb)}-`;
    const orphan = `${prefix}2026-01-01T00-00-00-000Z-0000000001.db.partial-${deadPid()}`;
    writeFileSync(join(base, orphan), "half a database");
    // SQLite keeps a rollback journal beside the copy while backup() runs --
    // measured: `<partial>-journal` exists mid-copy and is gone after -- so a
    // process killed partway leaves the journal behind as well.
    writeFileSync(join(base, `${orphan}-journal`), "its journal");

    await snapshotLibrary(mdb, "snap-uuid", base);
    expect(existsSync(join(base, orphan))).toBe(false);
    expect(existsSync(join(base, `${orphan}-journal`))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a partial copy alone while the process writing it is alive", async () => {
    // Two servers can snapshot the same library at once. The other one's
    // in-flight copy looks exactly like an orphan except that its pid is
    // running -- deleting it would break that server's write.
    const { dir, mdb, base } = lib();
    mkdirSync(base, { recursive: true });
    const prefix = `snap-uuid-${libraryTag(mdb)}-`;
    const inflight = `${prefix}2026-01-01T00-00-00-000Z-0000000001.db.partial-${process.ppid}`;
    writeFileSync(join(base, inflight), "being written right now");
    writeFileSync(join(base, `${inflight}-journal`), "and its journal");

    await snapshotLibrary(mdb, "snap-uuid", base);
    expect(existsSync(join(base, inflight))).toBe(true);
    // Deleting a live copy's journal while leaving the copy would be worse
    // than deleting both: the other server's copy would be left inconsistent.
    expect(existsSync(join(base, `${inflight}-journal`))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves another library's partial copies alone, dead or not", async () => {
    const { dir, mdb, base } = lib();
    mkdirSync(base, { recursive: true });
    const other = `other-uuid-000000000000-2026-01-01T00-00-00-000Z-0000000001.db.partial-${deadPid()}`;
    writeFileSync(join(base, other), "not ours");

    await snapshotLibrary(mdb, "snap-uuid", base);
    expect(existsSync(join(base, other))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("abandonedPartials", () => {
  it("names only this library's partial copies whose writer is gone", () => {
    const alive = (pid: number) => pid === 111;
    const names = [
      "u-t-2026-A.db",                 // a finished snapshot: never a partial
      "u-t-2026-B.db.partial-111",     // writer alive
      "u-t-2026-C.db.partial-222",     // writer dead: this one
      "x-y-2026-D.db.partial-222",     // another library
      "u-t-2026-E.db.partial-abc",     // not a pid
      "u-t-2026-C.db.partial-222-journal", // the dead copy's journal: this one too
      "u-t-2026-B.db.partial-111-journal", // the live copy's journal: never
    ];
    expect(abandonedPartials(names, "u-t-", alive)).toEqual([
      "u-t-2026-C.db.partial-222",
      "u-t-2026-C.db.partial-222-journal",
    ]);
  });

  it("is never counted as a snapshot by rotation", () => {
    const names = Array.from({ length: 11 }, (_, i) => `u-t-2026-${String(i).padStart(2, "0")}.db`);
    names.push("u-t-2027-99.db.partial-222");
    const out = evictable(names, "u", "t");
    expect(out).toEqual(["u-t-2026-00.db"]);
  });
});
