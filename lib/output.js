import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The model's text, or an error when there is none. `truncated` means it hit max_tokens. */
export function readCompletion(choice) {
  const text = choice?.message?.content;
  const reason = choice?.finish_reason ?? "unknown";
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error(
      `empty completion (finish_reason=${reason}). With a reasoning model the reasoning can use the whole max_tokens budget before any answer: ` +
        "cap its effort for this tier (reasoning.effort or reasoning.max_tokens in models.local.json), narrow the task, or use a tier without reasoning.",
    );
  }
  return { text, truncated: reason === "length" };
}

/**
 * Writes the output without ever following a symbolic link at the destination.
 * Without overwrite the file is created exclusively (O_EXCL fails on an existing file or link);
 * with overwrite it is written to a temporary file and renamed, which replaces a link itself
 * rather than its target.
 */
export function writeOutput(outPath, text, overwrite) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (!overwrite) {
    try {
      fs.writeFileSync(outPath, text, { flag: "wx" });
    } catch (e) {
      if (e.code === "EEXIST") throw new Error(`${outPath} already exists; pass overwrite:true to replace it`);
      throw e;
    }
    return;
  }
  const tmp = `${outPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { flag: "wx" });
  fs.renameSync(tmp, outPath);
}
