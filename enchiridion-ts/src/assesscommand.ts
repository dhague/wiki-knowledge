/**
 * The cluster-assessment command: `assess`, the read-only input to a
 * Consolidation recommendation. One JSON document — a HEAD and every member's
 * full text — so the `wiki-lint` procedure judges bodies, not summaries.
 */

import type { Command } from "commander";
import { assessCluster, ErrAssess } from "./assess.js";
import { resolveRoot } from "./vault.js";
import { emitDocument, fail } from "./output.js";

export function registerAssessCommand(program: Command): void {
  program
    .command("assess")
    .argument("<page_ref...>", "the candidate cluster's member pages")
    .description(
      "Read every member in full from one committed HEAD snapshot: {head, members: [{page_ref, blob_oid, fingerprint, title, bytes, text}]}",
    )
    .action(async (refs: string[]) => {
      const root = resolveRoot();
      try {
        emitDocument(await assessCluster(root, refs));
      } catch (err) {
        if (err instanceof ErrAssess) fail(err.message);
        throw err;
      }
    });
}
