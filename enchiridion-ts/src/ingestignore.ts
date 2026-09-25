/**
 * Read and append to `.ingestignore`, the human-authored policy file that
 * permanently withdraws a raw/ file from the ingestion sweep.
 *
 * It is read from a raw file's own folder only, with no ancestor walk: that
 * keeps a hand-written policy file from drifting into a machine-written
 * done-list.
 */

import fs from "node:fs";
import path from "node:path";

export const Filename = ".ingestignore";

/** Read `.ingestignore` text into patterns: `#` comments and blank lines
 * stripped, the rest a filename glob. `/`, `!` and `**` are rejected — a
 * per-folder file has no way to answer the precedence questions richer patterns
 * raise. */
export function parse(text: string): string[] {
  const patterns: string[] = [];
  for (let line of text.split("\n")) {
    const hash = line.indexOf("#");
    if (hash !== -1) line = line.slice(0, hash);
    line = line.replace(/[ \t\r]+$/, "");
    if (line.trim() === "") continue;
    if (/[/!]/.test(line) || line.includes("**")) {
      throw new Error(
        `${Filename} patterns must be bare filename globs (no '/', no '!', no '**'): "${line}"`,
      );
    }
    patterns.push(line);
  }
  return patterns;
}

export interface Matcher {
  matches(name: string): boolean;
}

/** Literal patterns (no `*`/`?`) go into a `Set`; globs compile to `RegExp`
 * once, not per file. */
export function compile(patterns: string[]): Matcher {
  const literals = new Set<string>();
  const globs: RegExp[] = [];
  for (const pattern of patterns) {
    if (!/[*?]/.test(pattern)) {
      literals.add(pattern);
    } else {
      let re = "";
      for (const ch of pattern) {
        if (ch === "*") re += "[^/]*";
        else if (ch === "?") re += "[^/]";
        else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      globs.push(new RegExp(`^${re}$`));
    }
  }
  return {
    matches(name: string): boolean {
      return literals.has(name) || globs.some((re) => re.test(name));
    },
  };
}

/** Adds pattern to folder's `.ingestignore`, creating it if absent; one already
 * present is not re-added. `comment`, when non-empty, follows the `#` on the
 * same line. */
export function append(folder: string, pattern: string, comment: string): void {
  const filePath = path.join(folder, Filename);

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
  if (existing !== null) {
    const patterns = parse(existing);
    if (patterns.includes(pattern)) return;
  }

  let line = pattern;
  if (comment !== "") line += "  # " + comment;
  // The folder is deliberately not created: a withdrawn raw file lives in it
  // already, so a missing folder means a mistyped path.
  const fd = fs.openSync(filePath, "a", 0o644);
  try {
    fs.writeSync(fd, line + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}
