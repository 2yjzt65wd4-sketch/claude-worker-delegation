import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCompletion, writeOutput } from "../lib/output.js";

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "out-")); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const choice = (content, finish_reason = "stop") => ({ message: { content }, finish_reason });

test("readCompletion renvoie le texte d'une réponse complète", () => {
  assert.deepEqual(readCompletion(choice("ok")), { text: "ok", truncated: false });
});

test("readCompletion signale une réponse coupée par max_tokens", () => {
  assert.deepEqual(readCompletion(choice("moitié", "length")), { text: "moitié", truncated: true });
});

for (const [name, value] of [
  ["vide", choice("")],
  ["blanche", choice("  \n\t")],
  ["absente", undefined],
  ["sans contenu", { message: {}, finish_reason: "length" }],
  ["non textuelle", choice(["a", "b"])],
]) {
  test(`readCompletion refuse une réponse ${name}`, () => {
    assert.throws(() => readCompletion(value), /empty completion/);
  });
}

test("writeOutput crée un nouveau fichier, sous-dossiers compris", () => {
  const target = path.join(dir, "a", "b", "new.txt");
  writeOutput(target, "contenu", false);
  assert.equal(fs.readFileSync(target, "utf8"), "contenu");
});

test("writeOutput n'écrase jamais un fichier existant sans overwrite", () => {
  const target = path.join(dir, "keep.txt");
  fs.writeFileSync(target, "original");
  assert.throws(() => writeOutput(target, "remplacé", false), /already exists/);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});

test("writeOutput avec overwrite remplace le fichier et ne laisse pas de temporaire", () => {
  const target = path.join(dir, "swap.txt");
  fs.writeFileSync(target, "original");
  writeOutput(target, "remplacé", true);
  assert.equal(fs.readFileSync(target, "utf8"), "remplacé");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("writeOutput ne suit jamais un lien symbolique, même avec overwrite", () => {
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "intact");
  for (const overwrite of [false, true]) {
    const link = path.join(dir, `link-${overwrite}.txt`);
    fs.symlinkSync(victim, link);
    try { writeOutput(link, "piégé", overwrite); } catch { /* refus accepté */ }
    assert.equal(fs.readFileSync(victim, "utf8"), "intact");
  }
});
