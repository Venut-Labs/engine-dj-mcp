import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  err,
  isEngineError,
  libraryNeedsRecovery,
  EngineErrorException,
  LIBRARY_NEEDS_RECOVERY_MESSAGE,
} from "../src/errors.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("error taxonomy", () => {
  it("builds a structured error, never throws", () => {
    const e = err("library_busy", "Engine DJ is writing", { retry_after_ms: 5000 });
    expect(e).toEqual({
      error: "library_busy",
      message: "Engine DJ is writing",
      retry_after_ms: 5000,
    });
  });

  it("recognises its own errors and rejects look-alikes", () => {
    expect(isEngineError(err("library_not_found", "no library"))).toBe(true);
    expect(isEngineError({ error: "not_a_code", message: "x" })).toBe(false);
    expect(isEngineError(null)).toBe(false);
    expect(isEngineError("library_busy")).toBe(false);
  });
});

describe("library_needs_recovery has one source", () => {
  it("appears literally in exactly one source file", () => {
    // The text was hand-written in three files, so a wording change fixed it
    // in one place and left two stale copies a user would see instead. This
    // is the only assertion that actually catches the duplication coming
    // back -- every behavioural test passes with three identical copies.
    const phrase = "Launch Engine DJ once so it can recover the library";
    const carriers = sourceFiles(SRC).filter((f) => readFileSync(f, "utf8").includes(phrase));
    expect(carriers.map((f) => f.slice(SRC.length + 1))).toEqual(["errors.ts"]);
  });

  it("carries the structured error through an exception, not just its message", () => {
    // openQueryConnection runs inside the forked worker, where a return
    // value has nowhere to go, so it throws -- but the error code has to
    // survive that, or the parent is left re-deriving it from the disk.
    const e = new EngineErrorException(libraryNeedsRecovery());
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe(LIBRARY_NEEDS_RECOVERY_MESSAGE);
    expect(e.engineError.error).toBe("library_needs_recovery");
    expect(isEngineError(e.engineError)).toBe(true);
    // Must survive the JSON round trip the IPC boundary puts it through.
    expect(JSON.parse(JSON.stringify(e.engineError))).toEqual(libraryNeedsRecovery());
  });
});
