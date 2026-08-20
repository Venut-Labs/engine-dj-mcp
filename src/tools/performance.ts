import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { decodePerformance } from "../blobs/index.js";
import type { QueryProcess } from "../proc/query-client.js";

export const PerformanceInput = z.object({ id: z.number().int().positive() });
export type PerformanceInput = z.input<typeof PerformanceInput>;

function asBuffer(v: unknown): Buffer | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return null;
}

export async function getTrackPerformance(qp: QueryProcess, raw: PerformanceInput) {
  const parsed = PerformanceInput.safeParse(raw);
  if (!parsed.success) return err("invalid_argument", "id must be a positive integer");
  const { id } = parsed.data;

  const res = await qp.run(
    `SELECT quickCues, loops, beatData, overviewWaveFormData
     FROM PerformanceData WHERE trackId = ?`,
    [id],
  );
  if (isEngineError(res)) return res;
  if (!res.rows.length) {
    return err("decode_failed", `No performance data for track ${id}`, {
      detail: "The track may not exist, or Engine has not analysed it yet",
    });
  }

  const row = res.rows[0]!;
  const [quickCues, loops, beatData, overviewWaveFormData] = row;
  return {
    track_id: id,
    ...decodePerformance({
      quickCues: asBuffer(quickCues),
      loops: asBuffer(loops),
      beatData: asBuffer(beatData),
      overviewWaveFormData: asBuffer(overviewWaveFormData),
    }),
  };
}
