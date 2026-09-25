/**
 * The CLI's output contract. Two dialects:
 *
 * - Rows ([emitRows]) — JSON Lines, one compact object per line. `search`,
 *   `superseded-by`, `ingest-scan`, `check`, `discover`'s single-page mode.
 * - One document ([emitDocument]) — one compact JSON value for the whole run.
 *   `search --status`/`--reindex`, `read-page`, `discover --plan`, `vault
 *   kinds`, `export --candidates`. The value may itself be an array: the
 *   dialect is how many documents, not the outer JSON type.
 *
 * `page set --json` is the exception: it parses its value argument as JSON,
 * i.e. input, not output. Every other `--json` selects an output dialect.
 *
 * A command that cannot do its job calls [fail], which throws. Both entry
 * points — `main` and the in-process `run` — render that throw through
 * [failureMessage] onto stderr with exit code 1.
 */

/** Write rows as JSON Lines; an empty result set is silence, not `[]`. */
export function emitRows(rows: Iterable<unknown>): void {
  for (const row of rows) console.log(JSON.stringify(row));
}

export function emitDocument(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** Signal failure by throwing — never `process.exitCode = 1; return`, which
 * leaves the caller's flow running. */
export function fail(message: string): never {
  throw new Error(message);
}

/** The stderr line for a failure: its message, newline-terminated exactly
 * once. A non-`Error` throw renders as its string. */
export function failureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.endsWith("\n") ? message : message + "\n";
}
