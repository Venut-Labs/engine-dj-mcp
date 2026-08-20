// src/tools/refresh.ts
import type { IndexManager } from "../store/index-manager.js";
import type { EngineError } from "../errors.js";

export async function refreshIndex(
  mgr: IndexManager,
): Promise<{ rebuilt: boolean; indexed: number | null; elapsed_ms: number; generation: number } | EngineError> {
  return mgr.ensureFresh();
}
