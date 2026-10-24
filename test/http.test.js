import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { describeNetworkError, postJson } from "../lib/http.js";

async function fakeApi(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

const INIT = { headers: { "Content-Type": "application/json" }, body: "{}" };

test("une réponse JSON complète est rendue avec son statut", async (t) => {
  const api = await fakeApi((req, res) => res.end(JSON.stringify({ choices: [] })));
  t.after(() => api.close());
  assert.deepEqual(await postJson(api.url, INIT, 5000), { status: 200, ok: true, data: { choices: [] } });
});

test("une erreur HTTP avec un corps JSON reste exploitable par l'appelant", async (t) => {
  const api = await fakeApi((req, res) => {
    res.statusCode = 429;
    res.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  t.after(() => api.close());
  const r = await postJson(api.url, INIT, 5000);
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.data.error.message, "rate limited");
});

test("un corps qui n'est pas du JSON devient une erreur lisible, avec le statut", async (t) => {
  const api = await fakeApi((req, res) => res.end("<html>bad gateway</html>"));
  t.after(() => api.close());
  const r = await postJson(api.url, INIT, 5000);
  assert.equal(r.data.error.message, "non-JSON response (HTTP 200)");
});

test("le délai couvre le corps : en-tête 200 tout de suite, corps trop lent => délai dépassé, pas « non-JSON »", async (t) => {
  // C'est le cas réel d'un modèle qui raisonne : OpenRouter répond 200 puis garde la connexion ouverte.
  const api = await fakeApi((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(" ");
    setTimeout(() => res.end("{}"), 3000);
  });
  t.after(() => api.close());
  await assert.rejects(postJson(api.url, INIT, 1000), (e) => {
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
  await assert.rejects(postJson(api.url, INIT, 5000), (e) => {
    assert.match(e.message, /network error reaching OpenRouter/);
    assert.match(e.message, /Nothing was written; retry/);
    assert.doesNotMatch(e.message, /non-JSON/);
    return true;
  });
});

test("un serveur injoignable est signalé comme une erreur réseau, avec la cause", async () => {
  const api = await fakeApi((req, res) => res.end("{}"));
  await api.close(); // le port vient d'être libéré : plus rien n'y écoute
  await assert.rejects(postJson(api.url, INIT, 5000), /network error reaching OpenRouter: .*ECONNREFUSED/);
});

test("describeNetworkError arrondit le délai en secondes et ne cite jamais d'en-tête", () => {
  const message = describeNetworkError(Object.assign(new Error("boom"), { name: "TimeoutError" }), 360000);
  assert.match(message, /within 360s/);
  assert.doesNotMatch(describeNetworkError(new Error("fetch failed"), 1000), /Authorization|Bearer/);
});
