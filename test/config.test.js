import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepMerge, loadConfig, apiUrl } from "../lib/config.js";

test("deepMerge remplace les feuilles et garde le reste", () => {
  const merged = deepMerge(
    { tiers: { fast: { model: "a", use: "x" }, code: { model: "b" } }, n: 1 },
    { tiers: { fast: { model: "z" } } },
  );
  assert.deepEqual(merged, { tiers: { fast: { model: "z", use: "x" }, code: { model: "b" } }, n: 1 });
});

test("deepMerge ne modifie pas ses entrées", () => {
  const base = { a: { b: 1 } };
  deepMerge(base, { a: { b: 2 } });
  assert.deepEqual(base, { a: { b: 1 } });
});

test("deepMerge ignore les clés dangereuses (pollution de prototype)", () => {
  const over = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}');
  const merged = deepMerge({ a: 1 }, over);
  assert.equal({}.polluted, undefined);
  assert.equal(merged.polluted, undefined);
});

test("loadConfig applique models.local.json par-dessus models.json, avec des valeurs par défaut", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
      tiers: { fast: { model: "a", use: "u" } }, daily_budget_usd: 3,
    }));
    assert.equal(loadConfig(dir).tiers.fast.model, "a");
    fs.writeFileSync(path.join(dir, "models.local.json"), JSON.stringify({ tiers: { fast: { model: "local" } } }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.tiers.fast.model, "local");
    assert.equal(cfg.tiers.fast.use, "u");
    assert.equal(cfg.reserve_usd_per_job, 0.05);
    assert.equal(cfg.fallback_cost_usd, 0.01);
    assert.equal(cfg.request_timeout_ms, 120000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("apiUrl pointe sur OpenRouter, et n'accepte une surcharge que sur la boucle locale", () => {
  assert.equal(apiUrl(undefined), "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(apiUrl("http://127.0.0.1:4567"), "http://127.0.0.1:4567/api/v1/chat/completions");
  assert.throws(() => apiUrl("https://evil.example"), /loopback/);
  assert.throws(() => apiUrl("http://127.0.0.1.evil.example"), /loopback/);
});
