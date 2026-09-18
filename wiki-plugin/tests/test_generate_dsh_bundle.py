"""TDD for generate-dsh-bundle.py — the DSH bundle package's patch, generated
from the canonical plugin sources (#530).

Tests the pure seams (frontmatter split, the preload rewrite, agent -> row
translation, skill discovery, patch assembly, rendering) plus the one I/O seam
(`generate`) against a tmp plugin root, so nothing touches the real repo. Two
tests at the end run the generator against the *real* canonical sources: that is
the "stay in step with the canonical sources" contract, and it is what fails
loudly when an agent body drifts out from under the translation rules.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import pytest
from ruamel.yaml import YAML

# The production script lives at scripts/generate-dsh-bundle.py — hyphens, so
# the import system can't pick it up directly. Load it by file path, mirroring
# test_generate_opencode.py.
_HYPHEN_PATH = os.path.join(
    os.path.dirname(__file__), "..", "scripts", "generate-dsh-bundle.py",
)
_spec = importlib.util.spec_from_file_location(
    "generate_dsh_bundle", os.path.abspath(_HYPHEN_PATH),
)
assert _spec is not None and _spec.loader is not None  # the file above always exists
generate_dsh_bundle = importlib.util.module_from_spec(_spec)
sys.modules["generate_dsh_bundle"] = generate_dsh_bundle
_spec.loader.exec_module(generate_dsh_bundle)

gdb = generate_dsh_bundle

#: The real plugin checkout this test file lives in, and its committed bundle.
REAL_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
REAL_BUNDLE = REAL_PLUGIN_ROOT / "wiring" / "dsh"

#: The verified-against record a throwaway bundle carries. Shapes the rendering
#: tests; the real record is asserted directly at the end.
TEST_VERIFIED = "0.1.5-rc.2"


# ---------------------------------------------------------------------------
# fixtures — canonical Claude Code agent text and a throwaway plugin root
# ---------------------------------------------------------------------------


INGEST_CC = """---
name: wiki-ingest
description: Turns one raw document into one or more well-formed wiki pages.
model: sonnet
tools: Read, Write, Bash
skills: [wiki-conventions, wiki-ingest]
---

`wiki-ingest` agent. Turn it into schema-valid `wiki/` pages per `wiki-ingest` skill procedure preloaded above — consult `wiki-conventions` for gaps.
"""

LINTER_CC = """---
name: wiki-linter
description: Scans a vault for structural and retrievability problems.
model: haiku
tools: Read, Edit, Grep, Glob, Bash
skills: [wiki-conventions, wiki-lint]
---

`wiki-linter` agent. Run the full lint procedure from the `wiki-lint` skill preloaded above.
"""

RESEARCHER_CC = """---
name: wiki-researcher
description: Answers a question from the wiki vault.
model: haiku
tools: Read, Grep, Glob, Bash
skills: [wiki-conventions, wiki-ask]
---

`wiki-researcher` agent. Answer using `wiki-ask` skill preloaded above — see [#18](https://github.com/dhague/wiki-knowledge/issues/18).
"""

_AGENT_TEXT = {
    "wiki-ingest.md": INGEST_CC,
    "wiki-linter.md": LINTER_CC,
    "wiki-researcher.md": RESEARCHER_CC,
}


def _write_manifest(
    bundle_dir: Path,
    patch: str = "./cordis.patch.yml",
    verified: str | None = TEST_VERIFIED,
) -> None:
    """Write a throwaway bundle manifest; ``verified=None`` omits the record."""
    dsh: dict = {"bundle": {"patch": patch}}
    if verified is not None:
        dsh["verifiedAgainst"] = verified
    bundle_dir.mkdir(parents=True, exist_ok=True)
    (bundle_dir / "package.json").write_text(
        json.dumps({"name": "@dhague/wiki-knowledge-dsh", "dsh": dsh}),
        encoding="utf-8",
    )


def make_plugin_root(
    root: Path,
    *,
    agents: dict[str, str] | None = None,
    skills: tuple[str, ...] = ("wiki-ask", "wiki-conventions", "wiki-ingest"),
) -> Path:
    """A throwaway plugin root: the three canonical agents plus skill dirs."""
    (root / "agents").mkdir(parents=True, exist_ok=True)
    for filename, text in (agents or _AGENT_TEXT).items():
        (root / "agents" / filename).write_text(text, encoding="utf-8")
    for skill in skills:
        (root / "skills" / skill).mkdir(parents=True, exist_ok=True)
        (root / "skills" / skill / "SKILL.md").write_text(
            f"---\nname: {skill}\ndescription: {skill}.\n---\n\nbody\n",
            encoding="utf-8",
        )
    return root


def make_bundle(root: Path, name: str = "bundle") -> Path:
    bundle = root / name
    _write_manifest(bundle)
    return bundle


@pytest.fixture
def plugin_root(tmp_path: Path) -> Path:
    return make_plugin_root(tmp_path / "plugin")


def parse_patch(text: str) -> list[dict]:
    """Parse generated patch text back into plain data."""
    return YAML(typ="safe").load(text)


def load_patch(path: Path) -> list[dict]:
    """Parse a generated patch file back into plain data."""
    return parse_patch(path.read_text(encoding="utf-8"))


def rows(patch: list[dict]) -> list[dict]:
    assert len(patch) == 1, "the patch must be one insert entry"
    return patch[0]["insert"]


# ---------------------------------------------------------------------------
# seam 1 — split_frontmatter: CC md -> (yaml, body)
# ---------------------------------------------------------------------------


def test_split_frontmatter_splits_yaml_block_and_body():
    yaml_text, body = gdb.split_frontmatter(INGEST_CC)
    assert "name: wiki-ingest" in yaml_text
    assert "tools: Read, Write, Bash" in yaml_text
    assert body.startswith("\n`wiki-ingest` agent.")
    assert body.endswith("consult `wiki-conventions` for gaps.\n")


def test_split_frontmatter_rejects_a_file_with_no_block():
    with pytest.raises(ValueError, match="no YAML frontmatter"):
        gdb.split_frontmatter("no frontmatter here\n")


def test_split_frontmatter_rejects_an_unterminated_block():
    with pytest.raises(ValueError, match="unterminated"):
        gdb.split_frontmatter("---\nname: x\n")


# ---------------------------------------------------------------------------
# seam 2 — translate_body: the CC preload claim -> a load instruction
# ---------------------------------------------------------------------------


def test_translate_body_rewrites_a_procedure_preload_claim():
    out = gdb.translate_body("per `wiki-ingest` skill procedure preloaded above — go")
    assert out == (
        "per `wiki-ingest` skill procedure — load the `wiki-ingest` skill and "
        "follow its procedure — go"
    )


def test_translate_body_rewrites_a_bare_preload_claim():
    out = gdb.translate_body("from the `wiki-lint` skill preloaded above — go")
    assert out == (
        "from the `wiki-lint` skill — load the `wiki-lint` skill and follow its "
        "procedure — go"
    )


def test_translate_body_leaves_everything_else_verbatim():
    text = "Read `reference/x.md`. Consult `wiki-conventions` for gaps.\n"
    assert gdb.translate_body(text) == text


# ---------------------------------------------------------------------------
# seam 3 — agent_row: one canonical agent -> one dsh-tool-subagent row
# ---------------------------------------------------------------------------


def _row_for(text: str) -> dict:
    yaml_text, body = gdb.split_frontmatter(text)
    return gdb.agent_row(gdb.parse_frontmatter(yaml_text), body)


def test_agent_row_maps_cc_tools_onto_dsh_global_names():
    assert _row_for(INGEST_CC)["config"]["toolFilter"] == {
        "allow": ["read", "write", "bash"],
    }


def test_agent_row_omits_write_for_the_read_only_researcher():
    """`Write` is removed deliberately: only retrieval can propose a save, and
    the invoking session performs it (#18)."""
    row = _row_for(RESEARCHER_CC)
    assert "write" not in row["config"]["toolFilter"]["allow"]
    assert row["config"]["toolFilter"]["allow"] == ["read", "grep", "glob", "bash"]


def test_agent_row_namespaces_the_id_and_uses_the_agent_name_as_tool_name():
    row = _row_for(INGEST_CC)
    assert row["id"] == "wiki-knowledge-agent-wiki-ingest"
    assert row["config"]["toolName"] == "wiki-ingest"


def test_agent_row_mounts_the_subagent_tool_package_on_the_spawn_provider():
    row = _row_for(INGEST_CC)
    assert row["name"] == "@deepseek-ai/dsh-tool-subagent"
    assert row["config"]["provider"] == "spawn"


def test_agent_row_carries_the_default_route_and_the_depth_cap():
    config = _row_for(LINTER_CC)["config"]
    assert config["agentOptions"] == {
        "provider": "deepseek-official",
        "model": "deepseek-flash",
    }
    assert config["maxDepth"] == 1


def test_agent_row_leaves_model_selection_settings_absent():
    """A standing `modelSelectionSettings` throws at the root layer, outside a
    preset Context (#529)."""
    assert "modelSelectionSettings" not in _row_for(INGEST_CC)["config"]


def test_agent_row_ignores_the_cc_model_tier():
    """Both CC tiers become the one deepseek-flash route — the tier split is
    the host's routing concern (#528)."""
    ingest = _row_for(INGEST_CC)["config"]["agentOptions"]
    linter = _row_for(LINTER_CC)["config"]["agentOptions"]
    assert ingest == linter == {"provider": "deepseek-official", "model": "deepseek-flash"}


def test_agent_row_persona_is_the_translated_body():
    config = _row_for(INGEST_CC)["config"]
    assert "preloaded above" not in config["persona"]
    assert "load the `wiki-ingest` skill and follow its procedure" in config["persona"]
    assert config["persona"].startswith("`wiki-ingest` agent.")
    assert not config["persona"].endswith("\n")


def test_agent_row_rejects_an_unmapped_cc_tool():
    frontmatter = {"name": "wiki-x", "tools": "Read, Teleport"}
    with pytest.raises(gdb.GenerationError, match="no DSH global tool name for CC tool 'Teleport'"):
        gdb.agent_row(frontmatter, "body")


def test_agent_row_rejects_a_missing_name():
    with pytest.raises(gdb.GenerationError, match="carries no name"):
        gdb.agent_row({"tools": "Read"}, "body")


def test_agent_row_rejects_missing_tools():
    with pytest.raises(gdb.GenerationError, match="no tools in frontmatter"):
        gdb.agent_row({"name": "wiki-x"}, "body")


# ---------------------------------------------------------------------------
# seam 4 — the skill provider row and skill discovery
# ---------------------------------------------------------------------------


def test_skill_provider_row_points_at_the_plugin_skills_directory(tmp_path: Path):
    row = gdb.skill_provider_row(tmp_path / "plugin")
    assert row["id"] == "wiki-knowledge-skill-filesystem"
    assert row["name"] == "@deepseek-ai/dsh-skill-filesystem"
    assert row["config"]["providerName"] == "wiki-knowledge"
    assert row["config"]["customSkillDirs"] == [str(tmp_path / "plugin" / "skills")]


def test_discover_skills_reads_names_from_the_tree_sorted(plugin_root: Path):
    assert gdb.discover_skills(plugin_root / "skills") == [
        "wiki-ask", "wiki-conventions", "wiki-ingest",
    ]


def test_discover_skills_ignores_a_directory_with_no_skill_md(plugin_root: Path):
    (plugin_root / "skills" / "not-a-skill").mkdir()
    assert gdb.discover_skills(plugin_root / "skills") == [
        "wiki-ask", "wiki-conventions", "wiki-ingest",
    ]


def test_discover_skills_rejects_a_missing_directory(tmp_path: Path):
    with pytest.raises(gdb.GenerationError, match="skills directory not found"):
        gdb.discover_skills(tmp_path / "nope")


def test_discover_skills_rejects_an_empty_directory(tmp_path: Path):
    (tmp_path / "skills").mkdir()
    with pytest.raises(gdb.GenerationError, match="no <name>/SKILL.md found"):
        gdb.discover_skills(tmp_path / "skills")


# ---------------------------------------------------------------------------
# seam 5 — build_patch / render_patch
# ---------------------------------------------------------------------------


def test_build_patch_is_one_insert_with_the_skill_row_first(tmp_path: Path):
    agents = [
        (gdb.parse_frontmatter(gdb.split_frontmatter(_AGENT_TEXT[name])[0]),
         gdb.split_frontmatter(_AGENT_TEXT[name])[1])
        for name in gdb.CANONICAL_AGENTS
    ]
    patch = gdb.build_patch(tmp_path, agents)
    assert len(patch) == 1
    inserted = patch[0]["insert"]
    assert [row["id"] for row in inserted] == [
        "wiki-knowledge-skill-filesystem",
        "wiki-knowledge-agent-wiki-ingest",
        "wiki-knowledge-agent-wiki-linter",
        "wiki-knowledge-agent-wiki-researcher",
    ]


def test_render_patch_banner_names_the_root_the_skills_and_the_marker(tmp_path: Path):
    text = gdb.render_patch([], tmp_path, ["wiki-ask"], TEST_VERIFIED)
    assert text.startswith(f"# {gdb.GENERATED_MARKER} — DO NOT EDIT BY HAND.\n")
    assert f"# Plugin root: {tmp_path}\n" in text
    assert "# Skills discovered: wiki-ask\n" in text
    assert f"# Verified against: {gdb.DSH_PACKAGE} {TEST_VERIFIED}\n" in text
    assert gdb.DSH_REVERIFY_URL in text


def test_render_patch_never_folds_a_long_persona(tmp_path: Path):
    """ADR-0024's posture: emitted lines are not folded."""
    long_line = "x" * 3000
    row = {"id": "a", "name": "b", "config": {"persona": long_line}}
    text = gdb.render_patch([{"insert": [row]}], tmp_path, ["s"], TEST_VERIFIED)
    assert long_line in text


def test_render_patch_opens_the_top_level_sequence_at_column_zero(tmp_path: Path):
    """`- insert:` at column 0, the shape DSH's own bundle patches are written
    in — not a root sequence indented by the emitter's offset."""
    row = [{"insert": [{"id": "a", "config": {"customSkillDirs": ["/p/skills"]}}]}]
    body = [line for line in gdb.render_patch(row, tmp_path, ["s"], TEST_VERIFIED).splitlines()
            if line and not line.startswith("#")]
    assert body[0] == "- insert:"
    assert body[1] == "    - id: a"
    assert body[-1] == "          - /p/skills"


def test_render_patch_emits_a_multi_line_scalar_as_a_block_scalar(tmp_path: Path):
    patch = [{"insert": [{"id": "a", "config": {"persona": "first line\n\nsecond line"}}]}]
    text = gdb.render_patch(patch, tmp_path, ["s"], TEST_VERIFIED)
    assert "persona: |-" in text
    assert "          first line\n\n          second line\n" in text
    assert "\\n" not in text


def test_render_patch_round_trips_awkward_personas(tmp_path: Path):
    """A literal block cannot hold every string; whatever ruamel falls back to
    must still parse back to the same value."""
    for persona in (
        "a line with a trailing space \nsecond",
        "  leading space\nsecond",
        "trailing newline\n",
        "plain single line",
    ):
        text = gdb.render_patch(
            [{"insert": [{"id": "a", "config": {"persona": persona}}]}], tmp_path, ["s"],
            TEST_VERIFIED,
        )
        assert parse_patch(text)[0]["insert"][0]["config"]["persona"] == persona


# ---------------------------------------------------------------------------
# seam 6 — generate: the I/O seam
# ---------------------------------------------------------------------------


def test_generate_writes_a_parseable_patch_with_four_rows(plugin_root: Path):
    bundle = make_bundle(plugin_root)
    written = gdb.generate(plugin_root, bundle)
    assert written == [bundle.resolve() / "cordis.patch.yml"]

    patch = load_patch(bundle / "cordis.patch.yml")
    inserted = rows(patch)
    assert len(inserted) == 4
    assert inserted[0]["config"]["customSkillDirs"] == [
        str(plugin_root.resolve() / "skills"),
    ]
    assert {row["config"]["toolName"] for row in inserted[1:]} == {
        "wiki-ingest", "wiki-linter", "wiki-researcher",
    }


def test_generate_is_idempotent(plugin_root: Path):
    bundle = make_bundle(plugin_root)
    gdb.generate(plugin_root, bundle)
    first = (bundle / "cordis.patch.yml").read_bytes()
    gdb.generate(plugin_root, bundle)
    assert (bundle / "cordis.patch.yml").read_bytes() == first


def test_generate_bakes_an_absolute_root_for_a_relative_argument(
    plugin_root: Path, monkeypatch: pytest.MonkeyPatch,
):
    make_bundle(plugin_root)
    monkeypatch.chdir(plugin_root)
    assert gdb.main(
        ["--plugin-root", ".", "--bundle", "bundle", "--dsh-version", TEST_VERIFIED],
    ) == 0
    patch = load_patch(plugin_root / "bundle" / "cordis.patch.yml")
    root = rows(patch)[0]["config"]["customSkillDirs"][0]
    assert Path(root).is_absolute()
    assert root == str(plugin_root.resolve() / "skills")


def test_generate_survives_a_plugin_root_containing_a_space(tmp_path: Path):
    root = make_plugin_root(tmp_path / "plugin root")
    bundle = make_bundle(root)
    gdb.generate(root, bundle)
    patch = load_patch(bundle / "cordis.patch.yml")
    assert rows(patch)[0]["config"]["customSkillDirs"] == [str(root.resolve() / "skills")]


def test_generate_resolves_a_symlinked_plugin_root(tmp_path: Path):
    real = make_plugin_root(tmp_path / "real")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    bundle = make_bundle(link)
    gdb.generate(link, bundle)
    patch = load_patch(bundle / "cordis.patch.yml")
    assert rows(patch)[0]["config"]["customSkillDirs"] == [str(real.resolve() / "skills")]


def test_generate_refuses_to_clobber_a_file_it_did_not_write(plugin_root: Path):
    bundle = make_bundle(plugin_root)
    hand_written = bundle / "cordis.patch.yml"
    hand_written.write_text("# mine\n[]\n", encoding="utf-8")
    with pytest.raises(gdb.GenerationError, match="was not generated by this script"):
        gdb.generate(plugin_root, bundle)
    assert hand_written.read_text(encoding="utf-8") == "# mine\n[]\n"


def test_generate_overwrites_its_own_previous_output(plugin_root: Path):
    bundle = make_bundle(plugin_root)
    gdb.generate(plugin_root, bundle)
    (bundle / "cordis.patch.yml").write_text(
        f"# {gdb.GENERATED_MARKER} — DO NOT EDIT BY HAND.\n# stale\n[]\n",
        encoding="utf-8",
    )
    gdb.generate(plugin_root, bundle)
    assert len(rows(load_patch(bundle / "cordis.patch.yml"))) == 4


def test_generate_rejects_a_missing_manifest(plugin_root: Path):
    bundle = plugin_root / "bundle"  # never created
    with pytest.raises(gdb.GenerationError, match="bundle manifest not found"):
        gdb.generate(plugin_root, bundle)


def test_generate_rejects_a_manifest_that_does_not_declare_the_patch(plugin_root: Path):
    bundle = plugin_root / "bundle"
    _write_manifest(bundle, patch="./something-else.yml")
    with pytest.raises(gdb.GenerationError, match="must declare dsh.bundle.patch"):
        gdb.generate(plugin_root, bundle)


def test_generate_rejects_a_manifest_declaring_no_patch_at_all(plugin_root: Path):
    bundle = plugin_root / "bundle"
    bundle.mkdir(parents=True)
    (bundle / "package.json").write_text(json.dumps({"name": "x"}), encoding="utf-8")
    with pytest.raises(gdb.GenerationError, match="must declare dsh.bundle.patch"):
        gdb.generate(plugin_root, bundle)


def test_generate_rejects_a_malformed_manifest(plugin_root: Path):
    bundle = plugin_root / "bundle"
    bundle.mkdir(parents=True)
    (bundle / "package.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(gdb.GenerationError, match="not valid JSON"):
        gdb.generate(plugin_root, bundle)


def test_generate_rejects_a_missing_canonical_agent(plugin_root: Path):
    (plugin_root / "agents" / "wiki-linter.md").unlink()
    bundle = make_bundle(plugin_root)
    with pytest.raises(gdb.GenerationError, match="canonical agent file not found"):
        gdb.generate(plugin_root, bundle)


# ---------------------------------------------------------------------------
# seam 7 — the verified-against record, its two renderings, and the install
# warning (#537)
# ---------------------------------------------------------------------------


def test_manifest_verified_against_reads_the_committed_record(plugin_root: Path):
    bundle = make_bundle(plugin_root)
    assert gdb.manifest_verified_against(bundle) == TEST_VERIFIED


def test_manifest_verified_against_rejects_a_manifest_with_no_record(plugin_root: Path):
    bundle = plugin_root / "bundle"
    _write_manifest(bundle, verified=None)
    with pytest.raises(gdb.GenerationError, match="must record the DSH version"):
        gdb.manifest_verified_against(bundle)


def test_manifest_verified_against_rejects_a_blank_record(plugin_root: Path):
    bundle = plugin_root / "bundle"
    _write_manifest(bundle, verified="   ")
    with pytest.raises(gdb.GenerationError, match="must record the DSH version"):
        gdb.manifest_verified_against(bundle)


def test_generate_stamps_the_record_into_the_patch_banner(plugin_root: Path):
    bundle = make_bundle(plugin_root)
    gdb.generate(plugin_root, bundle)
    text = (bundle / "cordis.patch.yml").read_text(encoding="utf-8")
    assert f"# Verified against: {gdb.DSH_PACKAGE} {TEST_VERIFIED}\n" in text
    assert gdb.DSH_REVERIFY_URL in text


def test_generate_refuses_a_bundle_that_records_no_version(plugin_root: Path):
    bundle = plugin_root / "bundle"
    _write_manifest(bundle, verified=None)
    with pytest.raises(gdb.GenerationError, match="must record the DSH version"):
        gdb.generate(plugin_root, bundle)


def test_generate_accepts_a_version_it_has_never_seen(plugin_root: Path):
    """No gate (#537): an unseen version is recorded and the bundle still
    installs — refusing would turn every DSH release into a broken install."""
    bundle = plugin_root / "bundle"
    _write_manifest(bundle, verified="99.0.0-future")
    gdb.generate(plugin_root, bundle)
    assert len(rows(load_patch(bundle / "cordis.patch.yml"))) == 4


class _Completed:
    """Stand-in for ``subprocess.CompletedProcess`` at the seam we read."""

    def __init__(self, returncode: int = 0, stdout: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout


def test_installed_dsh_version_reads_the_cli(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(gdb.shutil, "which", lambda name: "/usr/bin/dsh")
    monkeypatch.setattr(gdb.subprocess, "run", lambda *a, **k: _Completed(stdout="0.1.6\n"))
    assert gdb.installed_dsh_version() == "0.1.6"


def test_installed_dsh_version_takes_the_first_line(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(gdb.shutil, "which", lambda name: "/usr/bin/dsh")
    monkeypatch.setattr(
        gdb.subprocess, "run", lambda *a, **k: _Completed(stdout="0.1.6\nnoise\n"),
    )
    assert gdb.installed_dsh_version() == "0.1.6"


def test_installed_dsh_version_is_none_without_a_dsh_on_path(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(gdb.shutil, "which", lambda name: None)
    assert gdb.installed_dsh_version() is None


def test_installed_dsh_version_is_none_when_the_cli_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(gdb.shutil, "which", lambda name: "/usr/bin/dsh")
    monkeypatch.setattr(gdb.subprocess, "run", lambda *a, **k: _Completed(returncode=1))
    assert gdb.installed_dsh_version() is None


def test_installed_dsh_version_is_none_when_the_cli_cannot_run(
    monkeypatch: pytest.MonkeyPatch,
):
    def boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("not executable")

    monkeypatch.setattr(gdb.shutil, "which", lambda name: "/usr/bin/dsh")
    monkeypatch.setattr(gdb.subprocess, "run", boom)
    assert gdb.installed_dsh_version() is None


def test_version_note_says_so_when_the_host_matches():
    note = gdb._version_note(TEST_VERIFIED, TEST_VERIFIED)
    assert f"{gdb.DSH_PACKAGE} {TEST_VERIFIED}" in note
    assert "the same version" in note
    assert gdb.DSH_REVERIFY_URL not in note


def test_version_note_points_at_the_surface_map_on_a_mismatch():
    note = gdb._version_note(TEST_VERIFIED, "0.1.6-alpha.2")
    assert "reports 0.1.6-alpha.2" in note
    assert gdb.DSH_REVERIFY_URL in note
    assert "not a gate" in note


def test_version_note_answers_an_unreadable_version_with_the_command():
    note = gdb._version_note(TEST_VERIFIED, None)
    assert "could not read `dsh --version`" in note
    assert "--dsh-version" in note
    assert "installs either way" in note


def test_main_warns_on_a_mismatch_and_still_exits_zero(
    plugin_root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
):
    make_bundle(plugin_root)
    monkeypatch.chdir(plugin_root)
    assert gdb.main([
        "--plugin-root", ".", "--bundle", "bundle", "--dsh-version", "0.1.6-alpha.2",
    ]) == 0
    out = capsys.readouterr().out
    assert f"verified against {gdb.DSH_PACKAGE} {TEST_VERIFIED}" in out
    assert "reports 0.1.6-alpha.2" in out
    assert gdb.DSH_REVERIFY_URL in out
    assert str(plugin_root / "bundle" / "cordis.patch.yml") in out


def test_main_prints_the_record_without_a_warning_when_the_version_matches(
    plugin_root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
):
    make_bundle(plugin_root)
    monkeypatch.chdir(plugin_root)
    assert gdb.main([
        "--plugin-root", ".", "--bundle", "bundle", "--dsh-version", TEST_VERIFIED,
    ]) == 0
    out = capsys.readouterr().out
    assert "the same version" in out
    assert gdb.DSH_REVERIFY_URL not in out


# ---------------------------------------------------------------------------
# the contract — the generator against the REAL canonical sources
# ---------------------------------------------------------------------------


def test_real_bundle_manifest_records_a_plausible_dsh_version():
    """The one committed copy of the record (#537). It moves only when a person
    re-walks the surface map against a new DSH, so this guards its shape."""
    recorded = gdb.manifest_verified_against(REAL_BUNDLE)
    assert re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", recorded), recorded


def test_real_canonical_sources_generate_the_four_expected_rows(tmp_path: Path):
    bundle = make_bundle(tmp_path)
    gdb.generate(REAL_PLUGIN_ROOT, bundle)
    inserted = rows(load_patch(bundle / "cordis.patch.yml"))

    assert [row["id"] for row in inserted] == [
        "wiki-knowledge-skill-filesystem",
        "wiki-knowledge-agent-wiki-ingest",
        "wiki-knowledge-agent-wiki-linter",
        "wiki-knowledge-agent-wiki-researcher",
    ]
    # The real skills/ tree, discovered rather than listed by hand.
    discovered = rows(load_patch(bundle / "cordis.patch.yml"))[0]["config"]["customSkillDirs"]
    assert discovered == [str(REAL_PLUGIN_ROOT / "skills")]
    assert sorted(p.parent.name for p in (REAL_PLUGIN_ROOT / "skills").glob("*/SKILL.md")) == [
        "save-conversation", "wiki-ask", "wiki-conventions", "wiki-export",
        "wiki-ingest", "wiki-init", "wiki-lint", "wiki-watch",
    ]


def test_no_real_agent_body_keeps_a_cc_preload_claim():
    """Every "preloaded above" claim in the real agents must be rewritten. A
    body that grows a phrasing the regex misses would otherwise ship a false
    claim into a DSH child's persona — the silent drift this test exists for."""
    for name in gdb.CANONICAL_AGENTS:
        text = (REAL_PLUGIN_ROOT / "agents" / name).read_text(encoding="utf-8")
        _yaml_text, body = gdb.split_frontmatter(text)
        translated = gdb.translate_body(body)
        assert "preloaded above" not in translated, name
        if "preloaded above" in body:
            assert "load the `wiki-" in translated, name
