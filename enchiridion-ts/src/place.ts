/**
 * Compute a new page's vault-relative path: kind-folder plus kebab-slug of
 * title. Which kind a page belongs to is the agent's judgment; this module is
 * the mechanics. Kind values stay singular, folders pluralize (ADR-0008).
 */

/** A kind value's `wiki/` folder name. The single source of truth for the
 * mapping; no other package may hardcode a kind-folder string. */
export const KindFolders: Record<string, string> = {
  source: "sources",
  synthesis: "synthesis",
  entity: "entities",
  concept: "concepts",
};

/** Folder name → kind value, for readers deriving a page's kind from its path. */
export const FolderKinds: Record<string, string> = Object.fromEntries(
  Object.entries(KindFolders).map(([kind, folder]) => [folder, kind]),
);

/** The fixed kind-value set, in the canonical order the CLI presents them. */
export const Kinds: string[] = ["concept", "entity", "source", "synthesis"];

/** Caps generated slug filenames — readability, and headroom under the
 * Windows 255-char path limit. */
export const MaxSlugLength = 64;

const minWordCut = 8;

const APOSTROPHE_RE = /['’]/g;
const NON_ALNUM_RE = /[^a-z0-9]+/g;

function truncateSlug(slug: string, maxLength: number): string {
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength).lastIndexOf("-");
  if (cut >= minWordCut) {
    return slug.slice(0, cut).replace(/-+$/, "");
  }
  return slug.slice(0, maxLength).replace(/-+$/, "");
}

/** Title as a lowercase kebab-slug. Apostrophes are dropped, not hyphenated
 * ("What's" -> "whats"); a positive maxLength truncates at a word boundary. */
export function slugify(title: string, maxLength: number): string {
  let slug = title.toLowerCase().replace(APOSTROPHE_RE, "");
  slug = slug.replace(NON_ALNUM_RE, "-");
  slug = slug.replace(/^-+/, "").replace(/-+$/, "");
  if (maxLength > 0) {
    slug = truncateSlug(slug, maxLength);
  }
  return slug;
}

/** Strip a trailing `s` (ADR-0008). For custom kind-folders only; canonical
 * folders are looked up in [FolderKinds] directly. */
export function folderToKind(folder: string): string {
  return folder.replace(/s$/, "");
}

/** The vault-relative path for a new page: canonical kinds resolve from
 * [KindFolders], custom ones from extraKindFolders. Throws on an unknown kind. */
export function path(
  kind: string,
  title: string,
  extraKindFolders?: Record<string, string>,
): string {
  const folder = KindFolders[kind] ?? extraKindFolders?.[kind];
  if (folder === undefined) {
    throw new Error(
      `unknown kind "${kind}"; must be one of ${Kinds.join(", ")}`,
    );
  }
  return `wiki/${folder}/${slugify(title, MaxSlugLength)}.md`;
}
