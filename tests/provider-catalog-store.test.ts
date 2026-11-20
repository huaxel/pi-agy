import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  clearProviderCatalogCache,
  getProviderCatalogProvenance,
  loadProviderCatalogCache,
  providerCatalogCachePath,
  recordProviderCatalogProvenance,
  saveProviderCatalogCache,
} from "../extensions/lib/provider-catalog-store.js";
import type { AgyProviderModelEntry } from "../extensions/lib/provider-models.js";

const configPathIn = async (): Promise<{ dir: string; configPath: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-catalog-"));
  return {
    dir,
    configPath: path.join(dir, "agy-config.json"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

describe("provider catalog store", () => {
  it("returns nothing before a roster has been observed", async () => {
    const { configPath, cleanup } = await configPathIn();
    try {
      assert.deepEqual(loadProviderCatalogCache(configPath), []);
      // Persisting nothing must never create a fabricated roster.
      saveProviderCatalogCache([], configPath);
      assert.deepEqual(loadProviderCatalogCache(configPath), []);
    } finally {
      await cleanup();
    }
  });

  it("round-trips the roster, including effort tiers", async () => {
    const { configPath, cleanup } = await configPathIn();
    const entries: AgyProviderModelEntry[] = [
      { full: "gemini-9-neon", id: "gemini-9-neon", efforts: ["low", "high"] },
      { full: "gpt-oss-9-9-medium", id: "gpt-oss-9-9-medium" },
    ];
    try {
      saveProviderCatalogCache(entries, configPath);
      assert.deepEqual(loadProviderCatalogCache(configPath), entries);
      assert.equal(providerCatalogCachePath(configPath), path.join(path.dirname(configPath), "agy-provider-models.json"));
    } finally {
      await cleanup();
    }
  });

  it("drops malformed entries instead of trusting them", async () => {
    const { configPath, cleanup } = await configPathIn();
    try {
      await writeFile(
        providerCatalogCachePath(configPath),
        JSON.stringify({
          version: 1,
          models: [
            { full: "ok-model", id: "ok-model", efforts: ["high", "bogus", 7] },
            { full: "", id: "no-full" },
            { full: "no-id" },
            { full: "dup", id: "dup" },
            { full: "dup2", id: "dup" },
            "not-an-object",
          ],
        }),
        "utf8",
      );
      assert.deepEqual(loadProviderCatalogCache(configPath), [
        { full: "ok-model", id: "ok-model", efforts: ["high"] },
        { full: "dup", id: "dup" },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("refuses ids that would become argv flags", async () => {
    const { configPath, cleanup } = await configPathIn();
    try {
      // `full` is passed as `--model <full>`. A writable cache must not be able
      // to smuggle a flag in, which is why it gets the same validation the live
      // `agy models` parser applies.
      await writeFile(
        providerCatalogCachePath(configPath),
        JSON.stringify({
          version: 1,
          models: [
            { full: "--dangerously-skip-permissions", id: "--evil" },
            { full: "--model=/etc/passwd", id: "also-bad" },
            { full: "has whitespace", id: "spacey" },
            { full: "ok-model", id: "ok-model" },
          ],
        }),
        "utf8",
      );
      assert.deepEqual(loadProviderCatalogCache(configPath), [
        { full: "ok-model", id: "ok-model" },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("treats a corrupt cache as absent", async () => {
    const { configPath, cleanup } = await configPathIn();
    try {
      await writeFile(providerCatalogCachePath(configPath), "{ not json", "utf8");
      assert.deepEqual(loadProviderCatalogCache(configPath), []);
      clearProviderCatalogCache(configPath);
      assert.deepEqual(loadProviderCatalogCache(configPath), []);
    } finally {
      await cleanup();
    }
  });

  it("reports only the roster the provider records, not incidental cache reads", async () => {
    const { configPath, cleanup } = await configPathIn();
    const entries: AgyProviderModelEntry[] = [{ full: "gemini-9-neon", id: "gemini-9-neon" }];
    try {
      recordProviderCatalogProvenance("cache", 0);
      assert.deepEqual(getProviderCatalogProvenance(configPath), { source: "empty", count: 0 });
      recordProviderCatalogProvenance("live", entries.length);
      // A failed discovery elsewhere (the bridge) reads the cache as a fallback;
      // that must not relabel the live roster the provider is serving.
      saveProviderCatalogCache(entries, configPath);
      loadProviderCatalogCache(configPath);
      clearProviderCatalogCache(configPath);
      loadProviderCatalogCache(configPath);
      const live = getProviderCatalogProvenance(configPath);
      assert.equal(live.source, "live");
      assert.equal(live.count, entries.length);
      assert.ok((live.ageMs ?? -1) >= 0);
      recordProviderCatalogProvenance("cache", entries.length);
      assert.equal(getProviderCatalogProvenance(configPath).source, "cache");
    } finally {
      recordProviderCatalogProvenance("cache", 0);
      await cleanup();
    }
  });
});
