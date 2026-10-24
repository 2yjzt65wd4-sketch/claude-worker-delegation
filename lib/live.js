import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let sequence = 0; // orders logs created within the same millisecond (a batch starts several jobs at once)

/**
 * A readable, append-only copy of what a worker is producing, so a human can follow a long reasoning job
 * with `tail -F live/latest.log` instead of staring at a silent tool call. It is best effort: any failure
 * to write disables the log and never affects the job. Files are private (0600) and only about the newest
 * `keep` are kept. They can quote the task and the files the worker was given (the worker may repeat them
 * while it thinks), so `live/` is untracked.
 */
export function openLiveLog(dir, { tier, keep = 20, flushMs = 1000, spareMs = 15 * 60 * 1000, now = () => new Date() }) {
  let fd;
  let dead = false;
  let pending = "";
  let section = null;
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${String(++sequence).padStart(6, "0")}-${tier}-${crypto.randomBytes(2).toString("hex")}.log`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Open first: if that fails, no older log has been deleted for nothing.
    fd = fs.openSync(file, "wx", 0o600);
    prune(dir, path.basename(file), keep, spareMs);
    // A stable name to follow, replaced atomically: the link is renamed over the old one.
    const tmp = path.join(dir, `.latest-${process.pid}-${crypto.randomBytes(2).toString("hex")}`);
    fs.symlinkSync(path.basename(file), tmp);
    fs.renameSync(tmp, path.join(dir, "latest.log"));
  } catch {
    dead = fd === undefined;
  }

  const flush = () => {
    if (dead || !pending) return;
    const bytes = Buffer.from(pending);
    pending = "";
    try {
      // writeSync may write less than asked (a nearly full disk): keep going until everything is out
      for (let done = 0; done < bytes.length; ) {
        const n = fs.writeSync(fd, bytes, done, bytes.length - done);
        if (n <= 0) throw new Error("write made no progress");
        done += n;
      }
    } catch {
      dead = true;
    }
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
      dead = true;
      if (fd !== undefined) {
        const closing = fd;
        fd = undefined; // a second close() must not close a descriptor number another log has since received
        try {
          fs.closeSync(closing);
        } catch {
          /* already closed */
        }
      }
    },
  };
}

/**
 * Deletes the oldest logs beyond `keep` (this one included), except any touched in the last `spareMs`: a
 * long job keeps writing, so its log is recent, and it must survive the jobs that start after it, including
 * those of other server processes sharing the same folder.
 */
function prune(dir, own, keep, spareMs) {
  const logs = fs.readdirSync(dir).filter((n) => /^\d{4}-.*\.log$/.test(n) && n !== own).sort();
  const cutoff = Date.now() - spareMs;
  for (const name of logs.slice(0, Math.max(0, logs.length - (keep - 1)))) {
    const old = path.join(dir, name);
    try {
      // spareMs <= 0 turns the protection off outright: file times can run a hair ahead of Date.now()
      if (spareMs <= 0 || fs.statSync(old).mtimeMs <= cutoff) fs.rmSync(old, { force: true });
    } catch {
      /* already gone, or not ours to delete */
    }
  }
}
