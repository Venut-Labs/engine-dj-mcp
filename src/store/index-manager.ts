import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readChangeCounter } from "../probe.js";
import { buildSidecar } from "../sidecar/build.js";
import { SIDECAR_FORMAT } from "../sidecar/schema.js";
import { sidecarDir } from "../paths.js";
import { err, type EngineError } from "../errors.js";
import type { LibraryInfo } from "../discovery.js";
import type { QueryProcess } from "../proc/query-client.js";

export interface FreshResult {
  rebuilt: boolean;
  indexed: number | null;
  elapsed_ms: number;
  generation: number;
}

/**
 * Owns the sidecar's whole lifecycle: staleness probe, rebuild, atomic swap
 * and the re-attach handshake with the live query process.
 *
 * The staleness probe reads the SQLite header change counter, not mtime and
 * size: a restore that preserves mtime (rsync -t, Dropbox, Time Machine,
 * Engine DJ Cloud) changes the file's contents while mtime and size stay
 * identical, and an mtime/size probe would then never see the library as
 * stale again.
 */
export class IndexManager {
  #generation = 0;
  #attached = false;

  constructor(
    private readonly lib: LibraryInfo,
    private readonly qp: QueryProcess,
    private readonly baseDir: string = sidecarDir(""),
  ) {}

  get generation(): number {
    return this.#generation;
  }

  get path(): string {
    return join(this.baseDir, this.lib.uuid, "index.db");
  }

  /**
   * The change counter the sidecar on disk was built from, or null when
   * there is no usable sidecar — which forces a rebuild.
   *
   * `index_format` is checked alongside it. The change counter alone answers
   * "is the index's *content* current"; it cannot answer "does the index
   * still mean what this code thinks it means". When a derived column's
   * definition changes (has_cues did: from "a blob exists" to "a cue is
   * set"), a library nobody has touched since keeps the same counter, and
   * without this check the old meaning would be served from disk for as long
   * as the user left their library alone. A sidecar predating the column
   * fails the SELECT outright and lands in the same catch.
   */
  #storedCounter(): number | null {
    if (!existsSync(this.path)) return null;
    try {
      const db = new DatabaseSync(this.path, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT change_counter, generation, index_format FROM index_meta LIMIT 1")
          .get() as
          | { change_counter: number; generation: number; index_format: number | null }
          | undefined;
        if (row?.generation) this.#generation = Number(row.generation);
        if (!row || Number(row.index_format) !== SIDECAR_FORMAT) return null;
        return Number(row.change_counter);
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * Hands the on-disk index to the live query process, unless it is already
   * attached. A QueryProcess is constructed with no sidecar, so *every* path
   * out of ensureFresh that leaves an existing index in service has to do
   * this -- including the two that never rebuild anything (the index is
   * already fresh; the library was busy and the previous index still
   * serves). Without it those paths return a success/index_stale result
   * while `side` is not attached at all, and the next tool query dies on
   * "no such table: side.track_derived".
   *
   * The short-circuit also checks qp.hasSidecar, not just #attached: a
   * worker respawn racing a failed setSidecar could otherwise leave
   * #attached true while the live process actually has nothing attached,
   * which would let this report success with nothing attached -- the same
   * class of failure the comment above describes, just reached from the
   * other side.
   */
  async #attach(): Promise<boolean> {
    if (this.#attached && this.qp.hasSidecar) return true;
    this.#attached = await this.qp.setSidecar(this.path);
    return this.#attached;
  }

  async ensureFresh(): Promise<FreshResult | EngineError> {
    if (!this.lib.supported) {
      return err("unsupported_schema", `Schema ${this.lib.schema.join(".")} is not supported`, {
        detail: "Supported versions are 3.0.0, 3.0.1 and 3.0.2",
      });
    }

    let current: number;
    try {
      current = readChangeCounter(this.lib.path);
    } catch (e) {
      return err("library_not_found", "Could not read the library header", { detail: String(e) });
    }

    if (this.#storedCounter() === current) {
      // A fresh index on disk is not the same as a fresh index in service:
      // on the first call of a new process nothing is attached yet, and the
      // index built by a previous run would otherwise never be reached.
      if (!(await this.#attach())) {
        return err("index_stale", "The existing index could not be attached", {
          retry_after_ms: 5000,
        });
      }
      // null, not a count: nothing was rebuilt this call, so there is no
      // "tracks indexed just now" number to report. -1 previously stood in
      // here and could be read by a caller as "minus one track indexed".
      return { rebuilt: false, indexed: null, elapsed_ms: 0, generation: this.#generation };
    }

    // Captured before the directory/build attempt: distinguishes "the
    // library was locked and we had nothing to fall back on" from "the
    // library was locked but the previous index is still serving fine".
    const hadPrevious = existsSync(this.path);

    try {
      mkdirSync(join(this.baseDir, this.lib.uuid), { recursive: true });
    } catch (e) {
      // A permissions failure or full disk here must not throw out of
      // ensureFresh: errors at this layer are structured returns, not
      // exceptions.
      return err("library_busy", "Could not create the sidecar directory", {
        detail: String((e as Error).message),
      });
    }

    const tmp = `${this.path}.tmp`;
    let built: { indexed: number; elapsed_ms: number };
    try {
      built = buildSidecar({
        mdbPath: this.lib.path,
        outPath: tmp,
        uuid: this.lib.uuid,
        schema: this.lib.schema.join("."),
        generation: this.#generation + 1,
      });
    } catch (e) {
      const message = String((e as Error).message);
      if (!/locked|busy/i.test(message)) {
        return err("library_busy", "Could not rebuild the index", { detail: message });
      }
      // Serving the previous index beats refusing to answer: search while
      // Engine DJ is open should keep working on a slightly old index. But
      // say so honestly, and only after the previous index is genuinely in
      // service -- on the very first build there is nothing to fall back on,
      // and "the previous index is still in use" was previously reported
      // even when nothing had ever been attached.
      const serving = hadPrevious && (await this.#attach());
      return err(
        "index_stale",
        serving
          ? "The library was busy; the previous index is still in use"
          : "The library was busy; the index could not be built yet",
        { retry_after_ms: 5000 },
      );
    }

    // rename() is invisible to an already-open connection: the query
    // process keeps reading the old inode unless told to re-attach.
    try {
      renameSync(tmp, this.path);
    } catch (e) {
      // A cross-device rename or a filesystem failure here must not throw:
      // the freshly built file just never becomes the active index.
      const serving = hadPrevious && (await this.#attach());
      return err(
        "index_stale",
        serving
          ? "The rebuilt index could not be swapped in; the previous index is still in use"
          : "The rebuilt index could not be swapped in; no index is available yet",
        { detail: String((e as Error).message), retry_after_ms: 5000 },
      );
    }
    this.#generation += 1;
    // The swap replaced the inode, so an already-attached connection is
    // still reading the old file: force the re-attach, do not short-circuit
    // on #attached.
    this.#attached = await this.qp.setSidecar(this.path);
    if (!this.#attached) {
      return err("index_stale", "The rebuilt index could not be attached", { retry_after_ms: 5000 });
    }

    return { rebuilt: true, generation: this.#generation, ...built };
  }
}
