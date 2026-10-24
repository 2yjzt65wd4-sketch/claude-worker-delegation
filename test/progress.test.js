import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgress } from "../lib/progress.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeExtra(token) {
  const sent = [];
  return { sent, _meta: token === undefined ? undefined : { progressToken: token }, sendNotification: async (n) => { sent.push(n); } };
}

test("sans jeton de progression, le client n'a rien demandé : aucune notification", async () => {
  const extra = fakeExtra();
  const progress = createProgress(extra, { intervalMs: 10, label: "reason" });
  progress.feed("reasoning", "texte");
  await wait(80);
  progress.stop();
  assert.equal(extra.sent.length, 0);
});

test("avec un jeton : des notifications régulières, au jeton du client, qui ne font que croître", async () => {
  const extra = fakeExtra("abc");
  const progress = createProgress(extra, { intervalMs: 20, label: "reason" });
  await wait(130);
  progress.stop();
  assert.ok(extra.sent.length >= 3, `${extra.sent.length} notification(s)`);
  for (const n of extra.sent) {
    assert.equal(n.method, "notifications/progress");
    assert.equal(n.params.progressToken, "abc");
  }
  const values = extra.sent.map((n) => n.params.progress);
  assert.ok(values.every((v, i) => i === 0 || v > values[i - 1]), `strictement croissant : ${values}`);
});

test("le message dit l'étape, le volume produit et les derniers mots de la réflexion, sur une ligne", async () => {
  const extra = fakeExtra("tok");
  const progress = createProgress(extra, { intervalMs: 20, label: "reason" });
  progress.feed("reasoning", "Je vérifie\nsi la clé\n\npeut fuiter ");
  progress.feed("content", "abc");
  await wait(60);
  progress.stop();
  const { message } = extra.sent.at(-1).params;
  assert.match(message, /^reason · /);
  assert.match(message, /reasoning 34 chars, answer 3 chars/);
  assert.match(message, /…Je vérifie si la clé peut fuiter $/);
  assert.doesNotMatch(message, /\n/);
});

test("seuls les 90 derniers signes de la réflexion sont montrés", async () => {
  const extra = fakeExtra("tok");
  const progress = createProgress(extra, { intervalMs: 20, label: "reason" });
  progress.feed("reasoning", "A".repeat(500) + "FIN");
  await wait(60);
  progress.stop();
  const tail = extra.sent.at(-1).params.message.split("· …").at(-1);
  assert.equal(tail.length, 90);
  assert.ok(tail.endsWith("FIN"));
});

test("un lot indique combien de jobs tournent et combien sont finis", async () => {
  const extra = fakeExtra("tok");
  const progress = createProgress(extra, { intervalMs: 20, label: "batch of 3", total: 3 });
  progress.jobDone();
  await wait(60);
  progress.stop();
  assert.match(extra.sent.at(-1).params.message, /batch of 3 · 2 running, 1 done/);
});

test("stop() arrête les notifications", async () => {
  const extra = fakeExtra("tok");
  const progress = createProgress(extra, { intervalMs: 20, label: "reason" });
  await wait(70);
  progress.stop();
  const n = extra.sent.length;
  await wait(100);
  assert.equal(extra.sent.length, n);
});

test("un envoi qui échoue n'a aucune conséquence", async () => {
  const extra = { _meta: { progressToken: "t" }, sendNotification: async () => { throw new Error("transport fermé"); } };
  const progress = createProgress(extra, { intervalMs: 10, label: "reason" });
  await wait(60);
  progress.stop(); // aucune exception, aucun rejet non géré
});
