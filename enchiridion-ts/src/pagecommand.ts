/**
 * The page command group: the frontmatter trio (`page get|set|merge`), the
 * page reader, and the supersession lookup — everything that reads or edits
 * one page's frontmatter. Registers itself against the shared program.
 */

import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { Page, isStringListKey } from "./wikipage.js";
import { Vault, resolveRoot, vaultForFile } from "./vault.js";
import { isPageRef } from "./pagepredicate.js";
import { resolve as resolveSuperseded } from "./supersededby.js";
import { canonicalSourceDate } from "./sourcedate.js";
import {
  edgeLink,
  edgeRefusal,
  isEdgeKey,
  isListEdgeKey,
  type RefLookup,
} from "./pageedge.js";
import { emitDocument, emitRows, fail, failBadInvocation } from "./output.js";

/** Run an operation on one page, naming that page in any refusal — [Page]'s
 * YAML refusals carry no path of their own. */
function onPage<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    fail(`${file}: ${(err as Error).message}`);
  }
}

/** The absolute path a `<file>` argument names when it is a vault-relative ref
 * to a real page, else null — the spelling `page`'s edge *values* take. */
function vaultRefPath(file: string): string | null {
  if (path.isAbsolute(file)) return null;
  if (path.posix.normalize(file) !== file) return null;
  if (!isPageRef(file)) return null;
  const vault = new Vault(resolveRoot());
  return vault.exists(file) ? vault.path(file) : null;
}

/** Name a file `page` could not read as the path it resolved to — the argument
 * is cwd-relative, never `$VAULT`-relative, which is the trap a
 * vault-relative ref walks into. */
function noSuchFile(file: string): never {
  const abs = path.resolve(file);
  if (file === abs) fail(`no such file: ${file}`);
  const refPath = vaultRefPath(file);
  if (refPath !== null) {
    fail(
      `no such file: ${file} (resolved to ${abs}) — page takes a filesystem path, but ${file} is a vault-relative page ref; pass ${refPath}`,
    );
  }
  fail(
    `no such file: ${file} (resolved to ${abs}) — page takes a filesystem path, not a vault-relative page ref; pass an absolute path or run from the vault root`,
  );
}

function loadPage(file: string): Page {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") noSuchFile(file);
    if (code === "EISDIR") fail(`${file} is a directory, not a markdown file`);
    throw err;
  }
  return onPage(file, () => {
    const page = new Page(text);
    // Every page subcommand reads the block anyway; decoding here is what puts
    // the file's name on a YAML refusal.
    page.frontmatter();
    return page;
  });
}

function writePageFile(file: string, page: Page): void {
  fs.writeFileSync(file, page.text, { mode: 0o644 });
}

/**
 * A normalizer over one page's vault, so a list of values resolves the root
 * and reads each target's title once. The vault is the file's own location
 * ([vaultForFile]) — never `$VAULT` or cwd.
 */
function edgeNormalizer(file: string): (key: string, value: string) => string {
  const { vault, pageDir } = vaultForFile(file);
  const lookup: RefLookup = (ref) =>
    vault.exists(ref)
      ? { exists: true, title: vault.load(ref).getString("title") }
      : { exists: false, title: "" };
  return (key, value) => edgeLink(key, value, pageDir, lookup);
}

/** The value `page set` writes for an edge key: a single link for
 * `raw_source`, a list of links otherwise. A bare scalar would be read as no
 * edge at all, so `--json` may pass a longer list, or an empty one to clear. */
function edgeSetValue(
  file: string,
  key: string,
  value: unknown,
): string | string[] {
  const normalize = edgeNormalizer(file);
  if (!isListEdgeKey(key)) {
    if (Array.isArray(value))
      failBadInvocation(`${key} holds a single link; pass one value`);
    if (typeof value !== "string") failBadInvocation(edgeRefusal(key, value));
    return normalize(key, value);
  }
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item !== "string") failBadInvocation(edgeRefusal(key, item));
    return normalize(key, item);
  });
}

/** The value `page set` writes for a string-list key: a one-element list for
 * one bare value, the list itself for a list. A bare value shaped like a JSON
 * array is read as one (the shape `page merge` takes); anything else
 * non-string is refused. The write rule itself is [canonicalForWrite]'s. */
function stringListSetValue(key: string, value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("[") || !text.endsWith("]")) return [value];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      failBadInvocation(
        `${key} starts like a JSON list but does not parse: ${value}`,
      );
    }
    return stringListSetValue(key, parsed);
  }
  if (!Array.isArray(value))
    failBadInvocation(`${key} expects a JSON list of values`);
  return value.map((item) => {
    if (typeof item !== "string")
      failBadInvocation(`${key} expects a JSON list of strings`);
    return item;
  });
}

/** Render a value as plain text — notably a list as `['a', 'b']`, the form
 * callers of `page get` parse. */
function formatFrontmatterValue(value: unknown): string {
  if (!Array.isArray(value)) return formatScalar(value);
  return "[" + value.map((v) => `'${formatScalar(v)}'`).join(", ") + "]";
}

function formatScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** The shared missing-page refusal, so both commands name the ref the same way. */
function noSuchPage(ref: string, root: string): never {
  fail(
    `page not found: ${ref} in ${root} — refs are vault-relative (wiki/<kind-folder>/<file>.md); list pages with \`enchiridion search <term>\``,
  );
}

/** `page get|set|merge`'s `<file>` help — the surface read before the refusal. */
const FileArgument =
  "markdown file — a filesystem path (absolute, or relative to the working directory), not a vault-relative page ref";

export function registerPageCommands(program: Command): void {
  // page get|set|merge <file> <key> ... — the frontmatter trio. Resolves no
  // vault root for a plain value, but an edge key's value may be a
  // vault-relative ref composed against the vault the file sits in.
  const page = program
    .command("page")
    .description(
      "Read and edit one page's frontmatter (edge keys take a markdown link or a vault-relative page ref)",
    );

  page
    .command("get")
    .argument("<file>", FileArgument)
    .argument("<key>", "frontmatter key")
    .description("Print a frontmatter value")
    .action((file: string, key: string) => {
      const p = loadPage(file);
      const { value, ok } = p.get(key);
      if (!ok || value === null || value === undefined) {
        fail(`no frontmatter key "${key}" in ${file}`);
      }
      console.log(formatFrontmatterValue(value));
    });

  page
    .command("set")
    .argument("<file>", FileArgument)
    .argument("<key>", "frontmatter key")
    .argument(
      "<value>",
      "value; for an edge key, exactly one markdown link or a vault-relative page ref; for tags, one value or a JSON list (a list-valued key is replaced)",
    )
    .option("--json", "parse value as JSON; a list for a list-valued key")
    .description(
      "Set a frontmatter value in place — replaces the key, including a list-valued edge key",
    )
    .action(
      (file: string, key: string, raw: string, opts: { json?: boolean }) => {
        const p = loadPage(file);
        let value: unknown = raw;
        if (opts.json) {
          try {
            value = JSON.parse(raw);
          } catch {
            failBadInvocation(
              `parsing ${key} as JSON: invalid JSON — drop --json to set the value as a literal string`,
            );
          }
        }
        if (key === "source_date") {
          try {
            value = canonicalSourceDate(value);
          } catch (err) {
            // A non-date is the value argument at fault, not the file.
            failBadInvocation((err as Error).message);
          }
        }
        if (isEdgeKey(key)) value = edgeSetValue(file, key, value);
        // The writer wraps a scalar; the CLI's job is the argument, so a
        // non-string is refused here.
        if (isStringListKey(key)) value = stringListSetValue(key, value);
        const updated = p.set(key, value);
        writePageFile(file, updated);
      },
    );

  page
    .command("merge")
    .argument("<file>", FileArgument)
    .argument("<key>", "frontmatter key")
    .argument(
      "<json-list>",
      "JSON list of values to union in; edge links or vault-relative page refs",
    )
    .description(
      "Union a JSON list into an existing list-valued key (page set replaces it instead)",
    )
    .action((file: string, key: string, raw: string) => {
      const p = loadPage(file);
      let values: unknown[];
      try {
        values = JSON.parse(raw);
      } catch {
        failBadInvocation(`merge expects a JSON list for ${key}`);
      }
      if (!Array.isArray(values)) {
        failBadInvocation(`merge expects a JSON list for ${key}`);
      }
      if (isEdgeKey(key) && !isListEdgeKey(key)) {
        failBadInvocation(`${key} holds a single link; use page set`);
      }
      if (isEdgeKey(key)) {
        const normalize = edgeNormalizer(file);
        values = values.map((item) => {
          if (typeof item !== "string")
            failBadInvocation(edgeRefusal(key, item));
          return normalize(key, item);
        });
      }
      const updated = p.merge(key, values);
      writePageFile(file, updated);
    });

  // read-page <ref> — print a page's full content by vault-relative ref; the
  // read-only companion to search, for a host with no Read tool.
  program
    .command("read-page <ref>")
    .description("Print a page's full content by vault-relative ref")
    .option("--json", "emit {page_ref, frontmatter, body} as one JSON line")
    .action((ref: string, opts: { json?: boolean }) => {
      const root = resolveRoot();
      const vault = new Vault(root);
      if (!vault.exists(ref)) {
        noSuchPage(ref, root);
      }
      const page = onPage(ref, () => vault.load(ref));
      if (opts.json) {
        emitDocument({
          page_ref: ref,
          frontmatter: onPage(ref, () => page.frontmatter()),
          body: page.body(),
        });
        return;
      }
      process.stdout.write(page.text);
    });

  // superseded-by <page_ref>... — resolve refs to their current supersession
  // heads.
  program
    .command("superseded-by <page_ref...>")
    .description("Resolve page refs to their current supersession heads")
    .option("--json", "emit results as JSON Lines (one object per line)")
    .action(async (pageRefs: string[], opts: { json?: boolean }) => {
      const root = resolveRoot();
      const vault = new Vault(root);
      // A ref with no page would otherwise resolve to itself and print
      // "(current)", which an agent cannot tell from a real head.
      for (const ref of pageRefs) {
        if (!vault.exists(ref)) {
          noSuchPage(ref, root);
        }
      }
      const records = vault.pages();
      const resolutions = resolveSuperseded(pageRefs, records);

      if (opts.json) {
        emitRows(resolutions);
        return;
      }
      for (const res of resolutions) {
        if (res.chain.length === 0) {
          console.log(`${res.seed}  (current)`);
          continue;
        }
        let via = "";
        if (res.chain.length > 1) {
          via = ` via ${res.chain.slice(0, -1).join(" -> ")}`;
        }
        console.log(`${res.seed}  ->  ${res.active}${via}`);
      }
    });
}
