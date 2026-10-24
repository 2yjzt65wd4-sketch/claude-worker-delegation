import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGuard } from "../lib/guard.js";

let tmp;
let root;
let guard;

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
