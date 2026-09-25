/**
 * sourcedate — the one owner of the source-date rule: a `source_date` is valid
 * time with exactly one canonical spelling, [CANONICAL_DATE_FORMAT].
 *
 * [parseSourceDate] is the shared fact. The writer tolerates a non-date
 * ([truncateSourceDate], applied in [wikipage.Page.set] so no caller can skip
 * it); validation refuses ([canonicalSourceDate], for callers that validate
 * before writing). A writer must never throw on content it was handed.
 */

/** The one canonical spelling every accepted `source_date` is truncated to. */
export const CANONICAL_DATE_FORMAT = "YYYY-MM-DD";

/** Canonicalise any accepted spelling to YYYY-MM-DD, or null when value is not
 * a valid date at all (free text, malformed, non-string/non-Date). Any clock
 * truncates to its date. */
export function parseSourceDate(value: unknown): string | null {
  if (value instanceof Date) {
    return formatDateOnly(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
    );
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [y, mo, d] = [
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
    ];
    return validDate(y, mo, d) ? formatDateOnly(y, mo, d) : null;
  }
  // The timestamp form, with an optional zone; only the date part is kept.
  const stamp = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?$/,
  );
  if (stamp) {
    const [y, mo, d] = [Number(stamp[1]), Number(stamp[2]), Number(stamp[3])];
    return validDate(y, mo, d) ? formatDateOnly(y, mo, d) : null;
  }
  return null;
}

/** The validating posture: canonicalise a `source_date`, throwing on a
 * non-date. Null and undefined pass through as absent. */
export function canonicalSourceDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  const date = parseSourceDate(value);
  if (date === null) {
    throw new Error(
      `source_date must be a valid date (${CANONICAL_DATE_FORMAT}), got ${String(value)}`,
    );
  }
  return date;
}

/** The writer's posture: canonicalise a valid date, otherwise return the value
 * unchanged, so a hand-written non-date reaches disk verbatim. */
export function truncateSourceDate(value: unknown): unknown {
  const date = parseSourceDate(value);
  return date !== null ? date : value;
}

/** Whether y/m/d is a real calendar date. Hand-rolled because stdlib
 * `new Date("2026-02-30")` rolls over to March 2 instead of rejecting, and the
 * script layer carries zero runtime dependencies (ADR-0006). */
function validDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[mo - 1];
}

function formatDateOnly(y: number, mo: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
