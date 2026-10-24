import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { describeNetworkError, postChat } from "../lib/http.js";

async function fakeApi(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

const INIT = { headers: { "Content-Type": "application/json" }, body: "{}" };
const LIMITS = { timeoutMs: 5000, idleMs: 5000 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res) => res.writeHead(200, { "Content-Type": "text/event-stream" });
const event = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content, finish_reason = null) => event({ model: "fake/model", choices: [{ delta: { content }, finish_reason }] });

// --- Réponse JSON ordinaire (erreurs HTTP comprises) --------------------------------------

test("une réponse JSON complète est rendue avec son statut", async (t) => {
  const api = await fakeApi((req, res) => res.end(JSON.stringify({ choices: [] })));
  t.after(() => api.close());
  assert.deepEqual(await postChat(api.url, INIT, LIMITS), { status: 200, ok: true, data: { choices: [] } });
});

test("une erreur HTTP avec un corps JSON reste exploitable par l'appelant", async (t) => {
  const api = await fakeApi((req, res) => {
    res.statusCode = 429;
    res.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  t.after(() => api.close());
  const r = await postChat(api.url, INIT, LIMITS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.data.error.message, "rate limited");
});

test("un corps qui n'est pas du JSON devient une erreur lisible, avec le statut", async (t) => {
  const api = await fakeApi((req, res) => res.end("<html>bad gateway</html>"));
  t.after(() => api.close());
  const r = await postChat(api.url, INIT, LIMITS);
  assert.equal(r.data.error.message, "non-JSON response (HTTP 200)");
});

test("le délai total couvre le corps : en-tête 200 tout de suite, corps trop lent => délai dépassé, pas « non-JSON »", async (t) => {
  const api = await fakeApi((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(" ");
    setTimeout(() => res.end("{}"), 3000);
  });
  t.after(() => api.close());
  await assert.rejects(postChat(api.url, INIT, { timeoutMs: 1000, idleMs: 5000 }), (e) => {
    assert.match(e.message, /did not finish answering within 1s \(request_timeout_ms\)/);
    assert.match(e.message, /models\.local\.json/);
    assert.doesNotMatch(e.message, /non-JSON/);
    return true;
  });
});

test("une connexion coupée en plein corps est signalée comme une erreur réseau", async (t) => {
  const api = await fakeApi((req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.write("{");
    setTimeout(() => res.socket.destroy(), 50);
  });
  t.after(() => api.close());
  await assert.rejects(postChat(api.url, INIT, LIMITS), (e) => {
    assert.match(e.message, /network error reaching OpenRouter/);
    assert.match(e.message, /Nothing was written; retry/);
    assert.doesNotMatch(e.message, /non-JSON/);
    return true;
  });
});

test("un serveur injoignable est signalé comme une erreur réseau, avec la cause", async () => {
  const api = await fakeApi((req, res) => res.end("{}"));
  await api.close(); // le port vient d'être libéré : plus rien n'y écoute
  await assert.rejects(postChat(api.url, INIT, LIMITS), /network error reaching OpenRouter: .*ECONNREFUSED/);
});

// --- Flux SSE ------------------------------------------------------------------------------

test("un flux est assemblé : contenu, motif d'arrêt, modèle et usage ; commentaires et raisonnement ignorés", async (t) => {
  const api = await fakeApi((req, res) => {
    sse(res);
    res.write(": OPENROUTER PROCESSING\n\n");
    res.write(event({ model: "fake/model", choices: [{ delta: { reasoning: "je réfléchis longuement" } }] }));
    res.write(delta("Bon"));
    res.write(delta("jour"));
    res.write(event({ model: "fake/model", choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 40, cost: 0.002 } }));
    res.end("data: [DONE]\n\n");
  });
  t.after(() => api.close());
  const r = await postChat(api.url, INIT, LIMITS);
  assert.equal(r.ok, true);
  assert.equal(r.data.model, "fake/model");
  assert.equal(r.data.choices[0].message.content, "Bonjour");
  assert.equal(r.data.choices[0].finish_reason, "stop");
  assert.deepEqual(r.data.usage, { prompt_tokens: 7, completion_tokens: 40, cost: 0.002 });
});

test("un événement coupé en deux paquets réseau, et des fins de ligne CRLF, sont recollés", async (t) => {
  const whole = event({ choices: [{ delta: { content: "é€" }, finish_reason: "stop" }] }).replaceAll("\n", "\r\n");
  const bytes = Buffer.from(whole + "data: [DONE]\r\n\r\n");
  const cut = whole.indexOf("é") + 1; // au milieu d'un caractère UTF-8 sur deux octets
  const api = await fakeApi(async (req, res) => {
    sse(res);
    res.write(bytes.subarray(0, cut));
    await wait(40);
    res.write(bytes.subarray(cut, cut + 5));
    await wait(40);
    res.end(bytes.subarray(cut + 5));
  });
  t.after(() => api.close());
  const r = await postChat(api.url, INIT, LIMITS);
  assert.equal(r.data.choices[0].message.content, "é€");
});

test("une erreur en cours de flux (statut 200) est rendue comme une erreur, jamais comme une réponse partielle", async (t) => {
  const api = await fakeApi((req, res) => {
    sse(res);
    res.write(delta("début"));
    res.write(event({ error: { code: "server_error", message: "provider crashed" }, choices: [{ delta: { content: "" }, finish_reason: "error" }] }));
    res.end("data: [DONE]\n\n");
  });
  t.after(() => api.close());
  const r = await postChat(api.url, INIT, LIMITS);
  assert.equal(r.data.error.message, "provider crashed");
  assert.equal(r.data.choices, undefined);
});

test("un flux fermé avant la fin, sans motif d'arrêt ni [DONE], n'est pas pris pour une réponse complète", async (t) => {
  const api = await fakeApi((req, res) => {
    sse(res);
    res.write(delta("réponse tron"));
    res.end(); // fermeture propre mais prématurée
  });
  t.after(() => api.close());
  await assert.rejects(postChat(api.url, INIT, LIMITS), /closed the stream before the end \(12 characters received/);
});

test("un événement qui n'est pas du JSON interrompt le flux avec un message clair", async (t) => {
  const api = await fakeApi((req, res) => {
    sse(res);
    res.end("data: {pas du json\n\n");
  });
  t.after(() => api.close());
  await assert.rejects(postChat(api.url, INIT, LIMITS), /stream event that is not JSON/);
});

test("un flux muet plus longtemps que le délai d'inactivité est coupé, avec ce nom-là", async (t) => {
  const api = await fakeApi((req, res) => {
    sse(res);
    res.write(delta("début"));
    // puis plus rien : une connexion morte que personne n'a fermée
  });
  t.after(() => api.close());
  await assert.rejects(postChat(api.url, INIT, { timeoutMs: 20000, idleMs: 1000 }), (e) => {
    assert.match(e.message, /sent nothing for 1s \(stream_idle_timeout_ms\)/);
    assert.doesNotMatch(e.message, /request_timeout_ms/);
    return true;
  });
});

test("des commentaires de maintien de connexion suffisent à garder un flux lent en vie", async (t) => {
  // Un modèle qui raisonne longtemps : rien d'utile pendant 2 s, mais le serveur signale qu'il travaille.
  const api = await fakeApi(async (req, res) => {
    sse(res);
    for (let i = 0; i < 7; i++) {
      res.write(": OPENROUTER PROCESSING\n\n");
      await wait(300);
    }
    res.write(delta("enfin", "stop"));
    res.end("data: [DONE]\n\n");
  });
  t.after(() => api.close());
  const r = await postChat(api.url, INIT, { timeoutMs: 20000, idleMs: 1000 });
  assert.equal(r.data.choices[0].message.content, "enfin");
});

test("le délai total s'applique aussi à un flux qui ne finit jamais, même s'il reste actif", async (t) => {
  const api = await fakeApi(async (req, res) => {
    sse(res);
    for (let i = 0; i < 40 && !res.destroyed; i++) {
      res.write(": OPENROUTER PROCESSING\n\n");
      await wait(100);
    }
  });
  t.after(() => api.close());
  await assert.rejects(postChat(api.url, INIT, { timeoutMs: 800, idleMs: 5000 }), /did not finish answering within 1s \(request_timeout_ms\)/);
});

test("onText reçoit la réflexion et la réponse au fil de l'eau, dans l'ordre, sans rien changer au résultat", async (t) => {
  const api = await fakeApi((req, res) => {
    sse(res);
    res.write(event({ choices: [{ delta: { reasoning: "je " } }] }));
    res.write(event({ choices: [{ delta: { reasoning_content: "pense" } }] }));
    res.write(delta("Bon"));
    res.write(delta("jour", "stop"));
    res.end("data: [DONE]\n\n");
  });
  t.after(() => api.close());
  const seen = [];
  const r = await postChat(api.url, INIT, { ...LIMITS, onText: (kind, text) => seen.push([kind, text]) });
  assert.deepEqual(seen, [["reasoning", "je "], ["reasoning", "pense"], ["content", "Bon"], ["content", "jour"]]);
  assert.equal(r.data.choices[0].message.content, "Bonjour");
});

test("un observateur qui plante n'interrompt pas la requête", async (t) => {
  const api = await fakeApi((req, res) => {
    sse(res);
    res.write(event({ choices: [{ delta: { reasoning: "x" } }] }));
    res.write(delta("ok", "stop"));
    res.end("data: [DONE]\n\n");
  });
  t.after(() => api.close());
  const r = await postChat(api.url, INIT, { ...LIMITS, onText: () => { throw new Error("disque plein"); } });
  assert.equal(r.data.choices[0].message.content, "ok");
});

test("describeNetworkError arrondit les délais en secondes et ne cite jamais d'en-tête", () => {
  const message = describeNetworkError(Object.assign(new Error("boom"), { name: "TimeoutError" }), 360000, 600000);
  assert.match(message, /within 360s/);
  assert.doesNotMatch(describeNetworkError(new Error("fetch failed"), 1000, 1000), /Authorization|Bearer/);
});
