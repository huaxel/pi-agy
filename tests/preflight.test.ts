import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { resetPreflightCache, runPreflight } from "../extensions/lib/preflight.js";

/**
 * Fake agy with a stateful `models` probe: sleeps past the 10s preflight
 * cap `slowCalls` times, then answers instantly. Models the cold-start
 * OAuth stampede (first parallel probes time out, retry lands warm).
 */
async function withSlowModelsFake<T>(
  slowCalls: number,
  fn: () => Promise<T>,
): Promise<T> {
  const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-bin-"));
  await writeFile(
    path.join(bin, "agy"),
    `#!/usr/bin/env bash
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  --version) echo "agy 1.2.0" ;;
  models)\n    n=$(cat "$dir/models-count" 2>/dev/null || echo 0)\n    echo $((n + 1)) > "$dir/models-count"\n    if [ "$n" -lt ${slowCalls} ]; then sleep 12; fi\n    printf 'gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)\\n'\n    ;;\n  --output-format)\n    echo '{}'\n    echo\n    ;;\n  *)\n    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'\n    ;;\nesac\n`,
  );
  await chmod(path.join(bin, "agy"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await fn();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

describe("preflight cold-start retry", () => {
  it("retries timed-out health probes once and succeeds warm", async () => {
    await withSlowModelsFake(1, async () => {
      resetPreflightCache();
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-"));
      const started = Date.now();
      const quota = await runPreflight(dir, undefined, 60_000);
      // First models attempt burns the ~10s probe cap; the retry is fast.
      assert.ok(Date.now() - started >= 9_000, "expected the first attempt to time out");
      assert.ok(quota, "expected a quota snapshot");
    });
  });

  it("fails after one retry when probes stay slow", async () => {
    await withSlowModelsFake(10, async () => {
      resetPreflightCache();
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-"));
      await assert.rejects(
        runPreflight(dir, undefined, 60_000),
        /timed out/,
      );
    });
  });
});
