import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGuard } from "../lib/guard.js";

let tmp;
let root;
let guard;
let wt;
let wtGuard;

const touch = (rel) => fs.writeFileSync(path.join(root, rel), "x");

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-")));
  root = path.join(tmp, "repo");
  for (const d of ["src", "tests", "docs", ".git/hooks", ".claude", ".github/workflows", "secrets"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of [
    ".env", ".env.example", ".ENV", "CLAUDE.md", "package.json", "docs/plan.md", "docs/PLAN.md",
    "docs/notes.md", ".git/config", ".claude/settings.json", "secrets/token.txt", "cert.pem",
    "private.key", "id_rsa", "src/mod.js", "src/environment.js", "tests/test_repo_hygiene.py",
  ]) touch(f);
  fs.writeFileSync(path.join(tmp, "outside.txt"), "x");
  fs.mkdirSync(path.join(tmp, "outside-dir"));
  fs.symlinkSync(path.join(tmp, "outside.txt"), path.join(root, "notes.txt"));
  fs.symlinkSync(path.join(root, ".env"), path.join(root, "alias.txt"));
  fs.symlinkSync(path.join(root, "CLAUDE.md"), path.join(root, "tests", "link.md"));
  fs.symlinkSync(path.join(tmp, "does-not-exist"), path.join(root, "tests", "dangling.md"));
  fs.symlinkSync(path.join(tmp, "outside-dir"), path.join(root, "src", "linkdir"));
  guard = makeGuard({
    cwd: root,
    deny: [".claude", "docs/plan.md", "secrets"],
    writeRoots: ["src", "tests", "docs"],
    writeDeny: ["tests/test_repo_hygiene.py"],
  });

  // A git worktree stored under .claude/worktrees, with its own copy of the sensitive files.
  wt = path.join(root, ".claude", "worktrees", "agent-1");
  for (const d of ["src", "tests", "docs", ".claude"]) fs.mkdirSync(path.join(wt, d), { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../../../.git/worktrees/agent-1\n");
  for (const f of [
    ".env", "CLAUDE.md", "docs/plan.md", "docs/notes.md", ".claude/settings.json", "src/mod.js",
    "tests/test_repo_hygiene.py",
  ]) fs.writeFileSync(path.join(wt, f), "x");
  fs.symlinkSync(path.join(root, "docs", "plan.md"), path.join(wt, "src", "to_main_plan.md"));
  const plain = path.join(root, ".claude", "worktrees", "plain");
  fs.mkdirSync(path.join(plain, "src"), { recursive: true }); // not a worktree: no .git at all
  fs.writeFileSync(path.join(plain, "src", "mod.js"), "x");
  const fake = path.join(root, ".claude", "worktrees", "fake");
  fs.mkdirSync(path.join(fake, ".git"), { recursive: true }); // a .git folder, not a gitfile
  fs.mkdirSync(path.join(fake, "src"));
  fs.writeFileSync(path.join(fake, "src", "mod.js"), "x");
  const inner = path.join(wt, ".claude", "worktrees", "inner");
  fs.mkdirSync(path.join(inner, "src"), { recursive: true });
  fs.writeFileSync(path.join(inner, ".git"), "gitdir: x\n");
  fs.writeFileSync(path.join(inner, "src", "mod.js"), "x");
  wtGuard = makeGuard({
    cwd: root,
    deny: [".claude", "docs/plan.md", "secrets"],
    writeRoots: ["src", "tests", "docs"],
    writeDeny: ["tests/test_repo_hygiene.py"],
    worktreeDirs: [".claude/worktrees"],
  });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SENSITIVE_READS = [
  ".env", ".env.example", ".ENV", "./src/../.env", "alias.txt", "docs/plan.md", "docs/PLAN.md",
  ".git/config", ".claude/settings.json", "secrets/token.txt", "cert.pem", "private.key", "id_rsa",
  "../outside.txt", "notes.txt",
];

for (const p of SENSITIVE_READS) {
  test(`refuse de lire ${p}`, () => {
    assert.throws(() => guard.checkRead(p), /refused/);
  });
}

test("refuse un chemin absolu vers .env", () => {
  assert.throws(() => guard.checkRead(path.join(root, ".env")), /refused/);
});

for (const p of ["src/mod.js", "src/environment.js", "package.json", "docs/notes.md"]) {
  test(`autorise la lecture de ${p}`, () => {
    assert.equal(guard.checkRead(p), path.join(root, p));
  });
}

const FORBIDDEN_WRITES = [
  "CLAUDE.md", ".mcp.json", ".github/workflows/ci.yml", ".git/hooks/pre-commit",
  ".claude/settings.json", ".env", "package.json", "config/risk.yaml", "docs/plan.md",
  "tests/test_repo_hygiene.py", "src/../CLAUDE.md", "../outside.txt", "src", "tests/link.md",
  "tests/dangling.md", "src/linkdir/x.js",
];

for (const p of FORBIDDEN_WRITES) {
  test(`refuse d'écrire ${p}`, () => {
    assert.throws(() => guard.checkWrite(p), /refused/);
  });
}

for (const p of ["src/new_module.js", "src/deep/er/module.js", "tests/test_new.js", "docs/notes.md"]) {
  test(`autorise l'écriture de ${p}`, () => {
    assert.equal(guard.checkWrite(p), path.join(root, p));
  });
}

test("l'écriture est désactivée tant que WRITE_ROOTS est vide", () => {
  const strict = makeGuard({ cwd: root });
  assert.throws(() => strict.checkWrite("src/new_module.js"), /WORKERS_WRITE_ROOTS/);
});

test("refuse les chemins vides, non textuels ou contenant NUL", () => {
  for (const bad of ["", undefined, null, 5, "src/a\0b.js"]) {
    assert.throws(() => guard.checkRead(bad));
    assert.throws(() => guard.checkWrite(bad));
  }
});

test("les racines supplémentaires sont lisibles mais jamais inscriptibles", () => {
  const extra = path.join(tmp, "outside-dir");
  fs.writeFileSync(path.join(extra, "ref.md"), "x");
  const g = makeGuard({ cwd: root, extraRoots: [extra], writeRoots: ["src"] });
  assert.equal(g.checkRead(path.join(extra, "ref.md")), path.join(extra, "ref.md"));
  assert.throws(() => g.checkWrite(path.join(extra, "new.md")), /refused/);
});

// --- worktrees stored under a denied folder (WORKERS_WORKTREE_DIRS) ---

test("sans worktreeDirs, un worktree reste protégé par .claude", () => {
  assert.throws(() => guard.checkRead(path.join(wt, "src", "mod.js")), /refused/);
  assert.throws(() => guard.checkWrite(path.join(wt, "src", "new.js")), /refused/);
});

for (const p of ["src/mod.js", "docs/notes.md"]) {
  test(`worktree : autorise la lecture de ${p}`, () => {
    assert.equal(wtGuard.checkRead(path.join(wt, p)), path.join(wt, p));
  });
}

test("worktree : un chemin relatif à la racine du serveur est jugé de la même façon", () => {
  assert.equal(wtGuard.checkRead(".claude/worktrees/agent-1/src/mod.js"), path.join(wt, "src", "mod.js"));
});

const WORKTREE_SENSITIVE_READS = [
  ".env", "docs/plan.md", ".claude/settings.json", ".git", "src/to_main_plan.md", "../../settings.json",
  "../plain/src/mod.js", "../fake/src/mod.js", ".claude/worktrees/inner/src/mod.js",
];

for (const p of WORKTREE_SENSITIVE_READS) {
  test(`worktree : refuse de lire ${p}`, () => {
    assert.throws(() => wtGuard.checkRead(path.join(wt, p)), /refused/);
  });
}

for (const p of ["src/new.js", "tests/test_new.js", "docs/notes.md"]) {
  test(`worktree : autorise l'écriture de ${p}`, () => {
    assert.equal(wtGuard.checkWrite(path.join(wt, p)), path.join(wt, p));
  });
}

const WORKTREE_FORBIDDEN_WRITES = [
  "CLAUDE.md", "docs/plan.md", "tests/test_repo_hygiene.py", ".claude/hooks/guard.py", ".git",
  "src/to_main_plan.md", "../../settings.json", "../plain/src/new.js", "../fake/src/new.js",
  ".claude/worktrees/inner/src/new.js", ".",
];

for (const p of WORKTREE_FORBIDDEN_WRITES) {
  test(`worktree : refuse d'écrire ${p}`, () => {
    assert.throws(() => wtGuard.checkWrite(path.join(wt, p)), /refused/);
  });
}

test("worktree : les règles du dépôt principal ne changent pas", () => {
  assert.throws(() => wtGuard.checkRead(".claude/settings.json"), /refused/);
  assert.throws(() => wtGuard.checkRead("docs/plan.md"), /refused/);
  assert.throws(() => wtGuard.checkWrite("CLAUDE.md"), /refused/);
  assert.equal(wtGuard.checkWrite("src/new_module.js"), path.join(root, "src", "new_module.js"));
});

test("worktree : le dossier des worktrees doit rester dans la racine du projet", () => {
  assert.throws(() => makeGuard({ cwd: root, worktreeDirs: ["../outside-dir"] }), /inside the project root/);
  assert.throws(() => makeGuard({ cwd: root, worktreeDirs: ["."] }), /inside the project root/);
});
