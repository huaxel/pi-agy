import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetPreflightCache } from "../extensions/lib/preflight.js";

export async function withFakeAgy<T>(
  output: string,
  fn: (bin: string) => Promise<T>,
  failures = 0,
  delayMs = 0,
  failureOutput = "",
  failureConversationId = "",
  usageOutput = "{}",
  hangAfterOutputMs = 0,
): Promise<T> {
  const delaySeconds = (delayMs / 1000).toFixed(3);
  const hangSeconds = (hangAfterOutputMs / 1000).toFixed(3);
  const failureEncoded = Buffer.from(failureOutput).toString("base64");
  const usageEncoded = Buffer.from(usageOutput).toString("base64");
  const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-bin-"));
  const encoded = Buffer.from(output).toString("base64");
  await writeFile(
    path.join(bin, "agy"),
    `#!/usr/bin/env bash
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
count_file="$dir/invocations"
n=$(cat "$count_file" 2>/dev/null || echo 0)
echo $((n + 1)) > "$count_file"
printf '%s\\n' "$@" > "$dir/args-$n"
case "$1" in
  --version) echo "agy 1.2.0" ;;
  --output-format)
    printf '%s' '${usageEncoded}' | base64 --decode
    echo
    ;;
  models)
    echo "fake-model"
    echo "gemini-9.9-flash-medium is deprecated, use the latest" >&2
    ;;
  *)
    if [ "${delayMs}" -gt 0 ]; then sleep "${delaySeconds}"; fi
    print_count_file="$dir/print-invocations"
    p=$(cat "$print_count_file" 2>/dev/null || echo 0)
    echo $((p + 1)) > "$print_count_file"
    if [ "$p" -lt ${failures} ]; then
      printf '%s\\n' '{"event":"init","conversation_id":"${failureConversationId}","init":{"model":"fake"}}'
      if [ -n '${failureEncoded}' ]; then
        printf '%s' '${failureEncoded}' | base64 --decode
      fi
      echo "rate limit exceeded, retry later" >&2
      exit 1
    fi
    printf '%s\\n' '{"event":"init","init":{"model":"fake"}}'
    printf '%s' '${encoded}' | base64 --decode
    if [ "${hangAfterOutputMs}" -gt 0 ]; then sleep "${hangSeconds}"; fi
    ;;
esac
`,
  );
  await chmod(path.join(bin, "agy"), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await fn(bin);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    resetPreflightCache();
  }
}

/** Read the argv recordings left by the fake agy binary, in invocation order. */
export async function readFakeAgyArgs(bin: string): Promise<string[][]> {
  const files = (await readdir(bin)).filter((name) => name.startsWith("args-")).sort();
  const contents = await Promise.all(files.map((name) => readFile(path.join(bin, name), "utf8")));
  return contents.map((content) => content.split("\n").filter(Boolean));
}

export function hasFlagPair(argv: string[], flag: string, value: string): boolean {
  const index = argv.indexOf(flag);
  return index !== -1 && argv[index + 1] === value;
}

