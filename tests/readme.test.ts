// tests/readme.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

describe("README", () => {
  it("pins the configuration that grants write access to the version being released", () => {
    // Unpinned, `npx -y engine-dj-mcp` fetches whatever is newest at every
    // launch, and this configuration hands that code write access to a DJ's
    // library. The example pins a version, and a pinned number is only useful
    // while it is the current one -- this test is what keeps it from drifting
    // one release behind without anybody noticing.
    const writes = readme
      .split("\n")
      .filter((line) => line.includes("--allow-writes") && line.includes('"args"'));
    expect(writes.length, "the --allow-writes configuration example").toBeGreaterThan(0);
    for (const line of writes) {
      expect(line).toContain(`"engine-dj-mcp@${pkg.version}"`);
    }
  });

  it("tells people to quit Engine DJ before a write, not merely that it usually works", () => {
    // Every acceptance check of a write was run with Engine closed; what Engine
    // does with a change made while it is running has never been measured. The
    // previous wording promised the outcome anyway.
    expect(readme).not.toMatch(/write normally succeeds with Engine running/);
    expect(readme).toMatch(/Quit Engine DJ before writing/);
  });

  it("documents update_track_metadata, its own refusals, and what its undo does not restore", () => {
    expect(readme).toMatch(/### `update_track_metadata`/);
    expect(readme).toContain("`track_not_editable`");
    expect(readme).toContain("`stale_value`");
    expect(readme).toMatch(/not to the audio files' tags/);
    expect(readme).toMatch(/not `lastEditTime`/);
    expect(readme).toMatch(/five tools appear/);
    expect(readme).toMatch(/no track, cue or beatgrid is touched by these four/);
  });
});
