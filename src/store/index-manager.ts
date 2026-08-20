import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readChangeCounter } from "../probe.js";
import { buildSidecar } from "../sidecar/build.js";
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

  #storedCounter(): number | null {
    if (!existsSync(this.path)) return null;
    try {
      const db = new DatabaseSync(this.path, { readOnly: true });
      try {
        const row = db.prepare("SELECT change_counter, generation FROM index_meta LIMIT 1").get() as
          | { change_counter: number; generation: number }
          | undefined;
        if (row?.generation) this.#generation = Number(row.generation);
        return row ? Number(row.change_counter) : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
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
      // Serving the previous index beats refusing to answer: search while
      // Engine DJ is open should keep working on a slightly old index. But
      // say so honestly: on the very first build there is no previous
      // index to fall back on.
      return /locked|busy/i.test(message)
        ? err(
            "index_stale",
            hadPrevious
              ? "The library was busy; the previous index is still in use"
              : "The library was busy; the index could not be built yet",
            { retry_after_ms: 5000 },
          )
        : err("library_busy", "Could not rebuild the index", { detail: message });
    }

    // rename() is invisible to an already-open connection: the query
    // process keeps reading the old inode unless told to re-attach.
    try {
      renameSync(tmp, this.path);
    } catch (e) {
      // A cross-device rename or a filesystem failure here must not throw:
      // the freshly built file just never becomes the active index.
      return err(
        "index_stale",
        hadPrevious
          ? "The rebuilt index could not be swapped in; the previous index is still in use"
          : "The rebuilt index could not be swapped in; no index is available yet",
        { detail: String((e as Error).message) },
      );
    }
    this.#generation += 1;
    await this.qp.setSidecar(this.path);

    return { rebuilt: true, generation: this.#generation, ...built };
  }
}
