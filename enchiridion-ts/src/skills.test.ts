/**
 * Structural checks over the shipped skill tree: the ADR-0026 packaging
 * contract, and the prose the script layer must agree with.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  CHECKS,
  DefaultMinSimilarity,
  FIXES,
  StaleSynthesisDays,
} from "./check.js";
import { SummaryWordGuideline } from "./ingest.js";
import { Markers, RootEnvVar } from "./vault.js";
import { EncodeChars } from "./wikipage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const skillsDir = path.join(repoRoot, "wiki-plugin", "skills");
const cutReleaseSkill = path.join(
  repoRoot,
  ".claude",
  "skills",
  "cut-release",
  "SKILL.md",
);

interface Frontmatter {
  name?: unknown;
  description?: unknown;
  metadata?: unknown;
}

/** Every skill directory in the canonical tree, by directory name. */
function skillDirs(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readSkill(dir: string): string {
  return readFileSync(path.join(skillsDir, dir, "SKILL.md"), "utf8");
}

function frontmatterOf(text: string, label: string): Frontmatter {
  assert.ok(
    text.startsWith("---\n"),
    `${label} must open with a frontmatter block`,
  );
  const end = text.indexOf("\n---", 3);
  assert.ok(end > 0, `${label} must close its frontmatter block`);
  const parsed: unknown = parseYaml(text.slice("---\n".length, end));
  assert.ok(
    parsed !== null && typeof parsed === "object",
    `${label} frontmatter must be a mapping`,
  );
  return parsed as Frontmatter;
}

test("the skill tree has at least one skill", () => {
  assert.ok(skillDirs().length > 0, `${skillsDir} holds no skill directories`);
});

test("every skill directory has a SKILL.md whose frontmatter name matches it", () => {
  for (const dir of skillDirs()) {
    const fm = frontmatterOf(readSkill(dir), `${dir}/SKILL.md`);
    assert.equal(
      fm.name,
      dir,
      `${dir}/SKILL.md: frontmatter name must match its directory`,
    );
  }
});

test("every skill has a non-empty description", () => {
  for (const dir of skillDirs()) {
    const fm = frontmatterOf(readSkill(dir), `${dir}/SKILL.md`);
    assert.equal(
      typeof fm.description,
      "string",
      `${dir}/SKILL.md: description must be a string`,
    );
    assert.ok(
      (fm.description as string).trim().length > 0,
      `${dir}/SKILL.md: description must not be empty`,
    );
  }
});

test("the portable skill text names no host, tool, model or install path", () => {
  // ADR-0026: one text installs on every host, so a host-specific spelling is a
  // portability bug. `CLAUDE.md` as a vault filename is deliberately unmatched.
  const forbidden = [
    /\bClaude Code\b/,
    /\bOpenCode\b/,
    /\bDeepSeek\b/,
    /\bHaiku\b/,
    /\bSonnet\b/,
    /\$\{CLAUDE_/,
    /~\/\.claude/,
    /\bbin\/enchiridion\b/,
    /wiki\(args=/,
    /\bsubagent_type\b/,
    /\brun_in_background\b/,
  ];
  for (const dir of skillDirs()) {
    const text = readSkill(dir);
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(text),
        `${dir}/SKILL.md must not match ${pattern}`,
      );
    }
  }
});

/** One shipped markdown document, labelled by its repo-relative path. */
interface ProseDoc {
  label: string;
  text: string;
}

/** Every markdown file the plugin ships as agent directions: each skill's
 * `SKILL.md`, its `reference/` files, and the subagent briefs. */
function pluginProse(): ProseDoc[] {
  const docs: ProseDoc[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".md")) {
        docs.push({
          label: path.relative(repoRoot, abs),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(skillsDir);
  walk(path.join(repoRoot, "wiki-plugin", "agents"));
  return docs.sort((a, b) => a.label.localeCompare(b.label));
}

test("plugin prose references every check by slug, never by number", () => {
  // A bare number is ambiguous across the two numbering systems; the slug is
  // the only spelling.
  const numbered = /\bchecks?\s+\d+/i;
  for (const { label, text } of pluginProse()) {
    const match = numbered.exec(text);
    assert.equal(
      match,
      null,
      `${label}: "${match?.[0]}" references a check by number — name its slug instead`,
    );
  }
});

/** `check <slug> --json` — the per-slug CLI spelling, one of the shapes
 * [CHECK_SPELLINGS] scans for. */
const CHECK_COMMAND = /\bcheck\s+([a-z][a-z0-9-]*)\s+--json/g;

/**
 * Every shape plugin prose names a check by slug: the command above, the slug
 * beside the word, or a heading's parenthetical. A bare slug in running prose is
 * not one — it is indistinguishable from the plugin's other kebab-case words.
 */
const CHECK_SPELLINGS = [
  CHECK_COMMAND,
  /\bchecks?\s+`([a-z][a-z0-9-]*)`/gi,
  /`([a-z][a-z0-9-]*)`\s+checks?\b/gi,
  /\*\*[^*\n]+\s\(`([a-z][a-z0-9-]+)`\):\*\*/g,
];

/** Every shape prose names a fix by slug: the run-block command and the
 * backticked form. Fixes are a registry of their own, not a subset of checks. */
const FIX_SPELLINGS = [
  /"\$ENCHIRIDION"\s+fix\s+([a-z][a-z0-9-]*)/g,
  /`fix\s+([a-z][a-z0-9-]*)`/g,
  /\bfix\s+`([a-z][a-z0-9-]*)`/g,
];

test("every check slug named in plugin prose resolves to a registry key", () => {
  // A judgment check's durable spelling is a FIXES key, so both registries
  // count as a check name.
  const keys = new Set([...Object.keys(CHECKS), ...Object.keys(FIXES)]);
  for (const { label, text } of pluginProse()) {
    for (const pattern of CHECK_SPELLINGS) {
      for (const match of text.matchAll(pattern)) {
        assert.ok(
          keys.has(match[1]),
          `${label}: "${match[1]}" is named as a check but is not a CHECKS or FIXES key`,
        );
      }
    }
  }
});

test("every fix slug named in plugin prose is a FIXES key", () => {
  const keys = new Set(Object.keys(FIXES));
  for (const { label, text } of pluginProse()) {
    for (const pattern of FIX_SPELLINGS) {
      for (const match of text.matchAll(pattern)) {
        assert.ok(
          keys.has(match[1]),
          `${label}: "${match[1]}" is named as a fix but is not a FIXES key`,
        );
      }
    }
  }
});

test("wiki-lint's run block reports every check in one call", () => {
  const text = readFileSync(
    path.join(skillsDir, "wiki-lint", "SKILL.md"),
    "utf8",
  );
  const start = text.indexOf("### 2. Run mechanical checks");
  const end = text.indexOf("\n### ", start + 1);
  assert.ok(start >= 0 && end > start, "step 2 must be its own section");
  const step = text.slice(start, end);
  // The one-call form is the registry's own coverage: it names no slug, so no
  // per-check list can silently drop one.
  assert.match(
    step,
    /"\$RUNTIME"\s+"\$ENCHIRIDION"\s+check\s+--all\s+--json/,
    "wiki-lint/SKILL.md must run every check in one `check --all --json` call",
  );
  assert.equal(
    [...step.matchAll(CHECK_COMMAND)].length,
    0,
    "wiki-lint/SKILL.md must not run the checks one slug at a time",
  );
});

test("wiki-lint's catalogue keys every CHECKS check by slug", () => {
  const text = readFileSync(
    path.join(skillsDir, "wiki-lint", "SKILL.md"),
    "utf8",
  );
  const listed = [...text.matchAll(/^\|\s*`([a-z][a-z0-9-]+)`\s*\|/gm)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    listed,
    Object.keys(CHECKS).sort(),
    "wiki-lint/SKILL.md's catalogue must key every CHECKS check by slug",
  );
});

test("wiki-watch still drives the watch subcommand it orchestrates", () => {
  const text = readSkill("wiki-watch");
  for (const needle of ["watch", "ingest-scan", "wiki-ingest"]) {
    assert.ok(
      text.includes(needle),
      `wiki-watch/SKILL.md must mention ${needle}`,
    );
  }
  assert.ok(
    /Ctrl-C|SIGINT|SIGTERM/.test(text),
    "wiki-watch/SKILL.md must say how to stop it",
  );
});

test("cut-release is marked internal with a real boolean", () => {
  const fm = frontmatterOf(
    readFileSync(cutReleaseSkill, "utf8"),
    "cut-release/SKILL.md",
  );
  assert.ok(
    fm.metadata !== null && typeof fm.metadata === "object",
    "cut-release/SKILL.md needs a metadata mapping",
  );
  assert.equal(
    (fm.metadata as Record<string, unknown>).internal,
    true,
    'cut-release/SKILL.md must set metadata.internal: true — a real boolean, not "true"',
  );
});

// ---------------------------------------------------------------------------
// Prose homes and the fences against the script layer
// ---------------------------------------------------------------------------

/** The format contract; the vault-root rule's home, per ADR-0004; the
 * ingestion-authoring rules' home; and the two wiki-lint files the prose fences
 * read. */
const CONVENTIONS = "wiki-plugin/skills/wiki-conventions/SKILL.md";
const SCRIPTS_REF = "wiki-plugin/skills/wiki-conventions/reference/scripts.md";
const AUTHORING_REF = "wiki-plugin/skills/wiki-ingest/reference/authoring.md";
const LINT_SKILL = "wiki-plugin/skills/wiki-lint/SKILL.md";
const LINT_CHECKS = "wiki-plugin/skills/wiki-lint/reference/checks.md";

/** The bundle-resolution paragraph every skill that calls the script carries
 * verbatim; the vault-root rule belongs to [SCRIPTS_REF] alone. */
const SHARED_INVOCATION = [
  "The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:",
  "",
  "```bash",
  "RUNTIME=$(command -v node || command -v bun)",
  'ENCHIRIDION="<this skill\'s base directory>/scripts/enchiridion.cjs"',
  "```",
  "",
  'Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so and stop.',
].join("\n");

/** The one string that marks a file as resolving the bundle, however it spells
 * the paragraph around it — deliberately looser than [SHARED_INVOCATION], so a
 * divergent copy is caught rather than skipped. */
const BUNDLE_REFERENCE = "scripts/enchiridion.cjs";

let proseCache: Map<string, string> | null = null;

/** One shipped document's text by its repo-relative label; "" when absent. */
function proseFor(label: string): string {
  proseCache ??= new Map(pluginProse().map(({ label, text }) => [label, text]));
  return proseCache.get(label) ?? "";
}

test("every file that resolves the bundle carries the shared invocation paragraph byte-for-byte", () => {
  const carriers = pluginProse().filter(({ text }) =>
    text.includes(BUNDLE_REFERENCE),
  );
  assert.ok(carriers.length > 0, "no skill resolves the bundle");
  for (const { label, text } of carriers) {
    assert.equal(
      text.split(SHARED_INVOCATION).length - 1,
      1,
      `${label}: must carry the shared invocation paragraph exactly once, byte-identically`,
    );
  }
});

test("the vault-root rule is stated by exactly one file", () => {
  const owners = pluginProse()
    .filter(({ text }) => text.includes("nearest ancestor"))
    .map(({ label }) => label);
  assert.deepEqual(
    owners,
    [SCRIPTS_REF],
    "the vault-root rule belongs in the script runtime contract alone; every other file points at it",
  );
});

test("the vault-root rule names the markers and env var the script implements", () => {
  const text = proseFor(SCRIPTS_REF);
  const start = text.indexOf("**The vault root");
  const end = text.indexOf("\n\n", start);
  const rule = text.slice(start, end < 0 ? undefined : end);
  const markers = Markers.map((marker) =>
    marker === "wiki" ? "`wiki/`" : `\`${marker}\``,
  ).join(" or ");
  assert.ok(
    rule.includes(markers),
    `${SCRIPTS_REF}: the rule must name ${markers}, the markers vault.ts declares`,
  );
  assert.ok(
    rule.includes(`\`$${RootEnvVar}\``),
    `${SCRIPTS_REF}: the rule must name $${RootEnvVar}, the override vault.ts reads`,
  );
});

test("every skill points at the vault-root rule rather than restating it", () => {
  for (const dir of skillDirs()) {
    if (dir === "wiki-conventions") continue;
    assert.ok(
      readSkill(dir).includes("wiki-conventions/reference/scripts.md"),
      `${dir}/SKILL.md must point at the script runtime contract for the vault-root rule`,
    );
  }
});

test("each ingestion-authoring rule is stated by exactly one file", () => {
  // A distinctive phrase per rule, not its heading: a renamed heading must not
  // let a second copy hide.
  const phrases = [
    "carries a `source` edge back to it",
    "A sibling `wiki/` page is never evidence",
    "A page records what is true",
  ];
  for (const phrase of phrases) {
    const owners = pluginProse()
      .filter(({ text }) => text.includes(phrase))
      .map(({ label }) => label);
    assert.deepEqual(
      owners,
      [AUTHORING_REF],
      `"${phrase}" belongs in ${AUTHORING_REF} alone`,
    );
  }
  // The headings are the anchors every citation targets.
  for (const heading of [
    "## The chain of evidence",
    "## Verify against the source",
    "## Pages state facts",
  ]) {
    assert.ok(
      proseFor(AUTHORING_REF).includes(heading),
      `${AUTHORING_REF} must carry the heading "${heading}"`,
    );
  }
});

/** Rows of wiki-lint's `| Check | Fix level |` catalogue, header and separator
 * dropped, cells raw. */
function lintCatalogue(
  text: string,
): Array<{ name: string; fixLevel: string }> {
  const rows: Array<{ name: string; fixLevel: string }> = [];
  for (const line of text.split("\n")) {
    const row = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!row || row[1] === "Check" || /^-+$/.test(row[1])) continue;
    rows.push({ name: row[1], fixLevel: row[2] });
  }
  return rows;
}

/** The `enchiridion fix` slug a catalogue row names, if any. */
function catalogueFixSlug(name: string): string | null {
  return /`([a-z][a-z0-9-]*)`/.exec(name)?.[1] ?? null;
}

/** The three fix levels a check may carry. */
const FIX_LEVELS = ["auto-fix", "confirm first", "report only"];

/** Every fix level a passage names, case-insensitively. */
function fixLevels(text: string): string[] {
  const lower = text.toLowerCase();
  return FIX_LEVELS.filter((level) => lower.includes(level));
}

/** A reference file's `## \`slug\`` section body, up to the next heading. */
function slugSection(text: string, slug: string): string {
  const start = text.indexOf(`## \`${slug}\``);
  if (start < 0) return "";
  const bodyStart = text.indexOf("\n", start) + 1;
  const next = text.indexOf("\n## ", bodyStart);
  return text.slice(bodyStart, next < 0 ? undefined : next);
}

test("wiki-lint states each check's fix level once — in its catalogue", () => {
  assert.ok(
    !/Fix level:/i.test(readSkill("wiki-lint")),
    "the catalogue table is the one statement of a fix level; a run bullet must not restate it",
  );
});

test("wiki-lint's catalogue and its run block name the same auto-fixes", () => {
  // Only the auto-fix half of a fix level has a command to disagree with;
  // confirm-first and report-only are judgment no run block holds.
  const text = readSkill("wiki-lint");
  const catalogue = lintCatalogue(text)
    .filter((row) => /auto-fix/.test(row.fixLevel))
    .map((row) => catalogueFixSlug(row.name))
    .sort();
  const runBlock = [
    ...text.matchAll(
      /^\s*"\$RUNTIME" "\$ENCHIRIDION" fix ([a-z][a-z0-9-]*)\s*$/gm,
    ),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    catalogue,
    runBlock,
    "a check the catalogue calls auto-fixable must be run by the fix block, and vice versa",
  );
  assert.deepEqual(
    runBlock,
    Object.keys(FIXES).sort(),
    "the run block must call every FIXES entry and nothing else",
  );
});

test("wiki-lint's catalogue and its reference prose state the same fix levels", () => {
  const checks = proseFor(LINT_CHECKS);
  for (const row of lintCatalogue(readSkill("wiki-lint"))) {
    const slug = /^`([a-z][a-z0-9-]*)`$/.exec(row.name)?.[1];
    if (slug === undefined) continue;
    assert.deepEqual(
      fixLevels(slugSection(checks, slug)).sort(),
      fixLevels(row.fixLevel).sort(),
      `checks.md's ${slug} section and the catalogue must state the same fix levels`,
    );
  }
});

test("the four prose constants track their code constants", () => {
  // concept-fragmentation's --min-similarity default, check.ts.
  const similarity = `\`--min-similarity <n>\` (default \`${DefaultMinSimilarity}\`)`;
  for (const label of [LINT_SKILL, LINT_CHECKS]) {
    assert.ok(
      proseFor(label).includes(similarity),
      `${label}: must state the similarity default as ${similarity}`,
    );
  }

  // stale-synthesis's age, check.ts.
  assert.ok(
    proseFor(LINT_SKILL).includes(`> ${StaleSynthesisDays} days old`),
    `${LINT_SKILL}: must state the stale age as ${StaleSynthesisDays} days`,
  );
  assert.ok(
    proseFor(LINT_CHECKS).includes(`more than ${StaleSynthesisDays} days old`),
    `${LINT_CHECKS}: must state the stale age as ${StaleSynthesisDays} days`,
  );

  // The summary length guideline, ingest.ts.
  const summary = `≤ ~${SummaryWordGuideline} words`;
  for (const label of [
    CONVENTIONS,
    "wiki-plugin/skills/wiki-ingest/SKILL.md",
    "wiki-plugin/skills/wiki-ask/SKILL.md",
    LINT_SKILL,
  ]) {
    assert.ok(
      proseFor(label).includes(summary),
      `${label}: must state the summary guideline as "${summary}"`,
    );
  }

  // The percent-encode charset, wikipage.ts.
  const charset = [...EncodeChars]
    .map((ch) => (ch === " " ? "space" : `\`${ch}\``))
    .join(", ");
  assert.ok(
    proseFor(CONVENTIONS).includes(`encode ${charset};`),
    `${CONVENTIONS}: must list the encode set as "encode ${charset};"`,
  );
});
