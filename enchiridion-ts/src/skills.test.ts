/**
 * Structural checks over the shipped skill tree, guarding the packaging contract
 * ADR-0026 makes load-bearing: `npx skills add` requires a non-empty `name` and
 * `description` and installs into a directory named after frontmatter `name`;
 * `cut-release` needs a real boolean `metadata.internal: true`, since the
 * installer ignores a quoted string.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { CHECKS, FIXES } from "./check.js";

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

/** Every markdown file the plugin ships as agent directions: each skill's
 * `SKILL.md`, its `reference/` files, and the subagent briefs. */
function pluginProse(): Array<{ label: string; text: string }> {
  const docs: Array<{ label: string; text: string }> = [];
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

/** `check <slug> --json` — the one shape that tracks the CLI spelling, shared
 * by the guard and the run-block test. */
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

test("wiki-lint's run block runs every CHECKS key, exactly once", () => {
  const text = readFileSync(
    path.join(skillsDir, "wiki-lint", "SKILL.md"),
    "utf8",
  );
  const listed = [...text.matchAll(CHECK_COMMAND)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    listed,
    Object.keys(CHECKS).sort(),
    "wiki-lint/SKILL.md must run every CHECKS key, by slug, exactly once",
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
