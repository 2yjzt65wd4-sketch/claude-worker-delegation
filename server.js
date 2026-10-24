// workers-mcp: lets the Claude "architect" delegate bulk work to cheap OpenRouter models.
// The architect passes file paths; this server reads them, so big content never enters Claude's context.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBudget } from "./lib/budget.js";
import { apiUrl, loadConfig } from "./lib/config.js";
import { makeGuard } from "./lib/guard.js";
import { readCompletion, writeOutput } from "./lib/output.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = loadConfig(HERE);
const LOG = process.env.WORKERS_USAGE_LOG || path.join(HERE, "usage.jsonl");
const KEY = process.env.OPENROUTER_API_KEY;
const API_URL = apiUrl(process.env.WORKERS_TEST_BASE_URL);

// Path policy (see lib/guard.js). All lists are ';'-separated.
//  WORKERS_ALLOWED_ROOTS  extra read-only roots besides the session cwd
//  WORKERS_DENY           relative paths refused for read and write (secrets, .env*, .git, keys are always refused)
//  WORKERS_WRITE_ROOTS    folders where write_to may create files; unset = write_to is disabled
//  WORKERS_WRITE_DENY     relative paths refused for write inside the write roots
//  WORKERS_WORKTREE_DIRS  folders (inside the project) holding git worktrees, e.g. ".claude/worktrees": each worktree
//                         is judged against its own root instead of being hidden by a denied parent folder
const list = (value) => (value || "").split(";").filter(Boolean);
const guard = makeGuard({
  cwd: process.cwd(),
  extraRoots: list(process.env.WORKERS_ALLOWED_ROOTS),
  deny: list(process.env.WORKERS_DENY),
  writeRoots: list(process.env.WORKERS_WRITE_ROOTS),
  writeDeny: list(process.env.WORKERS_WRITE_DENY),
  worktreeDirs: list(process.env.WORKERS_WORKTREE_DIRS),
});

const SYSTEM = `You are a worker model taking orders from a senior architect model.
Rules:
- Do exactly the task. No preamble, no closing summary, no restating the task.
- Only rely on file contents actually provided below. Never invent code or file contents you were not shown; say "NOT PROVIDED: <what>" instead.
- For code changes, output a unified diff (--- a/path +++ b/path) unless asked for complete files.
- For summaries, be dense: bullet points, concrete names/lines/numbers.
- If the task is ambiguous or impossible, say so in one line and stop.`;

function readRows() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function spentToday() {
  const day = new Date().toISOString().slice(0, 10);
  return readRows().filter((r) => r.ts.startsWith(day)).reduce((s, r) => s + (r.cost || 0), 0);
}

const budget = createBudget({ limit: CFG.daily_budget_usd, reservePerJob: CFG.reserve_usd_per_job, spentToday });

function readCapped(real) {
  const fd = fs.openSync(real, "r");
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`refused: ${real} is not a regular file`);
    const buf = Buffer.alloc(Math.min(st.size, CFG.max_file_bytes));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString("utf8", 0, n), total: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

function buildPrompt(task, files = []) {
  let body = `TASK:\n${task}\n`;
  for (const f of files) {
    const { text, total } = readCapped(guard.checkRead(f));
    const cut = total > CFG.max_file_bytes ? `\n[...truncated, ${total} bytes total]` : "";
    body += `\n===== FILE: ${f} =====\n${text}${cut}\n===== END FILE =====\n`;
  }
  return body;
}

async function runJob({ task, tier = "fast", files, write_to, max_tokens, overwrite = false }) {
  if (!KEY) throw new Error("OPENROUTER_API_KEY is not set in the environment");
  const t = CFG.tiers[tier];
  if (!t) throw new Error(`unknown tier "${tier}" (have: ${Object.keys(CFG.tiers).join(", ")})`);
  // Everything that can be refused is refused before a paid call is made.
  const prompt = buildPrompt(task, files);
  const outPath = write_to ? guard.checkWrite(write_to) : null;
  if (outPath && !overwrite && fs.existsSync(outPath)) {
    throw new Error(`${write_to} already exists; pass overwrite:true to replace it`);
  }
  const release = budget.reserve();
  try {
    const started = Date.now();
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Title": "claude-workers-mcp" },
      signal: AbortSignal.timeout(CFG.request_timeout_ms),
      body: JSON.stringify({
        model: t.model,
        max_tokens: max_tokens || CFG.default_max_tokens,
        usage: { include: true },
        ...(CFG.provider && { provider: CFG.provider }),
        ...t.params, // per-tier extras, e.g. disabling reasoning on the fast tier
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      }),
    });
    const data = await res.json().catch(() => ({ error: { message: `non-JSON response (HTTP ${res.status})` } }));
    if (!res.ok || data.error) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data.error || data).slice(0, 500)}`);
    const choice = data.choices?.[0];
    const u = data.usage || {};
    const costKnown = typeof u.cost === "number";
    const rec = {
      ts: new Date().toISOString(), tier, model: data.model || t.model,
      in: u.prompt_tokens || 0, out: u.completion_tokens || 0,
      cost: costKnown ? u.cost : CFG.fallback_cost_usd, cost_estimated: !costKnown,
      ms: Date.now() - started,
      // Never the task text itself: it may quote a secret or a private document.
      task_chars: task.length, task_sha256: crypto.createHash("sha256").update(task).digest("hex").slice(0, 12),
    };
    fs.appendFileSync(LOG, JSON.stringify(rec) + "\n", { mode: 0o600 }); // billed, so logged even if the output is unusable
    const meta = `[${tier}/${rec.model} in=${rec.in} out=${rec.out} $${rec.cost.toFixed(5)}${costKnown ? "" : " (estimated)"} ${rec.ms}ms]`;

    const { text, truncated } = readCompletion(choice);
    if (outPath) {
      if (truncated) {
        throw new Error("completion truncated at max_tokens (finish_reason=length): nothing was written. Raise max_tokens or split the task.");
      }
      writeOutput(outPath, text, overwrite);
      const lines = text.split("\n");
      return `${meta}\nwrote ${lines.length} lines to ${outPath}\n--- first 20 lines ---\n${lines.slice(0, 20).join("\n")}`;
    }
    const answer = truncated ? `${text}\n[TRUNCATED: the worker hit max_tokens, the end of its answer is missing]` : text;
    const capped = answer.length > CFG.max_return_chars
      ? answer.slice(0, CFG.max_return_chars) + `\n[...truncated ${answer.length - CFG.max_return_chars} chars; use write_to for full output]`
      : answer;
    return `${meta}\n${capped}`;
  } finally {
    release();
  }
}

const jobShape = {
  task: z.string().describe("Precise instructions for the worker. Include acceptance criteria and output format."),
  tier: z.enum(Object.keys(CFG.tiers)).default("fast").describe(
    Object.entries(CFG.tiers).map(([k, v]) => `${k}: ${v.use}`).join("; ")),
  files: z.array(z.string()).optional().describe("Paths the server loads into the worker prompt — do NOT read them yourself first."),
  write_to: z.string().optional().describe("Save full output here and return only a 20-line preview. Use for anything > ~50 lines. Refused outside the configured write roots, and never replaces an existing file unless overwrite is true."),
  overwrite: z.boolean().optional().describe("Allow write_to to replace an existing file. Default false."),
  max_tokens: z.number().int().positive().optional(),
};

const server = new McpServer({ name: "workers", version: "1.1.0" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });

server.registerTool("delegate", {
  description: "Hand a self-contained subtask to a cheap worker model (OpenRouter). Use for bulk reading/summarizing, boilerplate, tests, mechanical edits as diffs, first drafts, or a second opinion. Review the result before acting on it.",
  inputSchema: jobShape,
}, async (args) => { try { return ok(await runJob(args)); } catch (e) { return fail(e); } });

server.registerTool("delegate_batch", {
  description: "Run several independent worker jobs in parallel. Returns one result block per job.",
  inputSchema: { jobs: z.array(z.object(jobShape)).min(1).max(20) },
}, async ({ jobs }) => {
  const results = new Array(jobs.length);
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const i = next++;
      try { results[i] = `## job ${i + 1}\n` + await runJob(jobs[i]); }
      catch (e) { results[i] = `## job ${i + 1} FAILED\n${e.message || e}`; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CFG.concurrency, jobs.length) }, lane));
  return ok(results.join("\n\n"));
});

server.registerTool("worker_stats", {
  description: "Worker token/cost totals: today and all-time, by tier.",
  inputSchema: {},
}, async () => {
  const rows = readRows();
  if (rows.length === 0) return ok("no worker calls yet");
  const day = new Date().toISOString().slice(0, 10);
  const agg = (rs) => rs.reduce((a, r) => ({ n: a.n + 1, in: a.in + (r.in || 0), out: a.out + (r.out || 0), cost: a.cost + (r.cost || 0) }),
    { n: 0, in: 0, out: 0, cost: 0 });
  const fmt = (a) => `${a.n} calls, ${a.in} in / ${a.out} out tokens, $${a.cost.toFixed(4)}`;
  const tiers = Object.keys(CFG.tiers).map((t) => `  ${t}: ${fmt(agg(rows.filter((r) => r.tier === t)))}`).join("\n");
  return ok(`today: ${fmt(agg(rows.filter((r) => r.ts.startsWith(day))))} (budget $${CFG.daily_budget_usd})\nall-time: ${fmt(agg(rows))}\n${tiers}`);
});

await server.connect(new StdioServerTransport());
