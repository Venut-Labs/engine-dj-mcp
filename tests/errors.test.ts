import { describe, it, expect } from "vitest";
import { err, isEngineError } from "../src/errors.js";

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
