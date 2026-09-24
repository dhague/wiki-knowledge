# The `skills` CLI (skills.sh / vercel-labs/skills): ecosystem facts

Researched against primary sources: the repo README and TypeScript source at `github.com/vercel-labs/skills` (main), the CLI reference at skills.sh/docs, the spec at agentskills.io, and Vercel docs. Claims marked **[doc]** are documented; **[src]** are read from the CLI's source; **[inferred]** is my reading. Versions seen while researching: `skills` README advertises "Supports **OpenCode**, **Claude Code**, **Codex**, **Cursor**, and 75 more"; local `skills-lock.json` in this repo is schema version 1.

## 1. Install targets and per-host directories

`skills add` writes each skill to `<agentSkillsDir>/<skill-name>/`. The authoritative table is the repo README's generated "Supported Agents" list **[doc]**, and the same mapping is hard-coded in `src/agents.ts` as `skillsDir` (project) / `globalSkillsDir` **[src]**. Selected rows:

| Agent (`--agent`) | Project path | Global path |
|---|---|---|
| Claude Code `claude-code` | `.claude/skills/` | `~/.claude/skills/` (honours `CLAUDE_CONFIG_DIR`) |
| OpenCode `opencode` | `.agents/skills/` | `~/.config/opencode/skills/` |
| Codex `codex` | `.agents/skills/` | `~/.codex/skills/` (honours `CODEX_HOME`) |
| Cursor `cursor` | `.agents/skills/` | `~/.cursor/skills/` |
| GitHub Copilot `github-copilot` | `.agents/skills/` | `~/.copilot/skills/` |
| OpenClaw `openclaw` | `skills/` | `~/.openclaw/skills/` |
| Universal `universal` | `.agents/skills/` | `~/.config/agents/skills/` |

Two things to note:

- **OpenCode is supported, but not at `.opencode/skill`.** Its project install target is the shared canonical `.agents/skills/`. OpenCode is listed among the "universal" agents that natively read `.agents/skills/` and need no symlink **[doc]** (`src/agents.ts`: `skillsDir: '.agents/skills'`) **[src]**. There is no `.opencode/skills` entry in the supported-agents table; `.opencode/skills` appears only in the CLI's *discovery* scan list.
- **"DeepSeek Harness" / "DeepSeek" is absent.** No display name or `--agent` key contains "DeepSeek"; the only near match is **Deep Agents** (`deepagents`, Path `.agents/skills/`, global `~/.deepagents/agent/skills/`), which is a different product **[doc][src]**. So DSH is not an install target. The nearest route is `-a universal` (or any universal agent), which installs to `.agents/skills/` — **[inferred]** that works for DSH only if DSH reads that directory.

Install mechanics **[src]**: the default is *symlink* mode — the skill is copied once to the canonical `.agents/skills/<name>` and symlinked into each agent-specific dir. `--copy` copies directly to each agent dir instead. If only one unique target directory is selected, the CLI silently uses `copy` (a symlink would be pointless); `-y` with multiple dirs also skips the symlink/copy prompt in favour of the default. A failed symlink (Windows without Developer Mode) falls back to copy with a warning.

## 2. Discovery: arbitrary paths, not just `skills/<name>/SKILL.md`

Discovery is a bounded walk, not a fixed convention **[src]** (`src/skills.ts`):

1. If the search root itself has `SKILL.md`, that root skill is used (and it returns immediately unless `--full-depth`).
2. Otherwise it walks, in priority order: the search path, `skills/`, `skills/.curated/`, `skills/.experimental/`, `skills/.system/`, then every known agent skill dir (`.agents/skills`, `.claude/skills`, `.opencode/skills`, …). These *container* dirs are walked up to three levels (`DEFAULT_SKILL_CONTAINER_DEPTH`) so `skills/<category>/<name>/SKILL.md` and one more category level both work. A `SKILL.md` found at a shallower level shadows anything nested below it. A repo root `SKILL.md` is depth-1 only.
3. Directories declared in plugin manifests are appended at depth 1.
4. If nothing was found, **or** `--full-depth` was passed, it recursively scans the whole tree (max depth 5, skipping `node_modules`, `.git`, `dist`, `build`, `__pycache__`).

So `wiki-plugin/skills/<name>/SKILL.md` is found by the fallback recursive scan even without a manifest, but it is *not* in the priority list — treat it as fallback behaviour rather than a guaranteed convention. Several skill directories per repo are fine: discovery collects all of them (it dedupes by skill `name`, first one wins unless the caller asks for duplicates).

Enumeration conventions the CLI does read **[doc][src]**:

- `.claude-plugin/marketplace.json` — multi-plugin catalog; `metadata.pluginRoot` (must start with `./`) plus `plugins[].source` and `plugins[].skills[]` (paths must start with `./`).
- `.claude-plugin/plugin.json` — single plugin with a `skills[]` array.
- Manifest-declared skill paths are searched at their declared depth, not subject to the depth-3 cap.
- There is **no `skills.json`** convention, and no glob-based enumeration beyond the directory walk above. A concurrency/skill slug also enables `owner/repo@skill-name` and `.../tree/main/skills/foo` source forms.

`skills add <source> --list` (alias `-l`) prints "Available Skills" — each skill's install name and description, plus a file count for multi-file skills — and exits without installing **[doc][src]**. It does not print paths.

## 3. What gets copied

The **whole skill directory**, recursively **[doc][src]**: `installer.ts` `copyDirectory` walks `skill.path` and copies everything except a fixed exclude set — files named `metadata.json`, and directories `.git`, `__pycache__`, `__pypackages__`. `scripts/`, `references/`, `assets/` and anything else come along; symlinks are dereferenced (`cp` with `dereference: true`), permissions are preserved, and broken symlinks are warned about and skipped. Installing a skill whose `SKILL.md` sits at the repo root copies the whole root directory **[src]** (this is called out in a code comment referencing issue #1603).

Default is symlink (see §1). Flags: `--copy` (copy instead of symlink), `-g/--global`, `-a/--agent`, `-s/--skill`, `-l/--list`, `-y/--yes`, `--all` (= `--skill '*' --agent '*' -y`), `--full-depth`, `--subagent` (Eve subagents only), `--json`, `--metadata` **[doc][src]**.

## 4. Plugins and marketplaces

The `skills` repo has **no marketplace of its own**; it has *compatibility* with Claude Code plugin manifests for discovery and grouping (§2) **[doc]**. It reads manifests, never writes them; the repo README's discovery section says this "enables compatibility with the Claude Code plugin marketplace ecosystem".

`npx plugins add vercel/vercel-plugin` is a **different CLI from a different repo** — `vercel-labs/plugins`, npm package `plugins`, "Install open-plugin format plugins into agent tools" **[doc]**. It discovers `marketplace.json` / plugin roots / plugin dirs and installs via each target's native plugin system (Claude Code, Cursor, Codex, Grok Build, Kimi Code, GitHub Copilot CLI, VS Code). A *plugin* can contain skills **plus** commands, agents, rules, hooks, MCP servers and LSP servers **[doc]**. `skills add` installs skills only. They meet where a repo ships both: `vercel/vercel-plugin` carries 28 skills, 3 agents, 5 slash commands and hooks **[doc]**, and `skills add vercel/vercel-plugin` would find its skills through the same manifest conventions, but it would not install the agents/commands/hooks. So yes — one repo can serve as both a Claude Code plugin marketplace and a skills package, but the two CLIs install different things from it.

## 5. Frontmatter the CLI reads

`parseSkillMd` (`src/skills.ts`) parses YAML frontmatter with a minimal `---` parser (`src/frontmatter.ts`, deliberately no `---js` to avoid `eval`)**[src]** and **requires `name` and `description`, both non-empty strings** **[doc][src]**. Failure logs `⚠ Skipped <file> — missing required frontmatter field(s): …` and skips the file. Beyond those it reads only `metadata.internal === true` (hidden unless `INSTALL_INTERNAL_SKILLS=1`, or the skill is explicitly named). `name` is **not** validated against the directory name — the install directory is `sanitizeName(skill.name)`, lowercased and kebab-cased, so a mismatch silently renames the directory **[src]**. There is no dependency field, and no host-specific behaviour field; the CLI ignores `license`, `compatibility`, `allowed-tools`, `version`, etc. (the Eve installer copies a subset of those through, stripping unknown frontmatter)**[src]**.

The agentskills.io spec is the wider contract **[doc]**: required `name` (≤64 chars, lowercase/digits/hyphens, no leading/trailing hyphen) and `description` (≤1024 chars); optional `license`, `compatibility` (≤500 chars), `metadata` (string→string map), `allowed-tools` (space-separated string, experimental). That spec's optional dirs are `scripts/`, `references/`, `assets/` plus arbitrary extra files, and it has no harness-specific field.

## 6. Private repos, subdirectories, selection

Both are supported **[doc]**. `skills` uses whatever auth is already configured: for GitHub it tries the Git credential helper, then `gh repo clone`, then SSH; `GITHUB_TOKEN`/`GH_TOKEN` can be set explicitly. It never runs `gh auth token` or copies GH CLI credentials into the Node process. SSH URLs (`git@…`, `ssh://…`) and arbitrary HTTPS git hosts work. Subdirectory form is `https://github.com/owner/repo/tree/main/skills/web-design-guidelines`; Azure uses `?path=/skills/x&version=GBmain`. Selecting skills: `--skill a --skill b`, `--skill '*'` for all, `--all`, or `owner/repo@skill-name`; names with spaces must be quoted. Lock files deliberately preserve SSH URLs so private-repo restores keep working **[src]**.

## 7. `skills-lock.json`

Local, project-scoped lock file written to the project root by the `add` command on non-global installs **[doc][src]** (`src/local-lock.ts`). It is explicitly "meant to be checked into version control", version 1, skills sorted alphabetically to minimise merge conflicts, and timestamp-free by design. Per entry: `source`, optional `sourceUrl` (only for generic git/GitLab), `ref`, `sourceType`, optional `skillPath` (path to the skill's `SKILL.md` in the source repo — required for updating just that skill), `computedHash` (SHA-256 over all files in the installed skill folder, path included so renames are detected), and optional `subagents`/`wellKnownDigest`. `skills install` re-installs everything from this lock into `.agents/skills/`. The **global** lock is a separate file at `~/.agents/.skill-lock.json` (schema version 3) with `skillFolderHash` from the GitHub tree SHA, plus `dismissed` and `lastSelectedAgents` **[doc]**. This repo's own `skills-lock.json` is a live example (20 mattpocock/skills entries with `skillPath` like `skills/engineering/tdd/SKILL.md`).

## 8. `AGENTS.md` and non-skill files

Nothing in the agentskills.io specification, the skills.sh docs, or the CLI source installs or references a top-level `AGENTS.md`, hooks, agents, commands, or MCP config **[doc][src]** — `AGENTS.md` is a client-level convention, not part of the skill format. `skills add` copies exactly one skill directory per skill; a root-level `AGENTS.md` inside a repo whose `SKILL.md` is also at the root would be dragged along by the whole-directory copy, but there is no first-class mechanism. The `copyDirectory` exclude set (`metadata.json`, `.git`, `__pycache__`, `__pypackages__`) only removes; it adds nothing. For non-skill files the mechanism is the sibling `plugins` CLI, whose plugins may include skills, commands, agents, rules, hooks, MCP servers and LSP servers and translate them into each target's native format **[doc]**.

## Sources

- https://github.com/vercel-labs/skills (README, generated agent tables)
- https://raw.githubusercontent.com/vercel-labs/skills/main/src/{agents,skills,installer,local-lock,plugin-manifest,frontmatter,add}.ts
- https://skills.sh/docs/cli and https://skills.sh/docs/faq
- https://mintlify.wiki/vercel-labs/skills/{guides/supported-agents,advanced/lock-files,advanced/plugin-manifests,commands/add} (the repo's published docs site)
- https://agentskills.io/specification and https://agentskills.io/skill-creation/using-scripts
- https://vercel.com/docs/agent-resources/vercel-plugin and https://vercel.com/docs/agent-resources/vercel-plugin.graph.md
- https://app.unpkg.com/plugins@1.3.4/files/README.md (the separate `plugins` CLI, vercel-labs/plugins)
- https://vercel.com/changelog/skills-v1-1-1-interactive-discovery-open-source-release-and-agent-support (Vercel changelog; body is JS-rendered and not quotable as text)
