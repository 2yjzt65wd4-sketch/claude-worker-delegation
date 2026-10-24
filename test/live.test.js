import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLiveLog } from "../lib/live.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "live-"));

test("le journal reçoit le texte par sections, avec un titre à chaque changement de nature", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = openLiveLog(dir, { tier: "reason" });
  log.note("reason · modèle · tâche de 12 signes");
  log.text("reasoning", "je réfléchis ");
  log.text("reasoning", "encore");
  log.text("content", "voici la réponse");
  log.note("[reason/x in=1 out=2]");
  log.close();
  const text = fs.readFileSync(log.file, "utf8");
  assert.match(text, /tâche de 12 signes/);
  assert.match(text, /── reasoning ──\nje réfléchis encore/);
  assert.match(text, /── answer ──\nvoici la réponse/);
  assert.equal((text.match(/── reasoning ──/g) || []).length, 1, "un seul titre tant que la nature ne change pas");
  assert.match(text, /\[reason\/x in=1 out=2\]/);
});

test("le fichier est privé (0600) et latest.log désigne le journal en cours", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = openLiveLog(dir, { tier: "reason" });
  log.text("reasoning", "x");
  log.close();
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
  assert.equal(fs.readlinkSync(path.join(dir, "latest.log")), path.basename(log.file));
  assert.equal(fs.readFileSync(path.join(dir, "latest.log"), "utf8"), fs.readFileSync(log.file, "utf8"));
});

test("le texte est écrit pendant le job, pas seulement à la fin", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = openLiveLog(dir, { tier: "reason", flushMs: 30 });
  t.after(() => log.close());
  log.text("reasoning", "déjà visible");
  await new Promise((r) => setTimeout(r, 150));
  assert.match(fs.readFileSync(log.file, "utf8"), /déjà visible/);
});

test("seuls les `keep` derniers journaux sont conservés, sans toucher aux autres fichiers", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "à moi");
  const names = [];
  for (let i = 0; i < 5; i++) {
    const log = openLiveLog(dir, { tier: "fast", keep: 3 });
    log.close();
    names.push(path.basename(log.file));
  }
  const left = fs.readdirSync(dir).filter((n) => n.endsWith(".log") && n !== "latest.log").sort();
  assert.deepEqual(left, names.slice(-3).sort());
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")));
});

test("des journaux créés dans la même milliseconde sont élagués dans l'ordre de création (un lot démarre ses jobs ensemble)", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const instant = () => new Date("2026-10-24T14:00:00.000Z"); // la même milliseconde pour tous
  const created = [];
  for (let i = 0; i < 10; i++) {
    const log = openLiveLog(dir, { tier: "reason", keep: 3, now: instant });
    log.close();
    created.push(path.basename(log.file));
  }
  const left = fs.readdirSync(dir).filter((n) => n.endsWith(".log") && n !== "latest.log").sort();
  assert.deepEqual(left, created.slice(-3));
});

test("un dossier impossible à créer désactive le journal sans jamais lever d'erreur", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, "fichier");
  fs.writeFileSync(blocker, "je ne suis pas un dossier");
  const log = openLiveLog(path.join(blocker, "live"), { tier: "reason" });
  assert.doesNotThrow(() => {
    log.note("x");
    log.text("reasoning", "y");
    log.close();
    log.close();
  });
});
