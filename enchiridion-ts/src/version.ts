/**
 * The version `--version` prints. It is inlined at build time (esbuild's
 * `define`, build.mjs) from wiki-plugin/.claude-plugin/plugin.json — the single
 * source of truth scripts/release.sh bumps — so the shipped bundle carries the
 * version it was built from. Source runs (`tsx`, `bun test`) have no define and
 * see the fallback.
 */

declare const __ENCHIRIDION_VERSION__: string | undefined;

export const PluginVersion =
  typeof __ENCHIRIDION_VERSION__ === "string"
    ? __ENCHIRIDION_VERSION__
    : "0.0.0-dev";
