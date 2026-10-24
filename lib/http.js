/** An error this module raises itself, already worded for the architect: it must not be re-described. */
class StreamError extends Error {}

const seconds = (ms) => Math.round(ms / 1000);

/** What to tell the architect when the request itself failed, as opposed to the API answering with an error. */
export function describeNetworkError(error, timeoutMs, idleMs) {
  if (error?.name === "IdleTimeoutError") {
    return (
      `OpenRouter sent nothing for ${seconds(idleMs)}s (stream_idle_timeout_ms): the connection is probably lost. ` +
      "Nothing was written; retry."
    );
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return (
      `OpenRouter did not finish answering within ${seconds(timeoutMs)}s (request_timeout_ms). ` +
      "A reasoning tier can need minutes: raise request_timeout_ms in models.local.json or cap its reasoning effort."
    );
  }
  const cause = error?.cause?.code || error?.cause?.message;
  return `network error reaching OpenRouter: ${error?.message ?? error}${cause ? ` (${cause})` : ""}. Nothing was written; retry.`;
}

function jsonReply(res, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: { message: `non-JSON response (HTTP ${res.status})` } };
  }
  return { status: res.status, ok: res.ok, data };
}

/** Folds one server-sent event into `out`. Reasoning deltas are ignored: only the answer is kept. */
function applyEvent(payload, out) {
  if (payload === "[DONE]") {
    out.done = true;
    return;
  }
  let evt;
  try {
    evt = JSON.parse(payload);
  } catch {
    throw new StreamError("OpenRouter sent a stream event that is not JSON. Nothing was written; retry.");
  }
  if (evt.error) out.error = evt.error;
  if (typeof evt.model === "string") out.model = evt.model;
  if (evt.usage) out.usage = evt.usage;
  const choice = evt.choices?.[0];
  if (typeof choice?.delta?.content === "string") out.content += choice.delta.content;
  if (choice?.finish_reason) out.finish = choice.finish_reason;
}

/** Reads a server-sent-event body to its end and rebuilds the non-streamed reply shape. */
async function readStream(body, onChunk) {
  const decoder = new TextDecoder();
  const out = { model: undefined, content: "", finish: undefined, usage: undefined, error: undefined, done: false };
  let buffer = "";
  let dataLines = [];
  const dispatch = () => {
    if (dataLines.length) applyEvent(dataLines.join("\n"), out);
    dataLines = [];
  };
  for await (const chunk of body) {
    onChunk();
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line === "") dispatch();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      // ": OPENROUTER PROCESSING" keep-alive comments and other SSE fields carry no data
    }
  }
  dispatch(); // a last event with no blank line after it
  // An error event ends the stream with status 200: whatever came before it is not an answer.
  if (out.error) return { error: out.error };
  if (!out.done && out.finish === undefined) {
    throw new StreamError(
      `OpenRouter closed the stream before the end (${out.content.length} characters received, no finish_reason). ` +
        "Nothing was written; retry.",
    );
  }
  return {
    model: out.model,
    choices: [{ message: { content: out.content }, finish_reason: out.finish ?? "unknown" }],
    usage: out.usage,
  };
}

/**
 * POSTs a chat completion and returns `{ status, ok, data }`, where `data` has the shape of a non-streamed reply
 * whether the server streamed it or not.
 *
 * Streaming matters for reasoning models: a non-streamed request is one silent connection for as long as the
 * model thinks, which proxies and NAT layers drop after a few minutes. Server-sent events keep bytes flowing.
 * Two clocks apply: `timeoutMs` bounds the whole request, `idleMs` bounds the silence between two reads (a
 * keep-alive comment counts as life), so a dead connection is detected without capping a slow, healthy one.
 * A request that dies throws a message naming the real cause; an error answer (HTTP error, error event, body
 * that is not JSON) comes back as an `error` payload for the caller to report.
 */
export async function postChat(url, init, { timeoutMs, idleMs }) {
  const idle = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(Object.assign(new Error("idle"), { name: "IdleTimeoutError" })), idleMs);
  };
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), idle.signal]);
  try {
    arm();
    const res = await fetch(url, { ...init, method: "POST", signal });
    arm();
    const streamed = (res.headers.get("content-type") || "").includes("text/event-stream");
    if (!res.ok || !streamed) return jsonReply(res, await res.text());
    return { status: res.status, ok: true, data: await readStream(res.body, arm) };
  } catch (error) {
    if (error instanceof StreamError) throw error;
    throw new Error(describeNetworkError(error, timeoutMs, idleMs));
  } finally {
    clearTimeout(timer);
  }
}
