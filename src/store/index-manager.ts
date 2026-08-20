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
  indexed: number;
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
      return { rebuilt: false, indexed: -1, elapsed_ms: 0, generation: this.#generation };
    }

    mkdirSync(join(this.baseDir, this.lib.uuid), { recursive: true });
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
      // Engine DJ is open should keep working on a slightly old index.
      return /locked|busy/i.test(message)
        ? err("index_stale", "The library was busy; the previous index is still in use", {
            retry_after_ms: 5000,
          })
        : err("library_busy", "Could not rebuild the index", { detail: message });
    }

    // rename() is invisible to an already-open connection: the query
    // process keeps reading the old inode unless told to re-attach.
    renameSync(tmp, this.path);
    this.#generation += 1;
    await this.qp.setSidecar(this.path);

    return { rebuilt: true, generation: this.#generation, ...built };
  }
}
