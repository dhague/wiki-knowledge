/** Filesystem utilities shared across the enchiridion script layer. */
import fs from "node:fs";

/** The objects in a JSON Lines file, oldest first; empty when the file does not
 * exist. Blank, unparsable and non-object lines are skipped, so one bad line
 * never costs the rest of a log. */
export function readJsonLines(file: string): Array<Record<string, unknown>> {
  let data: string;
  try {
    data = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of data.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return rows;
}

/**
 * `fs.mkdirSync(path, { recursive: true })` that tolerates EEXIST when the
 * target already exists as a directory — Windows + OneDrive ReparsePoint stubs
 * trigger this. Re-throws EEXIST only when the path is a plain file.
 */
export function mkdirSafe(dir: string, mode?: number): void {
  try {
    fs.mkdirSync(dir, { recursive: true, ...(mode !== undefined && { mode }) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      throw err;
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `${dir} exists as a file, not a directory — delete it so it can be created as a directory`,
        { cause: err },
      );
    }
  }
}
