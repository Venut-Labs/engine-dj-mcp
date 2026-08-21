import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, type EngineError } from "./errors.js";
import { libraryCandidates } from "./paths.js";

export const SUPPORTED_SCHEMAS = ["3.0.0", "3.0.1", "3.0.2"] as const;

export interface LibraryInfo {
  path: string;
  uuid: string;
  schema: [number, number, number];
  supported: boolean;
  trackCount: number | null;
}

export function readLibraryInfo(mdbPath: string): LibraryInfo | EngineError {
  if (!existsSync(mdbPath)) {
    return err("library_not_found", `No Engine library database at ${mdbPath}`);
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(`file:${mdbPath}?mode=ro`, { readOnly: true });
  } catch (e) {
    return err("library_busy", "Could not open the Engine library", {
      detail: String((e as Error).message),
      retry_after_ms: 5000,
    });
  }
  try {
    // SELECT * on purpose: the Information column set differs between versions.
    const row = db.prepare("SELECT * FROM Information LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return err("unsupported_schema", "Information table is empty");

    const schema: [number, number, number] = [
      Number(row.schemaVersionMajor ?? 0),
      Number(row.schemaVersionMinor ?? 0),
      Number(row.schemaVersionPatch ?? 0),
    ];
    const supported = (SUPPORTED_SCHEMAS as readonly string[]).includes(schema.join("."));

    let trackCount: number | null = null;
    try {
      trackCount = Number((db.prepare("SELECT COUNT(*) c FROM Track").get() as any).c);
    } catch {
      trackCount = null; // 1.x has no Track table; still listable.
    }
    return { path: mdbPath, uuid: String(row.uuid ?? ""), schema, supported, trackCount };
  } catch (e) {
    return err("unsupported_schema", "Could not read Information", {
      detail: String((e as Error).message),
    });
  } finally {
    db.close();
  }
}

export function defaultRoots(): string[] {
  const roots = [join(homedir(), "Music")];
  try {
    for (const vol of readdirSync("/Volumes")) roots.push(join("/Volumes", vol));
  } catch {
    // /Volumes does not exist off macOS; ignore.
  }
  return roots;
}

export function discoverLibraries(roots: string[] = defaultRoots()): LibraryInfo[] {
  const out: LibraryInfo[] = [];
  for (const root of roots) {
    for (const candidate of libraryCandidates(root)) {
      if (!existsSync(candidate)) continue;
      const info = readLibraryInfo(candidate);
      if (!("error" in info)) out.push(info);
    }
  }
  return out;
}
