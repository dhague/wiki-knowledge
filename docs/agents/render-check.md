# Render Checks

A **render check** is looking at what generated HTML actually draws — a real browser, a real viewport — instead of inferring it from markup. Reach for one when a ticket's acceptance criteria are visual (is the frontmatter table legible, is the nav actually sticky, does anything overflow at phone width) and when a CSS change can only be judged by eye.

## The toolchain

The `chrome-devtools` MCP server (Chrome DevTools MCP) drives a real Chrome. Three things sit where you would not look for them:

- **The server is local scope, not `.mcp.json`.** Its config lives in `~/.claude.json` under `projects["/home/dhague/Code/enchiridion"].mcpServers`. The repo's `.mcp.json` holds only the pyright server, so a grep there finds nothing. It is registered for the main checkout alone and is never committed.
- **Chrome is Chrome for Testing.** `/home/dhague/.cache/puppeteer/chrome/linux-153.0.8010.47/chrome-linux64/chrome`. This WSL image has no system Chrome and no Windows-side one.
- **Its shared libraries are unpacked in user space.** WSL ships without the `libnss3`, `libnspr4` and `libasound2t64` packages, and installing them wants a password. They were fetched with `apt-get download` and unpacked with `dpkg -x` into `/home/dhague/.local/share/chrome-deps/`, surfaced to the server via `LD_LIBRARY_PATH` in its env.

The toolchain is per-machine and per-checkout. A session that has not restarted since the server was added has no `chrome-devtools` tools: MCP servers load at session start.

## The workflow

1. **Export to a scratch directory.** From `enchiridion-ts/`:

   ```
   WIKI_ROOT=<vault root> npx tsx src/cli.ts export --out /tmp/check --force --allow-dirty
   ```

   From source, not through the `enchiridion` shim: a render check is usually verifying work you have just changed, and the shim runs the committed bundle. `--out` names a directory outside the vault and the source tree — the vault's `web/` belongs to the user, and the source tree must stay clean. `--allow-dirty` because the dogfooding vault usually has uncommitted pages.

2. **Open the page, then keep its `pageId`.** Only `new_page` and `list_pages` work without one; the other 27 tools all require it, and there is no default. Call `new_page` with a URL, or `list_pages` and read the id off the line marked `[selected]` — the format is `2: Page Title (file:///…) [selected]`.

3. **Size the viewport to the case under test.** `resize_page` with `{ width: 390, height: 700 }` is a phone; a render check that only ever runs at desktop width misses the mobile criteria that motivated it.

4. **Screenshot and read it.** `take_screenshot` returns the image in the tool result, at any scroll position.

## Measure, don't squint

A screenshot shows a state; `evaluate_script` shows a fact. When the claim is about geometry or computed style, assert it rather than eyeballing it — a sticky nav is proved by its own numbers, and the proof survives review:

```js
() => {
  const nav = document.querySelector("nav.wiki-nav");
  const r = nav.getBoundingClientRect();
  return JSON.stringify({
    scrollY: window.scrollY,
    navTop: r.top,                                 // 0 == pinned to the viewport
    navPosition: getComputedStyle(nav).position,   // "sticky"
  });
}
```

Scroll first (`window.scrollTo(0, 4000)`), then read the box. That is the difference between "the nav looks pinned" and "at `scrollY: 946` the nav's top edge is at 0".

## Gotchas

- **Direct `chrome` CLI invocation is diagnostic only.** It needs `LD_LIBRARY_PATH` from the deps directory plus `--headless --disable-gpu --no-sandbox --hide-scrollbars`, and it captures the *initial* viewport — a `#fragment` deep link gives you the top of the document or a blank frame, because the scroll lands after the capture. Use it to tell a broken Chrome from a broken server; use the MCP server to check a render. Its dbus, UPower and NetworkManager complaints on stderr are noise.
- **`claude mcp add -e` is variadic.** The server name goes *before* `-e`, or the name is swallowed as another env var: `claude mcp add --scope local <name> -e KEY=value -- npx …`.
- **Usage statistics are off, deliberately.** The server reports usage to Google and sends trace URLs to the CrUX API by default; the config passes `--no-usage-statistics --no-performance-crux`. `--isolated` keeps it on a throwaway profile so the user's real Chrome data is untouched.

## When it breaks

Both failures land as the server failing to start, and both are quick to fix.

- **Chrome not found** — the browser version directory is pinned in `--executablePath`, so a Chrome update orphans it. Re-point it at the version that exists: `ls /home/dhague/.cache/puppeteer/chrome/`, then `claude mcp remove --scope local chrome-devtools` and re-add (see the `-e` gotcha above).
- **`error while loading shared libraries`** — the user-space libraries are gone or incomplete. Check `ldd <chrome> | grep "not found"`, then re-run the `apt-get download` + `dpkg -x` pair into `/home/dhague/.local/share/chrome-deps/`. Note that `dpkg -x` does not create the `libasound.so.2 → libasound.so.2.0.0` symlink that `ldconfig` would; create it by hand.

After either fix, `claude mcp list` prints `✔ Connected` for `chrome-devtools` when the server is healthy again.
