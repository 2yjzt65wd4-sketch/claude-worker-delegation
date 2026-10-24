// Path policy for the files a worker may read and write.
// The server reads the files it is given and sends them to a third-party model, and writes the
// model's raw output to disk, so every path is resolved through symlinks (realpath) before it is
// compared with anything. Containment is case-sensitive except on Windows; the secret and deny
// lists are matched case-insensitively, which can only over-refuse.
import fs from "node:fs";
import path from "node:path";

const SECRET_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);
const SECRET_FILES = new Set([".credentials.json", ".netrc", ".npmrc"]);
const SECRET_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
const refuse = (p, why) => new Error(`refused: ${p} ${why}`);

function inside(base, target, { strict = false } = {}) {
  const b = fold(base);
  const t = fold(target);
  return t.startsWith(b + path.sep) || (!strict && t === b);
}

// realpath that tolerates a path that does not exist yet: resolve the deepest existing ancestor.
function realpathLoose(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const normalize = (entry) => entry.split(/[\\/]+/).filter(Boolean).join("/").toLowerCase();
const listed = (list, rel) => list.some((d) => rel === d || rel.startsWith(`${d}/`));

/**
 * @param {object} o
 * @param {string} o.cwd           project root; reads are allowed under it
 * @param {string[]} [o.extraRoots] more read-only roots
 * @param {string[]} [o.deny]      relative paths refused for read and write
 * @param {string[]} [o.writeRoots] folders (relative to cwd) where write_to may create files; none = writes disabled
 * @param {string[]} [o.writeDeny] relative paths refused for write inside the write roots
 */
export function makeGuard({ cwd, extraRoots = [], deny = [], writeRoots = [], writeDeny = [] }) {
  const root = fs.realpathSync(cwd);
  const roots = [root, ...extraRoots.map((r) => realpathLoose(path.resolve(root, r)))];
  const denied = deny.map(normalize);
  const writeBlocked = writeDeny.map(normalize);
  const writable = writeRoots.map((r) => realpathLoose(path.resolve(root, r)));

  function locate(p, mustExist) {
    if (typeof p !== "string" || p === "") throw new Error("refused: empty or non-text path");
    if (p.includes("\0")) throw new Error("refused: invalid path");
    const abs = path.resolve(root, p);
    const real = mustExist ? fs.realpathSync(abs) : realpathLoose(abs);
    const base = roots.find((r) => inside(r, real));
    if (!base) throw refuse(p, `is outside the allowed roots (resolves to ${real})`);
    return { abs, real, base };
  }

  function screen(p, real, base) {
    const parts = path.relative(base, real).split(path.sep).filter(Boolean).map((x) => x.toLowerCase());
    const name = parts.at(-1) ?? "";
    if (parts.some((x) => x.startsWith(".env"))) throw refuse(p, "is an environment or secrets file");
    if (parts.some((x) => SECRET_DIRS.has(x))) throw refuse(p, "is inside a protected folder");
    if (SECRET_FILES.has(name) || SECRET_PREFIXES.some((x) => name.startsWith(x)) || SECRET_SUFFIXES.some((x) => name.endsWith(x))) {
      throw refuse(p, "looks like a credential or key file");
    }
    if (listed(denied, parts.join("/"))) throw refuse(p, "is on the deny list (WORKERS_DENY)");
  }

  return {
    /** Returns the resolved path of a file the worker may be given. */
    checkRead(p) {
      const { real, base } = locate(p, true);
      screen(p, real, base);
      return real;
    },
    /** Returns the resolved path of a file the worker may create or replace. */
    checkWrite(p) {
      if (writable.length === 0) {
        throw new Error("refused: write_to is disabled; set WORKERS_WRITE_ROOTS (';'-separated folders relative to the project root)");
      }
      const { abs, real, base } = locate(p, false);
      let st = null;
      try {
        st = fs.lstatSync(abs);
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      }
      if (st?.isSymbolicLink()) throw refuse(p, "is a symbolic link; refusing to write through it");
      screen(p, real, base);
      if (!writable.some((w) => inside(w, real, { strict: true }))) {
        throw refuse(p, "is outside the write roots (WORKERS_WRITE_ROOTS)");
      }
      if (listed(writeBlocked, path.relative(root, real).split(path.sep).join("/").toLowerCase())) {
        throw refuse(p, "is write-protected (WORKERS_WRITE_DENY)");
      }
      return real;
    },
  };
}
