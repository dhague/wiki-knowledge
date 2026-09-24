/**
 * Structural checks over the shipped skill tree.
 *
 * The skills are prose, so there is no behaviour to unit-test here. What this
 * guards is the packaging contract ADR-0026 makes load-bearing: `npx skills add`
 * requires a non-empty `name` and `description` and installs each skill into a
 * directory named after its frontmatter `name`, and the maintainer's own
 * `cut-release` skill must carry `metadata.internal: true` — as a real boolean,
 * because the installer compares `metadata?.internal === true` and silently
 * ignores a quoted string, which would leak the release skill into every
 * consumer install with nothing printed to explain it.
 *
 * It lives in the TypeScript suite because that is the repo's only test runner.
 * It reads the canonical tree at `wiki-plugin/skills/`, which repo-root
 * `skills/` is generated from; the two trees agreeing is a CI job of its own.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

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
  // ADR-0026: one text is installed on every host, so a host-specific spelling
  // is a portability bug rather than a style preference. `CLAUDE.md` as a vault
  // filename is deliberately not matched — only the host name is.
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
