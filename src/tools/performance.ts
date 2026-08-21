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

  // Track.length carries the duration the waveform summary reports; the
  // waveform blob's own point spacing is unverified, so a duration derived
  // from its byte count would be a guess dressed as a measurement. LEFT JOIN
  // so a PerformanceData row whose Track is missing still decodes.
  const res = await qp.run(
    `SELECT p.quickCues, p.loops, p.beatData, p.overviewWaveFormData, t.length
     FROM PerformanceData p LEFT JOIN Track t ON t.id = p.trackId
     WHERE p.trackId = ?`,
    [id],
  );
  if (isEngineError(res)) return res;
  if (!res.rows.length) {
    return err("decode_failed", `No performance data for track ${id}`, {
      detail: "The track may not exist, or Engine has not analysed it yet",
    });
  }

  const row = res.rows[0]!;
  const [quickCues, loops, beatData, overviewWaveFormData, length] = row;
  return {
    track_id: id,
    ...decodePerformance({
      quickCues: asBuffer(quickCues),
      loops: asBuffer(loops),
      beatData: asBuffer(beatData),
      overviewWaveFormData: asBuffer(overviewWaveFormData),
      durationSeconds: typeof length === "number" ? length : null,
    }),
  };
}
