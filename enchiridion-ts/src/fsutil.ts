/** Filesystem utilities shared across the enchiridion script layer. */
import fs from "node:fs";

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
