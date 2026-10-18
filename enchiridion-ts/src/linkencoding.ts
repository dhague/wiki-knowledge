/**
 * Link-destination encoding — the wiki's one encode/decode boundary, and a leaf:
 * nothing here imports another wiki module.
 */

/** The minimal charset that makes a raw/ filename linkable. */
export const EncodeChars = " #%()<>";

/** Percent-encode [EncodeChars] in path; all else stays literal. */
export function percentEncode(p: string): string {
  let out = "";
  for (const ch of p) {
    if (ch < "\x80" && EncodeChars.includes(ch)) {
      out += "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

/** Reverse [percentEncode]. An invalid or truncated escape is left verbatim. */
export function percentDecode(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "%" && i + 2 < p.length) {
      const hex = p.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Split an encoded link destination into its decoded path and decoded anchor.
 *
 * Split on the literal `#` first, decode each half after: decoding up front
 * would turn an encoded `#` in a filename (`%23`) into a false anchor separator.
 */
export function splitDest(dest: string): { path: string; anchor: string } {
  const hash = dest.indexOf("#");
  const encodedPath = hash === -1 ? dest : dest.slice(0, hash);
  const encodedAnchor = hash === -1 ? "" : dest.slice(hash + 1);
  return {
    path: percentDecode(encodedPath),
    anchor: hash === -1 ? "" : percentDecode(encodedAnchor),
  };
}

/**
 * Re-encode a decoded path and anchor back into a link destination — the
 * inverse of [splitDest]. The `#` introducing an anchor stays literal; only a
 * `#` in the *path* — a filename's own hash, decoded from `%23` — becomes
 * `%23`. Encoding the recombined string instead would turn `#ttl` into
 * `%23ttl`, a heading link into a dangling filename.
 */
export function encodeDest(p: string, anchor: string): string {
  let dest = percentEncode(p);
  if (anchor !== "") dest += "#" + percentEncode(anchor);
  return dest;
}

/**
 * A URI scheme at the start of a destination (`https:`, `mailto:`, `data:`).
 *
 * What makes such a destination absolute is the scheme, not the `//` — a scheme
 * with no authority to name carries none: `mailto:x@y.z` is as absolute as
 * `https://example.com`.
 */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Report whether dest begins with a URI scheme. */
function hasScheme(dest: string): boolean {
  return SCHEME_RE.test(dest);
}

/**
 * Report whether path (the pre-anchor part of a decoded destination) is a
 * vault-relative reference — the only destinations link rewriting touches.
 *
 * Not one: the empty destination, an absolute path (`/…`), anything carrying
 * `://` (this test must come *before* the `.md` one, or `https://…/x.md` would
 * read as a page link), and a URI with a scheme. The `.md` test comes before
 * the scheme test, so a page whose filename carries a colon (`C:notes.md`) is
 * still a page link.
 *
 * A bare anchor needs no test: [splitDest] already stripped it, so
 * `#a-section` arrives here as "". A path can still *begin* with `#` — a file
 * whose own name starts with one — and that is a page link, so a `#` test here
 * would be wrong rather than redundant.
 */
export function isVaultRelativeDest(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("://")) return false;
  if (p.endsWith(".md")) return true;
  return !hasScheme(p);
}
