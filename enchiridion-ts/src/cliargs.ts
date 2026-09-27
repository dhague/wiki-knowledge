/** Commander option processors shared across the command groups. */

/** Split on commas, trimming whitespace and dropping empties. */
export function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Commander repeatable-flag processor: (value, previous), appended in order. */
export function collectFlag(value: string, previous: string[]): string[] {
  return [...previous, value];
}
