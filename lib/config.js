import fs from "node:fs";
import path from "node:path";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const DEFAULTS = {
  reserve_usd_per_job: 0.05, // held against the daily budget while a job is in flight
  fallback_cost_usd: 0.01, // charged when OpenRouter reports no cost
  request_timeout_ms: 120000, // the whole request
  stream_idle_timeout_ms: 600000, // silence between two reads of a streamed reply, keep-alive comments included
};

export function deepMerge(base, over) {
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = Object.hasOwn(base, key) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * models.json, overridden key by key by an optional, untracked models.local.json.
 * `useLocal: false` ignores that file, so tests do not depend on the machine they run on.
 */
export function loadConfig(dir, { useLocal = true } = {}) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const local = path.join(dir, "models.local.json");
  const merged = useLocal && fs.existsSync(local) ? deepMerge(read("models.json"), read("models.local.json")) : read("models.json");
  return { ...DEFAULTS, ...merged };
}

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/** OpenRouter, unless a test points the server at a loopback fake. Never anywhere else. */
export function apiUrl(override) {
  if (!override) return OPENROUTER;
  const url = new URL(override);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("WORKERS_TEST_BASE_URL must point to loopback (127.0.0.1 or localhost)");
  }
  return `${url.origin}/api/v1/chat/completions`;
}
