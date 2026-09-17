/**
 * The CLI's output contract (#495).
 *
 * `--json` used to mean five different things across six commands, so nothing
 * consuming the CLI could parse its output once. This module owns the whole of
 * it: each command supplies data, and the spelling — indentation, how many
 * JSON documents, and how a failure is signalled — is decided here. Records
 * themselves are untouched; only the envelope moved.
 *
 * **Two dialects.**
 *
 * - **Rows** ([emitRows]) — JSON Lines: one compact JSON object per line, and
 *   nothing at all when there are no rows. For the commands that report a
 *   sequence the caller iterates: `search`, `superseded-by`, `ingest-scan`,
 *   `check`, and `discover`'s single-page mode.
 * - **One document** ([emitDocument]) — a single compact JSON value for the
 *   whole run. For the commands that report one result: `search --status` and
 *   `--reindex`, `read-page`'s page, `discover --plan`'s payload, the
 *   `vault kinds` table, and `export --candidates`' ranking. The value may
 *   itself be an array — the dialect is *how many documents*, not the outer
 *   JSON type, and a table the caller indexes by key reads as one document
 *   where a report it iterates reads as rows.
 *
 * **The one exception: `page set --json` means input, not output.** It parses
 * the value argument as JSON. Every other `--json` in the CLI selects an
 * output dialect, and the flag is documented in `wiki-conventions` and used by
 * `wiki-ingest`, so renaming it would break a consumer. Stated here rather
 * than left to be rediscovered: `page set` is also the one subcommand whose
 * stdout no consumer parses as JSON.
 *
 * **Failure is the other half of the contract.** A command that cannot do its
 * job calls [fail], which throws. Both entry points — the real CLI (`main`)
 * and the in-process one (`run`) — put that throw through the one funnel,
 * [failureMessage] onto stderr with exit code 1. A command never sets
 * `process.exitCode` itself and never decides how its failure is rendered, so
 * a failure reads the same whichever entry point ran it.
 */

/** Write rows as JSON Lines: one compact JSON object per line, in the order
 * given, and nothing at all when there are none — an empty result set is
 * silence, not `[]`. */
export function emitRows(rows: Iterable<unknown>): void {
  for (const row of rows) console.log(JSON.stringify(row));
}

/** Write this run's one JSON document, compact, on a single line. */
export function emitDocument(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** Signal that this run failed. The one exit convention — never
 * `process.exitCode = 1; return`, which leaves the caller's own flow running
 * and the failure invisible to anything that catches. */
export function fail(message: string): never {
  throw new Error(message);
}

/** The stderr line a failed run reports: the failure's message, terminated by
 * exactly one newline. Rendered once here so both entry points — and a
 * non-`Error` throw, which a host can produce — read identically. */
export function failureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.endsWith("\n") ? message : message + "\n";
}
