# Python shim for the `enchiridion` script layer

This project does not ship a Python wrapper (`scripts/enchiridion.py`) around
the bundled `enchiridion.cjs`, and will not add one.

## Why this is out of scope

**The Python layer was deleted on purpose.** Commit `5a64ec2` — *"Port the last
three script CLIs, then delete the Python layer"*
([#186](https://github.com/dhague/wiki-knowledge/issues/186)) — moved the last
subcommands off Python, and
[ADR-0017](../../docs/adr/0017-bundled-typescript-on-installed-interpreter.md)
fixed the distribution shape that replaced it: one esbuild bundle
(`cli.cjs` + `node-sqlite3-wasm.wasm`) run on an already-installed interpreter.
No `*.py` is tracked and there is no `pyproject.toml`; the `.venv/` and
`__pycache__/` still on disk are gitignored debris from before the port.

**It would add a third runtime.**
[ADR-0026](../../docs/adr/0026-host-neutral-skill-package.md) states the rule a
wrapper would have to break:

> The runtime is resolved the same way: `node` where it exists, `bun` where it
> does not.

Every install surface — the Claude Code plugin, an `npx skills add` package,
DSH, Joule — guarantees Node or Bun. None guarantees Python, and the spelling
differs where it does exist (`python3` on POSIX, `python` or the Store alias on
Windows).

**It does not solve the problems it was filed against.** The three stated
motivations, checked against the code:

- *"Breaks on Windows — `command -v` does not exist in `cmd.exe` or PowerShell."*
  True, and tracked at
  [#535](https://github.com/dhague/wiki-knowledge/issues/535) (validate the
  `.cmd` shim, decide the pwsh invocation branch). The wrapper only moves the
  lookup into `shutil.which` and trades one runtime prerequisite for another.
- *"Requires quoting the full absolute path."* Unchanged. An agent still has to
  resolve `<this skill's base directory>` to reach `scripts/enchiridion.py` at
  all; the path resolution moves, it does not disappear.
- *"Produces raw newline-delimited JSON that each call site must parse."*
  That is the documented `--json` contract
  ([`reference/scripts.md`](../../wiki-plugin/skills/wiki-conventions/reference/scripts.md)),
  and a Python helper only helps a caller already writing Python. No shipped
  host runs the skills from Python — they run on the session model and shell out.

**The proposed helper is also wrong for most of the catalogue.** Its `_run`
parses stdout as JSON Lines into `list[dict]`. That is right for `search` and
`superseded-by` and wrong for the rest: `read-page --json` is one object,
`vault kinds` and `export --candidates` are one array on one line, `ingest`
prints a commit SHA followed by a non-JSON cost summary, and `page set --json`
means *input*, not output. A general wrapper would have to re-encode the whole
output contract, which is exactly the duplication the bundle exists to avoid.

## What would actually fix the cited friction

- **Windows invocation**: [#535](https://github.com/dhague/wiki-knowledge/issues/535)
  owns the pwsh branch and the `.cmd` shim.
- **Boilerplate duplication**: the `RUNTIME=$(command -v node || command -v bun)`
  paragraph is carried byte-identically by nine skill files and pinned by
  `SHARED_INVOCATION` in
  [`enchiridion-ts/src/skills.test.ts`](../../enchiridion-ts/src/skills.test.ts).
  A shim in `wiki-ask` alone would break the uniformity ADR-0026 accepts. If the
  duplication is the pain, shrink the paragraph in one place, not per language.

If a concrete Python-based consumer ever appears — a host whose only tool is
Python, or an external program embedding the plugin — that is a new request with
a named beneficiary, and it reopens this on its merits rather than on the
boilerplate argument above.

## Prior requests

- [#638](https://github.com/dhague/wiki-knowledge/issues/638): "Add Python shim
  for enchiridion.cjs to simplify agent invocation"
