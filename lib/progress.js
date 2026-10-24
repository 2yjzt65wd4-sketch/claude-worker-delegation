const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/**
 * MCP progress notifications for a long tool call, so the client can show that a worker is alive and what it
 * is currently thinking. They are only sent when the client asked for them (it passes a progress token), every
 * `intervalMs`, and a failed send never affects the job. One reporter covers every job of a tool call: for a
 * batch it shows how many are running and the latest text from any of them.
 */
export function createProgress(extra, { intervalMs, label, total = 1, now = Date.now }) {
  const token = extra?._meta?.progressToken;
  const started = now();
  const stats = { reasoning: 0, answer: 0, tail: "", done: 0 };
  let timer;
  let last = 0;

  const send = () => {
    // This runs inside a timer: an exception here would take the whole server down, whatever the transport does.
    try {
      // The spec wants `progress` to strictly grow: elapsed seconds, pushed up by one if a second repeats.
      last = Math.max(last + 1, Math.round((now() - started) / 1000));
      const running = total - stats.done;
      const where = total > 1 ? `${label} · ${running} running, ${stats.done} done` : label;
      const text = `${where} · ${clock(now() - started)} · reasoning ${stats.reasoning} chars, answer ${stats.answer} chars` +
        (stats.tail ? ` · …${stats.tail}` : "");
      Promise.resolve(extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: last, message: text },
      })).catch(() => {});
    } catch {
      /* a closed transport must not affect the job */
    }
  };

  if (token !== undefined && typeof extra.sendNotification === "function") {
    timer = setInterval(send, intervalMs);
    timer.unref();
  }

  return {
    feed(kind, text) {
      if (kind === "reasoning") {
        stats.reasoning += text.length;
        // the last words only, on one line: it is a glimpse of the thought, not the thought
        stats.tail = (stats.tail + text).replace(/\s+/g, " ").slice(-90);
      } else {
        stats.answer += text.length;
      }
    },
    jobDone() {
      stats.done += 1;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
