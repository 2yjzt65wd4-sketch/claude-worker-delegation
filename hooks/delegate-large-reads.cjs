// PreToolUse hook: deny whole-file dumps of large text files and point Claude
// at the OpenRouter workers instead.
//  - Read: blocked unless offset/limit is given.
//  - Bash/PowerShell: blocked when the command is a plain file dump
//    (cat/type/Get-Content/gc/more/less) with no pipe or line-limiting flag.
// Images, PDFs and notebooks are always allowed. Any error => allow.
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 50 * 1024; // ~12k tokens
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".pdf", ".ipynb"]);
const DUMP_CMDS = new Set(["cat", "type", "get-content", "gc", "more", "less"]);
const LIMIT_FLAG = /-(totalcount|tail|first|last|head)\b/i;

function tooBig(file, cwd) {
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) return 0;
  const size = fs.statSync(path.resolve(cwd || ".", file)).size;
  return size > MAX_BYTES ? size : 0;
}

function deny(file, size) {
  const kb = Math.round(size / 1024);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `${file} is ${kb} KB (limit ${MAX_BYTES / 1024} KB). Use mcp__workers__delegate with files:[${JSON.stringify(file)}] ` +
        `(tier "fast" for summaries, "long" only for huge files), or Grep, or read a specific section (Read offset/limit, head/tail).`,
    },
  }));
}

function checkCommand(cmd, cwd) {
  if (/[|>;&]/.test(cmd) || LIMIT_FLAG.test(cmd)) return;
  const tokens = cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (!DUMP_CMDS.has((tokens[0] || "").toLowerCase())) return;
  for (const t of tokens.slice(1)) {
    if (t.startsWith("-")) continue;
    const file = t.replace(/^["']|["']$/g, "");
    try {
      const size = tooBig(file, cwd);
      if (size) return deny(file, size);
    } catch {}
  }
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(raw);
    const input = data.tool_input || {};
    if (data.tool_name === "Read") {
      if (!input.file_path || input.offset != null || input.limit != null) return;
      const size = tooBig(input.file_path);
      if (size) deny(input.file_path, size);
    } else if (typeof input.command === "string") {
      checkCommand(input.command.trim(), data.cwd);
    }
  } catch {
    // Missing file, bad JSON, etc.: never block.
  }
});
