/** What to tell the architect when the request itself failed, as opposed to the API answering with an error. */
export function describeNetworkError(error, timeoutMs) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return (
      `OpenRouter did not finish answering within ${Math.round(timeoutMs / 1000)}s (request_timeout_ms). ` +
      "A reasoning tier can need minutes: raise request_timeout_ms in models.local.json or cap its reasoning effort."
    );
  }
  const cause = error?.cause?.code || error?.cause?.message;
  return `network error reaching OpenRouter: ${error?.message ?? error}${cause ? ` (${cause})` : ""}. Nothing was written; retry.`;
}

/**
 * POSTs and parses the JSON reply. The timeout covers the headers AND the body: OpenRouter sends the
 * headers early and keeps the connection open while a reasoning model thinks, so reading the body is
 * where a slow request actually fails. A request that dies (timeout, reset connection) throws a
 * message naming the real cause; a body that is not JSON comes back as an `error` payload.
 */
export async function postJson(url, init, timeoutMs) {
  let res;
  let raw;
  try {
    res = await fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(timeoutMs) });
    raw = await res.text();
  } catch (error) {
    throw new Error(describeNetworkError(error, timeoutMs));
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: { message: `non-JSON response (HTTP ${res.status})` } };
  }
  return { status: res.status, ok: res.ok, data };
}
