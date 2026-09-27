/**
 * The export and host-session command group: `save-session`, `tool-call-stats`,
 * the `hook` events, and `export`. Three entry points keep the root help order
 * unchanged.
 */

import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { captureSession } from "./transcriptcapture.js";
import { formatSummary, logPath, readLog, summarize } from "./toolcallstats.js";
import { sessionStart, postToolUse } from "./hooks.js";
import {
  runExport,
  buildCandidates,
  vaultPageRefs,
  ExportDirtyError,
  ExportStartPageError,
  ExportTargetIsDirectoryError,
  ExportTargetNotEmptyError,
} from "./exportwriter.js";
import { SINGLE_FILE_DEFAULT_NAME } from "./exportsingle.js";
import {
  exportConfigPath,
  normalizeStartPageRef,
  saveExportStartPage,
  saveExportTitle,
} from "./exportconfig.js";
import type { StarterEntry } from "./exportmeta.js";
import { emitDocument, fail } from "./output.js";
import { resolveRoot } from "./vault.js";

export function registerSessionCommands(program: Command): void {
  // save-session — write this session's transcript as a raw file, printing its
  // vault-relative path.
  program
    .command("save-session")
    .description("Save this session's transcript as a raw file in the vault")
    .option(
      "--slug <phrase>",
      "phrase naming what this session covered; sanitized, first-save only",
    )
    .action(async (opts: { slug?: string }) => {
      const root = resolveRoot();
      const rel = await captureSession(
        root,
        opts.slug ?? "",
        "",
        undefined,
        new Date(),
      );
      console.log(rel);
    });

  // tool-call-stats — summarise one session's tool-call log.
  program
    .command("tool-call-stats")
    .description("Summarise a session's tool-call log")
    .option(
      "--session-id <id>",
      "session to summarise (default: $CLAUDE_CODE_SESSION_ID)",
    )
    .action((opts: { sessionId?: string }) => {
      let id = opts.sessionId ?? "";
      if (id === "") id = process.env.CLAUDE_CODE_SESSION_ID ?? "";
      if (id === "") {
        fail(
          "no session_id — pass --session-id or set $CLAUDE_CODE_SESSION_ID",
        );
      }
      const events = readLog(id, "");
      if (events.length === 0) {
        fail(`no log found at ${logPath(id, "")}`);
      }
      console.log(formatSummary(summarize(events)));
    });
}

export function registerHookCommands(program: Command): void {
  // hook session-start|post-tool-use — read their payload on stdin and fail
  // open (CLAUDE.md): a hook error must never interrupt the session.
  const hook = program
    .command("hook")
    .description("Handle a Claude Code hook payload read from stdin")
    .action(() => {
      // A bare or unrecognised event is an error, not commander's
      // help-and-exit-0 — a hooks.json typo must not look like it worked.
      fail(
        `hook: name the event, one of ${["session-start", "post-tool-use"].join(", ")}`,
      );
    });
  for (const action of ["session-start", "post-tool-use"] as const) {
    hook
      .command(action)
      .description("Handle the " + action + " hook event")
      .action(() => {
        // Fail open: read the payload, run the handler, and swallow every
        // error, malformed JSON on stdin included.
        try {
          const payload = JSON.parse(fs.readFileSync(0, "utf8"));
          if (action === "session-start") sessionStart(payload);
          else postToolUse(payload);
        } catch {
          // Deliberately dropped, not reported: hook stderr surfaces to the
          // user mid-session with nothing they can act on.
        }
      });
  }
}

export function registerExportCommands(program: Command): void {
  program
    .command("export")
    .description("Produce a static HTML site from the vault")
    .option(
      "--single-file",
      `write one self-contained HTML file instead of a directory tree (--out names that file, default: ${SINGLE_FILE_DEFAULT_NAME} at the vault root)`,
    )
    .option("--out <path>", "output directory, or file under --single-file")
    .option("--raw", "include raw/ section")
    .option("--force", "overwrite non-empty output directory")
    .option("--allow-dirty", "skip dirty-tree check")
    .option(
      "--title <title>",
      "wiki title for this run only (default: the saved title, else the vault directory name)",
    )
    .option(
      "--save-title <title>",
      "save the wiki title as the persistent default and exit (writes no site)",
    )
    .option(
      "--start-page <ref>",
      "vault-relative page ref to export as the site's front page for this run only (default: the saved start page, else the generated front page)",
    )
    .option(
      "--save-start-page <ref>",
      "save a page ref as the vault's persistent start page and exit (a blank ref clears it; writes no site)",
    )
    .option(
      "--candidates",
      "emit the ranked candidate list as one JSON line to stdout and exit (writes nothing)",
    )
    .option(
      "--starters <refs...>",
      "page refs (optionally as ref=annotation) for the get-started block",
    )
    .action(
      async (opts: {
        singleFile?: boolean;
        out?: string;
        raw?: boolean;
        force?: boolean;
        allowDirty?: boolean;
        title?: string;
        saveTitle?: string;
        startPage?: string;
        saveStartPage?: string;
        candidates?: boolean;
        starters?: string[];
      }) => {
        const root = resolveRoot();

        // Persist-and-exit, like --candidates: a second full export over a
        // non-empty target is not what "save" means.
        if (opts.saveTitle !== undefined) {
          try {
            saveExportTitle(root, opts.saveTitle);
          } catch (err) {
            fail(`enchiridion export: ${(err as Error).message}`);
          }
          console.log(
            `Saved wiki title "${opts.saveTitle.trim()}" to ${exportConfigPath(root)}`,
          );
          return;
        }

        // The one thing this path validates is that the ref names a page of
        // the vault; a blank ref means "no start page", not an error.
        if (opts.saveStartPage !== undefined) {
          const ref = normalizeStartPageRef(opts.saveStartPage);
          if (ref !== "" && !vaultPageRefs(root).has(ref)) {
            fail(
              `enchiridion export: --save-start-page "${ref}" does not name a page of this vault`,
            );
          }
          saveExportStartPage(root, opts.saveStartPage);
          console.log(
            ref === ""
              ? `Cleared the saved start page in ${exportConfigPath(root)}`
              : `Saved start page "${ref}" to ${exportConfigPath(root)}`,
          );
          return;
        }

        if (opts.candidates) {
          emitDocument(buildCandidates(root));
          return;
        }

        const starters: StarterEntry[] = [];
        for (const item of opts.starters ?? []) {
          const eqIdx = item.indexOf("=");
          if (eqIdx === -1) {
            starters.push({ pageRef: item });
          } else {
            starters.push({
              pageRef: item.slice(0, eqIdx),
              annotation: item.slice(eqIdx + 1),
            });
          }
        }

        // `--out` names a directory in the default mode and the output file
        // under --single-file, so the fallback default differs too.
        const outPath = opts.out
          ? path.resolve(opts.out)
          : path.join(root, opts.singleFile ? SINGLE_FILE_DEFAULT_NAME : "web");

        try {
          await runExport(root, {
            out: outPath,
            singleFile: opts.singleFile,
            raw: opts.raw,
            force: opts.force,
            allowDirty: opts.allowDirty,
            // The per-run flag, not the resolved title: runExport owns the
            // resolution order (flag → saved title → directory name).
            title: opts.title,
            // Likewise the start page: flag → saved ref → none.
            startPage: opts.startPage,
            starters,
          });
          console.log(`Exported to ${outPath}`);
        } catch (err) {
          if (
            err instanceof ExportDirtyError ||
            err instanceof ExportTargetNotEmptyError ||
            err instanceof ExportTargetIsDirectoryError ||
            err instanceof ExportStartPageError
          ) {
            fail(`enchiridion export: ${(err as Error).message}`);
          } else {
            throw err;
          }
        }
      },
    );
}
