import { readFile, stat as statFile } from "node:fs/promises";
import * as path from "node:path";

import {
  checkAgyUsage,
  inspectAgyModels,
  inspectAgyVersion,
  isAgyModel,
  isAgyQuotaExhausted,
  type AgyUsageSnapshot,
} from "./cli.js";
import { getDefaultConfigPath } from "./config.js";
import { canonicalDir, getDirLockPath } from "./lock.js";
import { getDefaultStorePath, getHistory } from "./sessions.js";
import { detectVerifyCommand } from "./verify.js";

export type AgyDoctorStatus = "ok" | "info" | "warn" | "error";

export interface AgyDoctorCheck {
  name: string;
  status: AgyDoctorStatus;
  detail: string;
}

export interface AgyDoctorReport {
  cwd: string;
  checks: AgyDoctorCheck[];
  text: string;
  status: "ok" | "warn" | "error";
}

const DOCTOR_TIMEOUT_MS = 10_000;

/** Inspect agy and local extension state without starting a model turn. */
export async function runAgyDoctor(
  cwd: string,
  signal?: AbortSignal,
): Promise<AgyDoctorReport> {
  const resolvedCwd = path.resolve(cwd);
  const checks: AgyDoctorCheck[] = [];

  throwIfCancelled(signal);
  let cliAvailable = false;
  try {
    const version = await inspectAgyVersion(resolvedCwd, signal, DOCTOR_TIMEOUT_MS);
    checks.push({
      name: "CLI",
      status: "ok",
      detail: version ? `agy ${version.replace(/^agy\s*/i, "")}` : "agy responded",
    });
    cliAvailable = true;
  } catch (error) {
    throwIfCancelled(signal);
    checks.push({ name: "CLI", status: "error", detail: errorMessage(error) });
  }

  if (cliAvailable) {
    const [modelsResult, usageResult] = await Promise.allSettled([
      inspectAgyModels(resolvedCwd, signal, DOCTOR_TIMEOUT_MS),
      checkAgyUsage(resolvedCwd, signal, DOCTOR_TIMEOUT_MS),
    ]);

    throwIfCancelled(signal);
    if (modelsResult.status === "fulfilled") {
      const entries = Object.entries(modelsResult.value);
      checks.push({
        name: "Models",
        status: entries.length ? "ok" : "warn",
        detail: entries.length
          ? `${entries.length} aliases discovered (${entries.map(([alias]) => alias).join(", ")})`
          : "agy models returned no supported stable model aliases",
      });
    } else {
      checks.push({ name: "Models", status: "error", detail: errorMessage(modelsResult.reason) });
    }

    if (usageResult.status === "fulfilled") {
      checks.push(quotaCheck(usageResult.value));
    } else {
      checks.push({ name: "Quota", status: "warn", detail: errorMessage(usageResult.reason) });
    }
  } else {
    checks.push({ name: "Models", status: "info", detail: "skipped because the CLI check failed" });
    checks.push({ name: "Quota", status: "info", detail: "skipped because the CLI check failed" });
  }

  checks.push(await configCheck(signal));
  throwIfCancelled(signal);
  checks.push(await sessionsCheck(resolvedCwd, signal));
  throwIfCancelled(signal);
  checks.push(await lockCheck(resolvedCwd));
  throwIfCancelled(signal);

  try {
    const verify = await detectVerifyCommand(resolvedCwd);
    checks.push({
      name: "Verify",
      status: verify ? "ok" : "info",
      detail: verify ?? "no supported repository gate detected",
    });
  } catch (error) {
    checks.push({ name: "Verify", status: "warn", detail: errorMessage(error) });
  }

  const status = checks.some((check) => check.status === "error")
    ? "error"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "ok";
  return {
    cwd: resolvedCwd,
    checks,
    status,
    text: formatAgyDoctorReport(resolvedCwd, checks),
  };
}

export function formatAgyDoctorReport(cwd: string, checks: AgyDoctorCheck[]): string {
  const icon: Record<AgyDoctorStatus, string> = {
    ok: "✓",
    info: "•",
    warn: "!",
    error: "✗",
  };
  return [
    `agy doctor — ${cwd}`,
    ...checks.map((check) => `${icon[check.status]} ${check.name}: ${check.detail}`),
  ].join("\n");
}

function quotaCheck(snapshot: AgyUsageSnapshot | undefined): AgyDoctorCheck {
  if (!snapshot) {
    return { name: "Quota", status: "warn", detail: "usage information is unavailable" };
  }
  if (snapshot.error) {
    return { name: "Quota", status: "warn", detail: snapshot.error };
  }
  if (snapshot.models.length === 0) {
    return {
      name: "Quota",
      status: "warn",
      detail: snapshot.raw_summary
        ? "usage command responded but no quota records were recognized"
        : "usage command returned no quota records",
    };
  }
  const groups = new Set(snapshot.models.map((entry) => entry.model));
  const exhausted = snapshot.models.filter((entry) => isAgyQuotaExhausted(entry));
  if (exhausted.length) {
    const exhaustedGroups = new Set(exhausted.map((entry) => entry.model));
    const affected = exhausted
      .map((entry) => {
        const window = entry.window ? ` ${entry.window}` : "";
        const reset = entry.reset_at ? `; resets ${entry.reset_at}` : "";
        return `${entry.model}${window}${reset}`;
      })
      .join(", ");
    return {
      name: "Quota",
      status: exhaustedGroups.size === groups.size ? "error" : "warn",
      detail: `exhausted: ${affected}`,
    };
  }
  return {
    name: "Quota",
    status: "ok",
    detail: `${snapshot.models.length} windows across ${groups.size} model groups`,
  };
}

async function configCheck(signal?: AbortSignal): Promise<AgyDoctorCheck> {
  const configPath = getDefaultConfigPath();
  try {
    const raw = await readFile(configPath, { encoding: "utf8", signal });
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { name: "Config", status: "warn", detail: `${configPath} is not a JSON object` };
    }
    const record = parsed as Record<string, unknown>;
    const invalid: string[] = [];
    const rawModel = record.defaultModel;
    const validModel =
      typeof rawModel === "string" &&
      (rawModel === "flash" || rawModel === "pro" || isAgyModel(rawModel));
    if ("defaultModel" in record && typeof rawModel !== "string") {
      invalid.push("defaultModel must be a string");
    } else if (typeof rawModel === "string" && !validModel) {
      invalid.push(`unknown defaultModel '${rawModel}'`);
    }
    if (
      "defaultModelCommand" in record &&
      typeof record.defaultModelCommand !== "string"
    ) {
      invalid.push("defaultModelCommand must be a string");
    }
    if ("quotaBalancing" in record && typeof record.quotaBalancing !== "boolean") {
      invalid.push("quotaBalancing must be boolean");
    }
    if ("skipPermissions" in record && typeof record.skipPermissions !== "boolean") {
      invalid.push("skipPermissions must be boolean (fails closed)");
    }
    const model = validModel
      ? rawModel
      : typeof record.defaultModelCommand === "string" && record.defaultModelCommand.trim()
        ? "command"
        : record.quotaBalancing === true
          ? "quota-balanced"
          : "built-in";
    const permissions =
      record.skipPermissions === false ||
      ("skipPermissions" in record && typeof record.skipPermissions !== "boolean")
        ? "permission bypass off"
        : "permission bypass on";
    return {
      name: "Config",
      status: invalid.length ? "warn" : "ok",
      detail: invalid.length
        ? `${configPath} · ${invalid.join("; ")}`
        : `${configPath} · default ${model} · ${permissions}`,
    };
  } catch (error) {
    throwIfCancelled(signal);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { name: "Config", status: "info", detail: `defaults (${configPath} not present)` };
    }
    if (error instanceof SyntaxError) {
      return { name: "Config", status: "warn", detail: `${configPath} contains invalid JSON` };
    }
    return { name: "Config", status: "warn", detail: errorMessage(error) };
  }
}

async function sessionsCheck(cwd: string, signal?: AbortSignal): Promise<AgyDoctorCheck> {
  const storePath = getDefaultStorePath();
  try {
    const parsed: unknown = JSON.parse(
      await readFile(storePath, { encoding: "utf8", signal }),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { name: "Sessions", status: "warn", detail: `${storePath} has an invalid shape` };
    }
    const history = await getHistory(cwd);
    return {
      name: "Sessions",
      status: "ok",
      detail: `${history.length} recorded for this workspace · ${storePath}`,
    };
  } catch (error) {
    throwIfCancelled(signal);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { name: "Sessions", status: "info", detail: `none recorded (${storePath} not present)` };
    }
    if (error instanceof SyntaxError) {
      return { name: "Sessions", status: "warn", detail: `${storePath} contains invalid JSON` };
    }
    return { name: "Sessions", status: "warn", detail: errorMessage(error) };
  }
}

async function lockCheck(cwd: string): Promise<AgyDoctorCheck> {
  const canonical = await canonicalDir(cwd);
  const lockPath = getDirLockPath(canonical);
  try {
    const lock = await statFile(lockPath);
    const ageSeconds = Math.max(0, Math.round((Date.now() - lock.mtimeMs) / 1_000));
    return {
      name: "Workspace lock",
      status: "warn",
      detail:
        ageSeconds > 30
          ? `stale (${ageSeconds}s old; auto-recovers on next run) · ${lockPath}`
          : `active (${ageSeconds}s old) · ${lockPath}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { name: "Workspace lock", status: "ok", detail: "free" };
    }
    return { name: "Workspace lock", status: "warn", detail: errorMessage(error) };
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("agy doctor was cancelled");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
