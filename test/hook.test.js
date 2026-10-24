import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "delegate-large-reads.cjs");
let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-"));
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(60 * 1024));
  fs.writeFileSync(path.join(dir, "small.txt"), "x");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8" });

test("le hook démarre : un module CommonJS, pas un module ES", () => {
  const result = run({ tool_name: "Read", tool_input: { file_path: path.join(dir, "small.txt") } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("le hook refuse la lecture entière d'un gros fichier", () => {
  const result = run({ tool_name: "Read", tool_input: { file_path: path.join(dir, "big.txt") } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("le hook laisse passer une lecture bornée", () => {
  const result = run({ tool_name: "Read", tool_input: { file_path: path.join(dir, "big.txt"), limit: 50 } });
  assert.equal(result.stdout, "");
});

test("le hook refuse cat sur un gros fichier", () => {
  const result = run({ tool_name: "Bash", cwd: dir, tool_input: { command: "cat big.txt" } });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
