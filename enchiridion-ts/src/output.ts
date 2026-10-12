/**
 * The CLI's output contract. Two dialects:
 *
 * - Rows ([emitRows]) — JSON Lines, one compact object per line. `search`,
 *   `superseded-by`, `ingest-scan`, `check`, `discover`'s single-page mode.
 * - One document ([emitDocument]) — one compact JSON value for the whole run.
 *   `search --status`/`--reindex`, `read-page`, `read-pages`, `discover --plan`,
 *   `vault kinds`, `export --candidates`. The value may itself be an array: the
 *   dialect is how many documents, not the outer JSON type.
 *
 * `page set --json` is the exception: it parses its value argument as JSON,
 * i.e. input, not output. Every other `--json` selects an output dialect.
 *
 * [emitSkippedPages] is neither dialect: a stderr diagnostic naming each page
 * the index could not hold.
 *
 * A command that cannot do its job calls [fail] (bad environment) or
 * [failBadInvocation] (bad invocation), which throw. Both entry points — `main`
 * and the in-process `run` — render that throw through [failureMessage] onto
 * stderr, exiting with [exitCodeFor]'s class: 2 when the caller's invocation is
 * at fault, 1 when the vault, a file or the environment is. The class rides the
 * exit code alone, never the message (ADR-0034).
 */

/** Exit codes: success, and the two failure classes ADR-0034 fixes. */
export const ExitSuccess = 0;
export const ExitBadEnvironment = 1;
export const ExitBadInvocation = 2;

/** Write rows as JSON Lines; an empty result set is silence, not `[]`. */
export function emitRows(rows: Iterable<unknown>): void {
  for (const row of rows) console.log(JSON.stringify(row));
}

export function emitDocument(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** Name every page the index could not hold, one `skipped <page_ref>: <reason>`
 * line each on stderr — never stdout, so no dialect above is touched. */
export function emitSkippedPages(
  skipped: Iterable<{ pageRef: string; reason: string }>,
): void {
  for (const page of skipped) {
    console.error(`skipped ${page.pageRef}: ${page.reason}`);
  }
}

/** A failure whose remedy is in the invocation the caller typed — an unknown
 * verb, flag or value, a missing argument, or a combination the help forbids.
 * A well-formed invocation the vault, a file or the environment refuses is bad
 * environment instead, and needs no type of its own. */
export class BadInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadInvocationError";
  }
}

/** Signal failure by throwing — never `process.exitCode = 1; return`, which
 * leaves the caller's flow running. */
export function fail(message: string): never {
  throw new Error(message);
}

/** [fail] for a bad invocation, the class that exits 2. */
export function failBadInvocation(message: string): never {
  throw new BadInvocationError(message);
}

/** The exit code a failure renders as. */
export function exitCodeFor(err: unknown): number {
  return err instanceof BadInvocationError
    ? ExitBadInvocation
    : ExitBadEnvironment;
}

/** The stderr line for a failure: its message, newline-terminated exactly
 * once. A non-`Error` throw renders as its string. */
export function failureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.endsWith("\n") ? message : message + "\n";
}
