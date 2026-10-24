import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const SECOND = { timeout: 30000 };

async function startFakeApi() {
  const requests = [];
  const state = { reply: () => ({ content: "ok", finish_reason: "stop", cost: 0.001 }) };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      requests.push(JSON.parse(raw));
      const { content, finish_reason, cost } = state.reply(requests.at(-1));
      await new Promise((r) => setTimeout(r, 30));
      const usage = { prompt_tokens: 10, completion_tokens: 5, ...(cost === undefined ? {} : { cost }), ...state.usageExtra };
      if (state.sse) {
        // comme OpenRouter : commentaire de maintien, contenu en morceaux, chunk d'usage, puis [DONE]
        const chunk = (obj) => `data: ${JSON.stringify({ model: "fake/model", ...obj })}\n\n`;
        const half = Math.ceil(content.length / 2);
        res.setHeader("content-type", "text/event-stream");
        res.write(": OPENROUTER PROCESSING\n\n");
        for (const piece of [content.slice(0, half), content.slice(half)]) {
          res.write(chunk({ choices: [{ delta: { content: piece }, finish_reason: null }] }));
        }
        res.write(chunk({ choices: [{ delta: { content: "" }, finish_reason }], usage }));
        res.end("data: [DONE]\n\n");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "fake/model", choices: [{ message: { content }, finish_reason }], usage }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests, state, port: server.address().port,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

async function startServer({ spent = 0, worktree = false } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "srv-")));
  const project = path.join(tmp, "repo");
  for (const d of ["src", "docs"]) fs.mkdirSync(path.join(project, d), { recursive: true });
  fs.writeFileSync(path.join(project, ".env"), "SECRET-CONTENT-123");
  fs.writeFileSync(path.join(project, "docs", "plan.md"), "PLAN-CONTENT-456");
  fs.writeFileSync(path.join(project, "src", "a.js"), "export const a = 1;\n");
  if (worktree) {
    // a git worktree under .claude, which is on the deny list, with its own copy of the plan
    const wt = path.join(project, ".claude", "worktrees", "agent-1");
    for (const d of ["src", "docs"]) fs.mkdirSync(path.join(wt, d), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: x\n");
    fs.writeFileSync(path.join(wt, "src", "a.js"), "export const a = 1;\n");
    fs.writeFileSync(path.join(wt, "docs", "plan.md"), "PLAN-CONTENT-456");
    fs.writeFileSync(path.join(project, ".claude", "settings.json"), "{}");
  }
  const usageLog = path.join(tmp, "usage.jsonl");
  if (spent) fs.writeFileSync(usageLog, JSON.stringify({ ts: new Date().toISOString(), tier: "fast", cost: spent }) + "\n");
  const api = await startFakeApi();
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: project,
    env: {
      OPENROUTER_API_KEY: "test-key",
      WORKERS_IGNORE_LOCAL_CONFIG: "1", // le résultat ne doit pas dépendre du models.local.json de la machine
      WORKERS_TEST_BASE_URL: `http://127.0.0.1:${api.port}`,
      WORKERS_WRITE_ROOTS: "src;tests",
      WORKERS_DENY: "docs/plan.md",
      WORKERS_USAGE_LOG: usageLog,
      ...(worktree && { WORKERS_DENY: ".claude;docs/plan.md", WORKERS_WORKTREE_DIRS: ".claude/worktrees" }),
    },
  }));
  return {
    project, api,
    call: async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return { error: Boolean(r.isError), text: r.content[0].text };
    },
    usage: () => (fs.existsSync(usageLog) ? fs.readFileSync(usageLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    read: (rel) => fs.readFileSync(path.join(project, rel), "utf8"),
    exists: (rel) => fs.existsSync(path.join(project, rel)),
    close: async () => { await client.close(); await api.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

test("refuse .env et le plan sans jamais appeler l'API", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  for (const file of [".env", "docs/plan.md"]) {
    const r = await s.call("delegate", { task: "résume", files: [file] });
    assert.equal(r.error, true);
    assert.match(r.text, /refused/);
  }
  assert.equal(s.api.requests.length, 0);
});

test("un worktree rangé sous un dossier refusé est jugé par rapport à sa propre racine", SECOND, async (t) => {
  const s = await startServer({ worktree: true });
  t.after(() => s.close());
  const wt = path.join(s.project, ".claude", "worktrees", "agent-1");
  const ok = await s.call("delegate", {
    task: "résume", files: [path.join(wt, "src", "a.js")], write_to: path.join(wt, "src", "out.js"),
  });
  assert.equal(ok.error, false, ok.text);
  assert.ok(fs.existsSync(path.join(wt, "src", "out.js")));
  for (const file of [path.join(wt, "docs", "plan.md"), path.join(s.project, ".claude", "settings.json")]) {
    const r = await s.call("delegate", { task: "résume", files: [file] });
    assert.equal(r.error, true, file);
    assert.match(r.text, /refused/, file);
  }
  assert.equal(s.api.requests.length, 1);
});

test("refuse write_to hors des dossiers autorisés", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  for (const target of ["CLAUDE.md", ".github/workflows/ci.yml", "docs/notes.md", "src/../.env"]) {
    const r = await s.call("delegate", { task: "écris", write_to: target });
    assert.equal(r.error, true, target);
    assert.match(r.text, /refused/, target);
  }
  assert.equal(s.api.requests.length, 0);
});

test("écrit une sortie complète, sans jamais journaliser le texte de la tâche", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.api.state.reply = () => ({ content: "export const b = 2;\n", finish_reason: "stop", cost: 0.002 });
  const r = await s.call("delegate", { task: "écris b, mot de passe : hunter2", files: ["src/a.js"], write_to: "src/b.js" });
  assert.equal(r.error, false, r.text);
  assert.equal(s.read("src/b.js"), "export const b = 2;\n");
  assert.match(JSON.stringify(s.api.requests[0].messages), /export const a = 1;/);
  const [line] = s.usage();
  assert.equal(line.cost, 0.002);
  assert.equal(line.task, undefined);
  assert.equal(line.task_chars, "écris b, mot de passe : hunter2".length);
  assert.match(line.task_sha256, /^[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(line), /hunter2/);
});

test("n'écrase un fichier existant que sur demande, et refuse avant de payer", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.api.state.reply = () => ({ content: "nouveau\n", finish_reason: "stop", cost: 0.001 });
  const refused = await s.call("delegate", { task: "t", write_to: "src/a.js" });
  assert.equal(refused.error, true);
  assert.match(refused.text, /already exists/);
  assert.equal(s.read("src/a.js"), "export const a = 1;\n");
  assert.equal(s.api.requests.length, 0);
  const replaced = await s.call("delegate", { task: "t", write_to: "src/a.js", overwrite: true });
  assert.equal(replaced.error, false, replaced.text);
  assert.equal(s.read("src/a.js"), "nouveau\n");
});

test("une sortie tronquée ou vide n'est jamais écrite, mais reste facturée au journal", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.api.state.reply = () => ({ content: "def f():\n    ret", finish_reason: "length", cost: 0.001 });
  const truncated = await s.call("delegate", { task: "t", write_to: "src/c.py" });
  assert.equal(truncated.error, true);
  assert.match(truncated.text, /truncated/);
  assert.equal(s.exists("src/c.py"), false);
  s.api.state.reply = () => ({ content: "", finish_reason: "length", cost: 0.001 });
  const empty = await s.call("delegate", { task: "t", write_to: "src/d.py" });
  assert.equal(empty.error, true);
  assert.match(empty.text, /empty completion/);
  assert.equal(s.exists("src/d.py"), false);
  assert.equal(s.usage().length, 2);
});

test("une réponse en flux est assemblée, écrite en entier, et son coût et son raisonnement sont journalisés", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.api.state.sse = true;
  s.api.state.usageExtra = { completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 850 } };
  s.api.state.reply = () => ({ content: "def f():\n    return 1\n", finish_reason: "stop", cost: 0.004 });
  const r = await s.call("delegate", { task: "t", write_to: "src/e.py" });
  assert.equal(r.error, false);
  assert.equal(s.read("src/e.py"), "def f():\n    return 1\n");
  assert.match(r.text, /out=900 \(reasoning 850\)/);
  assert.equal(s.api.requests[0].stream, true);
  const [rec] = s.usage();
  assert.equal(rec.cost, 0.004);
  assert.equal(rec.out, 900);
  assert.equal(rec.reasoning, 850);
});

test("une réponse en flux coupée au plafond est refusée par write_to, comme une réponse ordinaire", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.api.state.sse = true;
  s.api.state.reply = () => ({ content: "def f():\n    ret", finish_reason: "length", cost: 0.001 });
  const r = await s.call("delegate", { task: "t", write_to: "src/f.py" });
  assert.equal(r.error, true);
  assert.match(r.text, /truncated/);
  assert.equal(s.exists("src/f.py"), false);
  assert.equal(s.usage().length, 1);
});

test("une réponse tronquée sans write_to est renvoyée avec un avertissement", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.api.state.reply = () => ({ content: "début de réponse", finish_reason: "length", cost: 0.001 });
  const r = await s.call("delegate", { task: "t" });
  assert.equal(r.error, false);
  assert.match(r.text, /début de réponse/);
  assert.match(r.text, /TRUNCATED/);
});

test("un coût absent est compté au tarif de repli, pas à zéro", SECOND, async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  s.api.state.reply = () => ({ content: "ok", finish_reason: "stop" });
  const r = await s.call("delegate", { task: "t" });
  assert.equal(r.error, false, r.text);
  assert.equal(s.usage()[0].cost, 0.01);
  assert.equal(s.usage()[0].cost_estimated, true);
});

test("un lot parallèle ne dépasse pas le plafond quotidien", SECOND, async (t) => {
  const s = await startServer({ spent: 2.9 });
  t.after(() => s.close());
  const jobs = Array.from({ length: 4 }, (_, i) => ({ task: `tâche ${i}` }));
  const r = await s.call("delegate_batch", { jobs });
  assert.equal(s.api.requests.length, 2);
  assert.equal((r.text.match(/FAILED/g) || []).length, 2);
  assert.match(r.text, /budget/);
});

test("plafond déjà atteint : aucun appel", SECOND, async (t) => {
  const s = await startServer({ spent: 3 });
  t.after(() => s.close());
  const r = await s.call("delegate", { task: "t" });
  assert.equal(r.error, true);
  assert.match(r.text, /budget/);
  assert.equal(s.api.requests.length, 0);
});
