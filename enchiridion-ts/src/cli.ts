#!/usr/bin/env node
/**
 * enchiridion CLI entry point: one subcommand per capability (ADR-0017).
 *
 * `vault`, `page`, and `hook` are deliberately spelled with the nested
 * sub-subcommands CLAUDE.md documents (`vault root|move`, `page
 * get|set|merge`, `hook session-start|post-tool-use`).
 */

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import util from "node:util";
import { captureSession } from "./transcriptcapture.js";
import { formatSummary, logPath, readLog, summarize } from "./toolcallstats.js";
import { resolveRoot } from "./vault.js";
import { sessionStart, postToolUse } from "./hooks.js";
import { emitDocument, fail, failureMessage } from "./output.js";
import { registerPageCommands } from "./pagecommand.js";
import { registerSearchCommand } from "./searchcommand.js";
import { registerIngestCommands } from "./ingestcommand.js";
import {
  registerPlacementCommands,
  registerVaultCommand,
} from "./vaultcommand.js";
import { registerCheckFixCommands } from "./checkcommand.js";
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

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("enchiridion")
    .description(
      "Wiki-knowledge plugin script layer (TypeScript bundle — ADR-0017)",
    )
    .allowExcessArguments(true)
    .allowUnknownOption(true);

  registerSearchCommand(program);
  registerPlacementCommands(program);

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

  registerVaultCommand(program);

  registerCheckFixCommands(program);

  registerPageCommands(program);

  registerIngestCommands(program);

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

  return program;
}

/** Detect a direct CLI invocation across both execution shapes: the esbuild
 * CJS bundle (require.main === module) and the tsx/ESM source path
 * (import.meta.url vs argv[1]). */
function isMainModule(): boolean {
  if (typeof require !== "undefined" && require.main === module) return true;
  const arg = process.argv[1];
  if (arg === undefined) return false;
  return import.meta.url === pathToFileURL(path.resolve(arg)).href;
}

/** The in-process (plugin) entry. Captures stdout/stderr as data instead of
 * writing to the process streams, and overrides commander's exit so neither
 * help() nor an error can terminate the host process. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function run(argv: string[]): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram();
  program.exitOverride().configureOutput({
    writeOut: (s: string) => stdout.push(s),
    writeErr: (s: string) => stderr.push(s),
  });

  // Swap both the process streams and console for the run (console.log
  // bypasses process.stdout.write on Bun) and restore them in a finally, so
  // the host process keeps its own streams.
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const consoleLog = console.log;
  const consoleError = console.error;
  process.stdout.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    stdout.push(util.format(...args) + "\n");
  };
  console.error = (...args: unknown[]) => {
    stderr.push(util.format(...args) + "\n");
  };

  try {
    // Bare invocation: usage to stdout, exit 0. Under exitOverride help()
    // writes to the captured streams and throws a CommanderError with
    // exitCode 0 instead of process.exit(0).
    if (argv.length === 0) {
      try {
        program.help();
      } catch {
        /* CommanderError with exitCode 0 — swallowed */
      }
      return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: 0 };
    }

    try {
      await program.parseAsync([process.execPath, "enchiridion", ...argv]);
    } catch (err) {
      // CommanderError (help/version/exit) — its .exitCode is the outcome.
      if (err && typeof err === "object" && "exitCode" in err) {
        return {
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          exitCode: (err as { exitCode: number }).exitCode,
        };
      }
      // An action handler failed — `fail`, or an error commander rejected
      // parseAsync with rather than wrapping in a CommanderError. Render it as
      // main() does: message on stderr, exit 1, as data rather than an exit.
      stderr.push(failureMessage(err));
      return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: 1 };
    }
    // Read a leaked process.exitCode so it is reported rather than swallowed,
    // but never leave it set on the host process.
    const exitCode = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    console.log = consoleLog;
    console.error = consoleError;
  }
}

function main(): void {
  const program = buildProgram();
  if (process.argv.slice(2).length === 0) {
    // Commander would treat bare invocation as a missing subcommand (help to
    // stderr, exit 1); match the established usage-to-stdout, exit-0 behaviour
    // instead.
    program.help();
    return;
  }
  // Render a failed command exactly as run() does: message on stderr, exit 1,
  // no stack trace standing in for a diagnostic.
  void program.parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(failureMessage(err));
    process.exitCode = 1;
  });
}

// Importing the module must be inert, so a host can import it and call run()
// without hijacking the process.
if (isMainModule()) {
  main();
}
