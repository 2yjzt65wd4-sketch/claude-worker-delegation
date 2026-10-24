import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * A readable, append-only copy of what a worker is producing, so a human can follow a long reasoning job
 * with `tail -F live/latest.log` instead of staring at a silent tool call. It is best effort: any failure
 * to write disables the log and never affects the job. Files are private (0600) and only the newest `keep`
 * are kept. They can quote the files the worker was given, so `live/` is untracked.
 */
let sequence = 0; // orders logs created within the same millisecond (a batch starts several jobs at once)

export function openLiveLog(dir, { tier, keep = 20, flushMs = 1000, now = () => new Date() }) {
  let fd;
  let dead = false;
  let pending = "";
  let section = null;
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${String(++sequence).padStart(6, "0")}-${tier}-${crypto.randomBytes(2).toString("hex")}.log`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const old = fs.readdirSync(dir).filter((n) => /^\d{4}-.*\.log$/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - (keep - 1)))) fs.rmSync(path.join(dir, n), { force: true });
    fd = fs.openSync(file, "wx", 0o600);
    // A stable name to follow, replaced atomically: the link is renamed over the old one.
    const tmp = path.join(dir, `.latest-${process.pid}-${crypto.randomBytes(2).toString("hex")}`);
    fs.symlinkSync(path.basename(file), tmp);
    fs.renameSync(tmp, path.join(dir, "latest.log"));
  } catch {
    dead = fd === undefined;
  }

  const flush = () => {
    if (dead || !pending) return;
    try {
      fs.writeSync(fd, pending);
    } catch {
      dead = true;
    }
    pending = "";
  };
  const timer = setInterval(flush, flushMs);
  timer.unref();

  return {
    file,
    /** `kind` is "reasoning" or "content"; a heading is added whenever it changes. */
    text(kind, chunk) {
      if (dead) return;
      if (kind !== section) {
        section = kind;
        pending += `\n── ${kind === "reasoning" ? "reasoning" : "answer"} ──\n`;
      }
      pending += chunk;
    },
    /** A line of its own, outside any section: start, outcome, errors. */
    note(line) {
      if (dead) return;
      section = null;
      pending += `\n[${new Date().toISOString().slice(11, 19)}] ${line}\n`;
    },
    close() {
      clearInterval(timer);
      flush();
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      dead = true;
    },
  };
}
