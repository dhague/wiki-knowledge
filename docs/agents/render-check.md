# Render Checks

A **render check** is looking at what generated HTML actually draws — a real browser, a real viewport — instead of inferring it from markup. Reach for one when a ticket's acceptance criteria are visual (is the frontmatter table legible, is the nav actually sticky, does anything overflow at phone width) and when a CSS change can only be judged by eye.

## The toolchain

The `chrome-devtools` MCP server (Chrome DevTools MCP) drives a real Chrome. Two things gate it before it will run at all:

- **The server is configured in `.mcp.json` at the repo root**, alongside the pyright server. It is gitignored, so each checkout has its own copy — the one in a worktree is not the one in the main checkout. A project-scoped server also needs approving once per project, which is a prompt only the user can answer: `claude mcp list` reports `⏸ Pending approval` until then, and no amount of editing `.mcp.json` gets past it.
- **Chrome is installed system-wide, not downloaded.** WSL ships without a graphical browser, so:

  ```
  sudo apt install -y curl gnupg
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    | sudo tee /etc/apt/sources.list.d/google-chrome.list
  sudo apt update && sudo apt install -y google-chrome-stable
  ```

  The package is not in Ubuntu's own archive, which is why it needs the repository first, and it pulls in the shared libraries Chrome needs (`libnss3`, `libasound2`, …). The config names the result at `/opt/google/chrome/chrome` and runs it `--isolated`, on a throwaway profile, so the user's own Chrome data is untouched.

A session that has not restarted since the server was added has no `chrome-devtools` tools: MCP servers load at session start.

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

- **Direct `chrome` CLI invocation is diagnostic only.** It needs `--headless --disable-gpu --no-sandbox --hide-scrollbars`, and it captures the *initial* viewport — a `#fragment` deep link gives you the top of the document or a blank frame, because the scroll lands after the capture. Use it to tell a broken Chrome from a broken server; use the MCP server to check a render. Its dbus, UPower and NetworkManager complaints on stderr are noise.
- **`claude mcp add -e` is variadic.** The server name goes *before* `-e`, or the name is swallowed as another env var: `claude mcp add --scope local <name> -e KEY=value -- npx …`.
- **Usage statistics are off, deliberately.** The server reports usage to Google and sends trace URLs to the CrUX API by default; the config passes `--no-usage-statistics --no-performance-crux`.

## When it breaks

- **Chrome not found** — the config pins `/opt/google/chrome/chrome`, so a missing or moved Chrome is the cause. `ls -l /opt/google/chrome/chrome` tells you which; a bare WSL that never ran the install above is the common case.
- **`error while loading shared libraries`** — the apt package's dependencies are missing or half-installed. `sudo apt install --reinstall google-chrome-stable` puts them back.

After either fix, restart the session and let `claude mcp list` print `✔ Connected` for `chrome-devtools`.
