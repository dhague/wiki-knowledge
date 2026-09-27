/**
 * Structural checks that each single-owner rule is defined once and its call
 * sites derive from it: a second copy fails here instead of drifting silently.
 * Prose fenced against the same layer lives in skills.test.ts.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

interface SourceFile {
  label: string;
  /** The file's text with comments removed and string literals kept. */
  code: string;
}

let cache: SourceFile[] | null = null;

/** Every non-test module under `src/`, labelled by filename. Comments are
 * dropped through the TypeScript compiler, so a value named only in a comment
 * or a regex literal is not read as code. */
function sourceFiles(): SourceFile[] {
  cache ??= readdirSync(srcDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => {
      const text = readFileSync(path.join(srcDir, entry.name), "utf8");
      const { outputText } = ts.transpileModule(text, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          removeComments: true,
        },
      });
      return { label: entry.name, code: outputText };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return cache;
}

function codeOf(label: string): string {
  const file = sourceFiles().find((source) => source.label === label);
  assert.ok(file !== undefined, `${label} is not a source module`);
  return file.code;
}

test("no module but place.ts spells a kind-folder name", () => {
  // KindFolders is the one owner (place.ts); a caller interpolates it. The
  // literal matches the name as a path segment, so `wiki/concepts/foo.md`
  // fails too. `synthesis` needs a slash, being a kind value as well.
  const owner = "place.ts";
  const literal =
    /["'`](?:[^"'`\n]*\/)?(?:concepts|entities|sources)(?:\/[^"'`\n]*)?["'`]|["'`](?:[^"'`\n]*\/synthesis(?:\/[^"'`\n]*)?|synthesis\/[^"'`\n]*)["'`]/;
  for (const { label, code } of sourceFiles()) {
    if (label === owner) continue;
    const match = literal.exec(code);
    assert.equal(
      match,
      null,
      `${label}: hardcodes the kind-folder name ${JSON.stringify(match?.[0])} — derive it from place.KindFolders`,
    );
  }
  assert.ok(
    codeOf(owner).includes("KindFolders"),
    `${owner} must own KindFolders`,
  );
});

test("the single-link edge key is decided by pagerecord.isSingleLinkEdgeKey alone", () => {
  // isSingleLinkEdgeKey owns which edge key holds one link; the two call sites
  // that decide list-versus-scalar ask it (pagecommand.ts through pageedge's
  // isListEdgeKey) rather than comparing the key's spelling. check.ts and
  // ingest.ts also name `raw_source`, but ask whether the edge is raw_source,
  // not whether the key holds one link.
  const owner = "pagerecord.ts";
  assert.ok(
    codeOf(owner).includes("isSingleLinkEdgeKey"),
    `${owner} must own isSingleLinkEdgeKey`,
  );
  const rederived =
    /\bkey\s*(?:===|!==)\s*["']raw_source["']|["']raw_source["']\s*(?:===|!==)\s*key\b/;
  for (const label of ["pageedge.ts", "pagecommand.ts"]) {
    const code = codeOf(label);
    assert.equal(
      rederived.exec(code),
      null,
      `${label}: re-derives the single-link edge key by comparing the key against "raw_source"`,
    );
    assert.ok(
      code.includes("isSingleLinkEdgeKey(") || code.includes("isListEdgeKey("),
      `${label}: must derive the single-link edge key from ${owner}`,
    );
  }
});

test("composeLink is the only place a vault-relative link is composed", () => {
  // wikipage.composeLink owns relativise-then-percent-encode; a caller that
  // builds `[label](dest)` itself restates it.
  const owner = "wikipage.ts";
  assert.ok(
    codeOf(owner).includes("composeLink"),
    `${owner} must own composeLink`,
  );
  for (const { label, code } of sourceFiles()) {
    if (label === owner) continue;
    assert.ok(
      !code.includes("percentEncode"),
      `${label}: composes a link by hand — call wikipage.composeLink instead`,
    );
  }
  assert.ok(
    codeOf("check.ts").includes("composeLink("),
    "check.ts must compose its auto-fix links through composeLink",
  );
});

test("the folder → kind ladder is read from kindmeta alone", () => {
  // kindmeta.resolveKind owns the ladder; folderToKind is its strip-`s` step,
  // so no caller outside the two owners may reach for it.
  const owners = ["place.ts", "kindmeta.ts"];
  assert.ok(
    codeOf("kindmeta.ts").includes("resolveKind"),
    "kindmeta.ts must own the pure folder → kind ladder",
  );
  for (const { label, code } of sourceFiles()) {
    if (owners.includes(label)) continue;
    assert.ok(
      !code.includes("folderToKind("),
      `${label}: re-derives the folder → kind ladder — call kindmeta.resolveKind`,
    );
  }
  assert.ok(
    codeOf("pagerecord.ts").includes("resolveKind("),
    "pagerecord must read the folder → kind ladder through kindmeta",
  );
});

test("KIND.md is parsed by kindmeta alone", () => {
  // readKindMeta owns the declaration's tolerance; a second reader that reads
  // the file and parses YAML itself drifts from it.
  const owner = "kindmeta.ts";
  assert.ok(
    codeOf(owner).includes("parseKindMeta"),
    `${owner} must own KIND.md parsing`,
  );
  const kindMdPath =
    /["'`][^"'`\n]*\/KIND\.md["'`]|(?:join|readFileSync)\([^)]*["']KIND\.md["']/;
  const yamlImport = /\bfrom\s*["']yaml["']|\brequire\(\s*["']yaml["']\s*\)/;
  for (const { label, code } of sourceFiles()) {
    if (label === owner) continue;
    assert.ok(
      !(kindMdPath.test(code) && yamlImport.test(code)),
      `${label}: parses KIND.md itself — use kindmeta.parseKindMeta`,
    );
  }
  assert.ok(
    codeOf("exportaggregate.ts").includes("parseKindMeta("),
    "exportaggregate must read the KIND.md summary through kindmeta",
  );
});

test("only wikipage.ts assembles a frontmatter block", () => {
  // rewriteFrontmatter owns the `---\n…---\n` splice; a second assembly site
  // skips the writer's canonicalisation and link quoting.
  const owner = "wikipage.ts";
  const fence = /["'`]---\\n/;
  for (const { label, code } of sourceFiles()) {
    if (label === owner) continue;
    const match = fence.exec(code);
    assert.equal(
      match,
      null,
      `${label}: assembles a frontmatter block — write through wikipage.rewriteFrontmatter`,
    );
  }
  assert.ok(
    codeOf(owner).includes("rewriteFrontmatter"),
    `${owner} must own the frontmatter write seam`,
  );
});
