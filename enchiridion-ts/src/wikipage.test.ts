/**
 * Tests for the wikipage module, with the two property-tested contracts
 * (page-move and frontmatter round-trip, ADR-0012) guarded by fast-check.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import path from "node:path";
// The conforming YAML reader — the oracle for what a fold means.
import { parse as parseYaml } from "yaml";
import {
  Page,
  percentEncode,
  percentDecode,
  splitDest,
  encodeDest,
  splitFrontmatter,
  iterLinks,
  linkDest,
  resolveLinkDest,
  composeLink,
  normalizeBodyLinks,
  planMove,
  planConsolidate,
  canonicalizeLinkTargets,
} from "./wikipage.js";
import type { LinkMatch } from "./wikipage.js";
// The reader that finds frontmatter links through the YAML parser rather than
// by scanning raw text — the oracle for what a move did to them (#489).
import { newPageRecord } from "./pagerecord.js";

// ---------------------------------------------------------------------------
// splitFrontmatter
// ---------------------------------------------------------------------------

describe("splitFrontmatter", () => {
  const cases = [
    {
      name: "leading block",
      text: "---\ntitle: A\n---\nbody\n",
      fm: "title: A\n",
      body: "body\n",
      present: true,
    },
    {
      name: "empty block",
      text: "---\n---\nbody\n",
      fm: "",
      body: "body\n",
      present: true,
    },
    {
      name: "no frontmatter",
      text: "body\n---\nnot metadata\n",
      fm: "",
      body: "body\n---\nnot metadata\n",
      present: false,
    },
    {
      name: "thematic break mid-document is not frontmatter",
      text: "# Title\n\n---\n\nmore\n",
      fm: "",
      body: "# Title\n\n---\n\nmore\n",
      present: false,
    },
    {
      name: "closing fence at end of file",
      text: "---\ntitle: A\n---",
      fm: "title: A\n",
      body: "",
      present: true,
    },
    {
      name: "CRLF line endings — parsed identically to LF",
      text: "---\r\ntitle: A\r\n---\r\nbody\r\n",
      fm: "title: A\r\n",
      body: "body\r\n",
      present: true,
    },
    {
      name: "CRLF with multiple frontmatter fields",
      text: '---\r\ntitle: Foo\r\nraw_source: "[f.txt](../../raw/f.txt)"\r\n---\r\nbody\r\n',
      fm: 'title: Foo\r\nraw_source: "[f.txt](../../raw/f.txt)"\r\n',
      body: "body\r\n",
      present: true,
    },
    {
      name: "CRLF closing fence at end of file",
      text: "---\r\ntitle: A\r\n---",
      fm: "title: A\r\n",
      body: "",
      present: true,
    },
  ];
  for (const tc of cases) {
    it(tc.name, () => {
      const r = splitFrontmatter(tc.text);
      assert.equal(r.hasFrontmatter, tc.present);
      assert.equal(r.frontmatter, tc.fm);
      assert.equal(r.body, tc.body);
      assert.equal(tc.text.slice(r.bodyOffset), r.body);
    });
  }
});

// ---------------------------------------------------------------------------
// PercentEncode / PercentDecode / SplitDest
// ---------------------------------------------------------------------------

describe("percentEncode", () => {
  it("encodes only the minimal charset", () => {
    const got = percentEncode("raw/Über & Co's, notes (draft) #1 <x>.md");
    const want =
      "raw/Über%20&%20Co's,%20notes%20%28draft%29%20%231%20%3Cx%3E.md";
    assert.equal(got, want);
  });
});

describe("percentDecode", () => {
  it("leaves invalid escapes verbatim", () => {
    for (const input of ["100%", "a%zz", "trailing%2"]) {
      assert.equal(percentDecode(input), input);
    }
  });

  it("round-trips any string", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        assert.equal(percentDecode(percentEncode(s)), s);
      }),
    );
  });
});

describe("splitDest", () => {
  it("splits before decoding", () => {
    // The whole point of the single decode boundary: an encoded `#` in a
    // filename must not be mistaken for an anchor separator.
    assert.deepEqual(splitDest("raw/notes%20%231.md"), {
      path: "raw/notes #1.md",
      anchor: "",
    });
    assert.deepEqual(splitDest("wiki/concepts/a.md#some%20heading"), {
      path: "wiki/concepts/a.md",
      anchor: "some heading",
    });
  });
});

describe("encodeDest", () => {
  it("keeps the anchor separator literal and a filename's hash encoded", () => {
    // The other half of the decode boundary, and the one rule both the
    // frontmatter check and its fix now go through (#492): a heading fragment
    // stays `#ttl`, never `%23ttl`, and a filename's own `#` can only be `%23`.
    assert.equal(
      encodeDest("wiki/concepts/a.md", "ttl"),
      "wiki/concepts/a.md#ttl",
    );
    assert.equal(encodeDest("raw/notes #1.md", ""), "raw/notes%20%231.md");
    assert.equal(
      encodeDest("wiki/concepts/a.md", "some heading"),
      "wiki/concepts/a.md#some%20heading",
    );
  });

  it("round-trips a well-formed destination through splitDest", () => {
    for (const dest of [
      "wiki/concepts/a.md",
      "wiki/concepts/a.md#ttl",
      "raw/notes%20%231.md",
      "wiki/concepts/a.md#some%20heading",
    ]) {
      const { path: p, anchor } = splitDest(dest);
      assert.equal(encodeDest(p, anchor), dest);
    }
  });

  it("round-trips any decoded path and anchor", () => {
    // The two are the module's single encode/decode boundary, so an encoded
    // destination split back apart must give exactly what was encoded —
    // whatever the path holds, a `#` or `%` of its own included.
    fc.assert(
      fc.property(fc.string(), fc.string(), (p, anchor) => {
        const { path: decodedPath, anchor: decodedAnchor } = splitDest(
          encodeDest(p, anchor),
        );
        assert.equal(decodedPath, p);
        assert.equal(decodedAnchor, anchor);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// IterLinks
// ---------------------------------------------------------------------------

describe("iterLinks", () => {
  it("finds links in frontmatter and body, skipping code blocks", () => {
    const text = [
      "---",
      'raw_source: "[notes.md](../../raw/notes%20%281%29.md)"',
      "---",
      "",
      "A [link](../entities/x.md) and an ![image](img/y.png).",
      "An <angle> one: [t](<a b.md>).",
      'A titled one: [t](z.md "the title").',
      "",
      "```",
      "[not a link](nope.md)",
      "```",
      "",
      "    [indented code](nope2.md)",
      "",
      "[external](https://example.com/a(b)c).",
    ].join("\n");

    const dests = iterLinks(text).map((m) => m.decodedPath);
    for (const m of iterLinks(text)) {
      assert.equal(text.slice(m.start, m.end), m.dest);
    }

    assert.deepEqual(dests, [
      "../../raw/notes (1).md",
      "../entities/x.md",
      "img/y.png",
      "a b.md",
      "z.md",
      "https://example.com/a(b)c",
    ]);
  });

  it("marks images", () => {
    const links = iterLinks("[a](a.md) ![b](b.png)");
    assert.equal(links.length, 2);
    assert.equal(links[0].isImage, false);
    assert.equal(links[1].isImage, true);
  });

  it("joins a destination folded by a YAML escaped line break", () => {
    const text = [
      "---",
      "related:",
      '  - "[A rather long target page',
      "    title](../entities/a-rather-long-tar\\",
      '    get-page-title-that-will-definitely-wrap.md)"',
      "---",
      "Body.",
    ].join("\n");

    const links = iterLinks(text);
    assert.equal(links.length, 1);
    assert.equal(
      links[0].decodedPath,
      "../entities/a-rather-long-target-page-title-that-will-definitely-wrap.md",
    );
    // The span is the *raw* folded destination, backslash and line break
    // included, so a splice replaces the fold wholesale rather than leaving a
    // stray continuation behind.
    assert.equal(
      text.slice(links[0].start, links[0].end),
      "../entities/a-rather-long-tar\\\n    get-page-title-that-will-definitely-wrap.md",
    );
  });

  it("recognises a link whose label and destination are split by a fold", () => {
    // The third fold shape (#550): the break falls between `]` and `(`. A YAML
    // reader resolves `"]\⏎  ("` to `"]("`, so this is one link — but a matcher
    // demanding `](` adjacency yielded nothing, which blinded every raw-text
    // scan: `frontmatter-link-format` missed its encoding and `split-links` could not join it.
    const fm = 'related:\n  - "[A missing both]\\\n    (a-missing-both.md)"\n';
    const links = iterLinks(fm);
    assert.equal(links.length, 1);
    assert.equal(links[0].label, "A missing both");
    assert.equal(links[0].decodedPath, "a-missing-both.md");
    // The boundary fold is bracketed on its own so the split check can splice
    // it; the destination's span still starts after the `(`.
    const fold = links[0].labelDestFold;
    assert.ok(fold, "boundary fold span is reported");
    assert.equal(fm.slice(fold.start, fold.end), "\\\n    ");
    assert.equal(fm.slice(links[0].start, links[0].end), "a-missing-both.md");
  });

  it("reports no boundary fold for a link whose brackets are adjacent", () => {
    assert.equal(iterLinks("[a](a.md)")[0].labelDestFold, null);
  });

  it("does not stretch a finished link over a following hard line break", () => {
    // A `\` at the end of a body line is a CommonMark hard break, not part of
    // the link before it: the boundary tolerance sits between `]` and `(` and
    // must not pull a break that follows a closed `)` into the match.
    const text = "Old [A](a.md)\\\nand more text.\n";
    const links = iterLinks(text);
    assert.equal(links.length, 1);
    assert.equal(text.slice(links[0].fullStart, links[0].fullEnd), "[A](a.md)");
    assert.equal(links[0].line, 0);
  });

  it("joins a folded destination on a top-level scalar", () => {
    // A bare key folds with a two-space continuation, which can itself begin
    // with `-` — inside the scalar it is just a filename character.
    const text =
      '---\nraw_source: "[f.txt](../../raw/a-rather-long-slug-num\\\n  -ber-7-raw-artifact.txt)"\n---\n';
    assert.deepEqual(
      iterLinks(text).map((m) => m.decodedPath),
      ["../../raw/a-rather-long-slug-num-ber-7-raw-artifact.txt"],
    );
  });

  it("keeps the space that YAML keeps before a fold", () => {
    // The parser is the oracle for what a fold means: whitespace *before* the
    // `\` is content, only the break and the next line's indent are dropped.
    // A regex that swallowed it would resolve to a silently wrong path.
    const text = '---\nrelated:\n  - "[T](<a b \\\n    c.md>)"\n---\n';
    assert.deepEqual(parseYaml(splitFrontmatter(text).frontmatter), {
      related: ["[T](<a b c.md>)"],
    });
    assert.deepEqual(
      iterLinks(text).map((m) => m.decodedPath),
      ["a b c.md"],
    );
  });

  it("emits a long destination unfolded, and reads it back", () => {
    // The writer folds nothing (ADR-0024), so this is the shape every page
    // written from here on carries: the destination on one line, however long
    // it is. The folds this reader still resolves are the ones already on
    // disk, which the fixtures above spell out by hand.
    const dest = `a-very-long-slug-${"and-longer-".repeat(8)}wraps.md`;
    const text = new Page("---\ntitle: x\n---\n\n").set("related", [
      `[t](<${dest}>)`,
    ]).text;

    assert.doesNotMatch(text, /\\\r?\n/);
    assert.deepEqual(
      iterLinks(text).map((m) => m.decodedPath),
      [dest],
    );
  });
});

describe("linkDest", () => {
  it("extracts a decoded destination", () => {
    assert.deepEqual(linkDest("[Some page](../concepts/some-page.md)"), {
      dest: "../concepts/some-page.md",
      ok: true,
    });
    assert.deepEqual(linkDest("just a string"), { dest: "", ok: false });
  });
});

describe("resolveLinkDest", () => {
  const cases: Array<[string, string, string]> = [
    ["../entities/x.md", "wiki/concepts", "wiki/entities/x.md"],
    ["a.md", "wiki/concepts", "wiki/concepts/a.md"],
    ["../../raw/n.md", "wiki/sources", "raw/n.md"],
    ["wiki/concepts/a.md", "", "wiki/concepts/a.md"],
    ["./a.md", "wiki/concepts", "wiki/concepts/a.md"],
  ];
  for (const [dest, pageDir, want] of cases) {
    it(`resolveLinkDest(${dest}, ${pageDir})`, () => {
      assert.equal(resolveLinkDest(dest, pageDir), want);
    });
  }
});

// ---------------------------------------------------------------------------
// Page get/set/merge
// ---------------------------------------------------------------------------

describe("Page.set", () => {
  it("mints a frontmatter block", () => {
    const page = new Page("body text\n").set("title", "A Page");
    assert.equal(page.text, "---\ntitle: A Page\n---\nbody text\n");
  });

  it("preserves key order and body", () => {
    const src =
      "---\ntitle: A\nsummary: s\nvolatility: stable\n---\n\n# Heading\n\nbody\n";
    const page = new Page(src).set("summary", "new summary");
    assert.equal(
      page.text,
      "---\ntitle: A\nsummary: new summary\nvolatility: stable\n---\n\n# Heading\n\nbody\n",
    );
  });

  it("appends a new key at the end", () => {
    const page = new Page("---\ntitle: A\n---\nbody\n").set(
      "volatility",
      "stable",
    );
    assert.ok(page.text.startsWith("---\ntitle: A\nvolatility: stable\n---\n"));
  });

  it("renders a link list at spec indentation", () => {
    const page = new Page("---\ntitle: A\n---\nbody\n").set("source", [
      "[Stub](../sources/stub.md)",
    ]);
    assert.equal(
      page.text,
      '---\ntitle: A\nsource:\n  - "[Stub](../sources/stub.md)"\n---\nbody\n',
    );
  });

  it("leaves non-link scalars unquoted", () => {
    const page = new Page("").set("tags", ["deploy", "ci"]);
    assert.ok(!page.text.includes('"'));
  });

  it("coerces a scalar for a list-valued key into a one-element list", () => {
    // #575: `tags` is list-valued, and the record reader reads a scalar as no
    // tags at all — `stringList` returns [] for anything that is not an array,
    // so the page silently drops out of every tag-filtered retrieval. The
    // writer wraps the one value in the one-element list the conventions
    // document, so the tags survive to the index whatever shape they arrive in.
    const page = new Page("---\ntitle: A\n---\nbody\n").set("tags", "alpha");
    assert.equal(page.text, "---\ntitle: A\ntags:\n  - alpha\n---\nbody\n");
    assert.deepEqual(page.getStringList("tags"), ["alpha"]);
  });
});

// ---------------------------------------------------------------------------
// The writer applies the source-date rule (#499)
// ---------------------------------------------------------------------------

// Every frontmatter shape the round-trip contract cares about, around one
// non-canonical `source_date`: a comment, a blank line, a single-quoted
// scalar, a double-quoted one, a block sequence, a plain scalar and a nested
// mapping, with `source_date` in the middle so a writer that rebuilt the block
// rather than changing one value would show it. A *flow* sequence is the one
// shape the emitter re-spaces, so the fixture holds block ones.
const uncanonicalSourceDatePage = [
  "---",
  "# a comment, which a writer has no business dropping",
  "title: 'A Page'",
  "",
  'summary: "a quoted summary"',
  "tags:",
  "  - deploy",
  '  - "ci"',
  "source_date: '2026-01-02T10:00:00Z'",
  "volatility: stable",
  "nested:",
  "  a: 1",
  "---",
  "",
  "# Heading",
  "",
  "body text",
  "",
].join("\n");

describe("Page.set applies the source-date rule on the way to disk", () => {
  // The ticket's assertion: whichever caller asked, what reaches disk carries
  // the canonical spelling. `set` is the one place frontmatter bytes are
  // produced, so the rule lives there now rather than in each caller.
  for (const [value, want] of [
    ["2026-01-02", "2026-01-02"],
    ["2026-01-02T10:00:00Z", "2026-01-02"],
    ["2026-01-02T10:00:00+05:00", "2026-01-02"],
    ["2026-01-02 10:00:00", "2026-01-02"],
    [" 2026-01-02 ", "2026-01-02"],
    [new Date(Date.UTC(2026, 0, 2, 10, 0)), "2026-01-02"],
  ] as Array<[unknown, string]>) {
    it(`writes ${String(value)} as ${want}`, () => {
      const written = new Page("---\ntitle: T\n---\nbody\n").set(
        "source_date",
        value,
      ).text;
      assert.equal(written, `---\ntitle: T\nsource_date: ${want}\n---\nbody\n`);
    });
  }

  // The hard part: canonicalising changes that one value and not one other
  // byte. Frontmatter is re-serialised (ADR-0012), so this is a real
  // assertion: it holds only because every untouched key keeps its source
  // style, order and position, the comment and blank line survive, and the
  // body is spliced back verbatim.
  it("changes the value and not one other byte", () => {
    const written = new Page(uncanonicalSourceDatePage).set(
      "source_date",
      "2026-01-02T10:00:00Z",
    ).text;
    assert.equal(
      written,
      uncanonicalSourceDatePage.replace(
        "source_date: '2026-01-02T10:00:00Z'",
        "source_date: 2026-01-02",
      ),
    );
  });

  // The tolerant posture, and the assertion that fails if someone later
  // "simplifies" the writer to the refusing one. A writer must not throw on
  // content it was handed: a hand-written "summer 2026", an impossible
  // calendar date and a non-string are all "not a date", and refusing one is
  // validation's business — already had by the time a page reaches here.
  it("leaves a non-date alone rather than refusing it", () => {
    for (const value of ["summer 2026", "2026-02-30", "nope", 20260720]) {
      const written = new Page(uncanonicalSourceDatePage).set(
        "source_date",
        value,
      ).text;
      assert.deepEqual(
        new Page(written).get("source_date").value,
        value,
        `for ${String(value)}`,
      );
    }
  });

  it("leaves a non-date byte-identical when nothing else churns", () => {
    const src = "---\ntitle: T\nsource_date: summer 2026\n---\nbody\n";
    assert.equal(new Page(src).set("source_date", "summer 2026").text, src);
  });
});

describe("Page.merge", () => {
  it("unions preserving order", () => {
    const page = new Page("---\ntags:\n  - a\n  - b\n---\nbody\n").mergeStrings(
      "tags",
      ["b", "c"],
    );
    assert.deepEqual(page.getStringList("tags"), ["a", "b", "c"]);
  });

  it("behaves like set on an absent key", () => {
    const page = new Page("---\ntitle: A\n---\nbody\n").mergeStrings("tags", [
      "x",
    ]);
    assert.deepEqual(page.getStringList("tags"), ["x"]);
  });
});

describe("Page.get", () => {
  it("is absent without frontmatter or for a missing key", () => {
    assert.equal(new Page("body\n").get("title").ok, false);
    assert.equal(new Page("---\ntitle: A\n---\n").get("summary").ok, false);
  });

  it("errors on invalid YAML", () => {
    assert.throws(() =>
      new Page("---\ntitle: [unclosed\n---\nbody\n").get("title"),
    );
  });
});

describe("Page.frontmatter", () => {
  it("is null without a block", () => {
    assert.equal(new Page("body\n").frontmatter(), null);
  });
});

// ---------------------------------------------------------------------------
// ComposeLink / NormalizeBodyLinks / Retarget
// ---------------------------------------------------------------------------

describe("composeLink", () => {
  const cases: Array<[string, string, string, string]> = [
    [
      "Foo",
      "wiki/concepts/foo.md",
      "wiki/synthesis",
      "[Foo](../concepts/foo.md)",
    ],
    ["Foo", "wiki/concepts/foo.md", "wiki/concepts", "[Foo](foo.md)"],
    [
      "raw doc.md",
      "raw/raw doc.md",
      "wiki/sources",
      "[raw doc.md](../../raw/raw%20doc.md)",
    ],
    ["Foo", "wiki/concepts/foo.md", "", "[Foo](wiki/concepts/foo.md)"],
  ];
  for (const [title, target, pageDir, want] of cases) {
    it(`composeLink(${title}, ${target}, ${pageDir})`, () => {
      assert.equal(composeLink(title, target, pageDir), want);
    });
  }
});

describe("normalizeBodyLinks", () => {
  it("is idempotent and leaves absolute/external/anchor alone", () => {
    const src =
      "See [raw](../../raw/spec(v2).md) and [ext](https://example.com/x(1)) and [a](#anchor).\n";
    const once = normalizeBodyLinks(src);
    assert.ok(once.includes("spec%28v2%29.md"));
    assert.ok(once.includes("https://example.com/x(1)"));
    assert.ok(once.includes("](#anchor)"));
    assert.equal(normalizeBodyLinks(once), once);
  });

  it("leaves a scheme-qualified destination alone, parens and all", () => {
    // A scheme is what makes this absolute. Parens are not: they are ordinary
    // destination characters, and this is where treating a scheme-qualified
    // destination as relative showed up as damage rather than as a no-op.
    for (const dest of [
      "mailto:x@y.z?subject=(hi)",
      "tel:+441234567",
      "data:text/plain,(hi)",
      "urn:isbn:0451450523",
    ]) {
      assert.equal(
        normalizeBodyLinks(`[q](${dest})\n`),
        `[q](${dest})\n`,
        `${dest} is absolute — its encoding is the author's, not ours`,
      );
    }
  });
});

describe("PlanMove", () => {
  it("fixes inbound and outbound links, including frontmatter", () => {
    const pages = {
      "wiki/concepts/a.md":
        '---\nrelated:\n  - "[B](b.md)"\n---\nSee [B](b.md).\n',
      "wiki/concepts/b.md": "Back to [A](a.md).\n",
    };
    const moved = planMove(pages, "wiki/concepts/b.md", "wiki/entities/b.md");

    assert.equal(moved["wiki/concepts/b.md"], undefined);
    assert.ok(moved["wiki/concepts/a.md"].includes("(../entities/b.md)"));
    assert.ok(moved["wiki/entities/b.md"].includes("(../concepts/a.md)"));
  });

  it("leaves absolute and external destinations alone", () => {
    const src = "[x](/abs/b.md) [y](https://example.com/b.md) [z](#anchor)\n";
    const got = new Page(src).retarget(
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
      "wiki/entities/b.md",
    );
    assert.equal(got.text, src);
  });

  it("preserves anchors", () => {
    const src = "[B](b.md#a%20section)\n";
    const got = new Page(src).retarget(
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
      "wiki/entities/b.md",
    );
    assert.equal(got.text, "[B](../entities/b.md#a%20section)\n");
  });

  it("skips links in code blocks", () => {
    const src = "```\n[B](b.md)\n```\n";
    const got = new Page(src).retarget(
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
      "wiki/entities/b.md",
    );
    assert.equal(got.text, src);
  });

  it("rewrites a folded inbound frontmatter link into valid YAML", () => {
    // A folded destination is one raw span spanning two lines; the splice must
    // replace the whole span, or the leftover continuation corrupts the YAML.
    const pages = {
      "wiki/concepts/a.md":
        '---\nrelated:\n  - "[A rather long target page title](../entities/a-rather-long-tar\\\n    get-page-title-that-will-definitely-wrap.md)"\n---\nBody.\n',
      "wiki/entities/a-rather-long-target-page-title-that-will-definitely-wrap.md":
        "---\ntitle: A rather long target page title\n---\nBody.\n",
    };
    const moved = planMove(
      pages,
      "wiki/entities/a-rather-long-target-page-title-that-will-definitely-wrap.md",
      "wiki/entities/b.md",
    );

    // Oracle: the YAML parser, not iterLinks, says where the edge now points.
    assert.deepEqual(
      moved["wiki/concepts/a.md"] &&
        new Page(moved["wiki/concepts/a.md"]).frontmatter()?.["related"],
      ["[A rather long target page title](../entities/b.md)"],
    );
  });
});

describe("PlanConsolidate", () => {
  it("repoints inbound links at the survivor and drops the absorbed pages", () => {
    const pages = {
      "wiki/concepts/a.md": "A body.\n",
      "wiki/concepts/b.md": "B body.\n",
      "wiki/concepts/c.md": "C body.\n",
      "wiki/entities/e.md":
        '---\nrelated:\n  - "[A](../concepts/a.md)"\n---\n' +
        "See [A](../concepts/a.md) and [C](../concepts/c.md).\n",
    };
    const after = planConsolidate(
      pages,
      ["wiki/concepts/a.md", "wiki/concepts/c.md"],
      "wiki/concepts/b.md",
    );

    assert.ok(!("wiki/concepts/a.md" in after));
    assert.ok(!("wiki/concepts/c.md" in after));
    assert.equal(after["wiki/concepts/b.md"], "B body.\n");
    // Body links and frontmatter edges both follow; the labels are the author's
    // and stay exactly as they were.
    assert.equal(
      after["wiki/entities/e.md"],
      '---\nrelated:\n  - "[A](../concepts/b.md)"\n---\n' +
        "See [A](../concepts/b.md) and [C](../concepts/b.md).\n",
    );
  });

  it("leaves the survivor's own outbound links alone", () => {
    const pages = {
      "wiki/concepts/a.md": "A.\n",
      "wiki/concepts/b.md": "See [E](../entities/e.md).\n",
    };
    const after = planConsolidate(
      pages,
      ["wiki/concepts/a.md"],
      "wiki/concepts/b.md",
    );
    assert.equal(after["wiki/concepts/b.md"], "See [E](../entities/e.md).\n");
  });
});

describe("canonicalizeLinkTargets", () => {
  it("reads a link by where it points, not how it is spelled", () => {
    const copied = "See [X](x.md) and [E](../entities/e.md).\n";
    const reBased = "See [X](../concepts/x.md) and [E](../entities/e.md).\n";
    assert.equal(
      canonicalizeLinkTargets(copied, "wiki/concepts"),
      canonicalizeLinkTargets(reBased, "wiki/notes"),
    );
  });

  it("maps a consolidated ref to the survivor and keeps the anchor", () => {
    assert.equal(
      canonicalizeLinkTargets("[A](a.md#ttl)", "wiki/concepts", (ref) =>
        ref === "wiki/concepts/a.md" ? "wiki/concepts/b.md" : ref,
      ),
      "[A](wiki/concepts/b.md#ttl)",
    );
  });

  it("leaves non-vault destinations byte-identical", () => {
    const src = "[x](https://example.com/a.md) [y](/abs/a.md) [z](#sec)\n";
    assert.equal(canonicalizeLinkTargets(src, "wiki/concepts"), src);
  });
});

// ---------------------------------------------------------------------------
// A scheme-qualified destination is absolute, not relative (#500)
// ---------------------------------------------------------------------------

// Destinations naming something outside the vault. Every one is a URI with a
// scheme: what makes it absolute is the scheme, and none of these carries a
// `//` — the one shape a classifier that only knows `://` reads as a
// vault-relative path, and then re-spells against the moved page's folder.
const schemeDests = [
  "mailto:x@y.z",
  "mailto:x@y.z?subject=(hi)",
  "tel:+441234567",
  "data:text/plain,hi",
  "urn:isbn:0451450523",
];

describe("a scheme-qualified destination is absolute, not relative", () => {
  it("keeps a body link byte-identical across a folder change", () => {
    for (const dest of schemeDests) {
      const moved = planMove(
        {
          "wiki/concepts/a.md": `# A\n\nContact [me](${dest}), see [B](../entities/b.md).\n`,
          "wiki/entities/b.md": "# B\n",
        },
        "wiki/concepts/a.md",
        "wiki/entities/a.md",
      );
      // Whole-document byte equality, so a link the move damaged cannot hide
      // behind a substring that happens to survive. The sibling link is here
      // to prove the move ran: it is re-spelled, the scheme is not.
      assert.equal(
        moved["wiki/entities/a.md"],
        `# A\n\nContact [me](${dest}), see [B](b.md).\n`,
        `${dest} is absolute — a move must not respell it`,
      );
    }
  });

  it("keeps a frontmatter link byte-identical across a folder change", () => {
    for (const dest of schemeDests) {
      const text =
        "---\n" +
        "title: A\n" +
        "source:\n" +
        `  - "[spec](${dest})"\n` +
        "related:\n" +
        '  - "[B](../entities/b.md)"\n' +
        "---\n" +
        "Body.\n";
      const moved = planMove(
        { "wiki/concepts/a.md": text, "wiki/entities/b.md": "# B\n" },
        "wiki/concepts/a.md",
        "wiki/entities/a.md",
      );
      // The edge key that holds it is immaterial — the same whole-document
      // scan and the same splice carry every frontmatter link.
      assert.equal(
        moved["wiki/entities/a.md"],
        text.replace("../entities/b.md", "b.md"),
        `${dest} is absolute — a move must not respell it`,
      );
    }
  });

  it("still rewrites a page link whose own filename carries a colon", () => {
    // The counterexample the `.md`-first ordering exists for: `C:notes.md`
    // looks like a scheme, and is a page of the vault all the same.
    const moved = planMove(
      {
        "wiki/concepts/a.md":
          "# A\n\nSee [C](C:notes.md) and [me](mailto:x@y.z).\n",
        "wiki/concepts/C:notes.md": "# C\n",
      },
      "wiki/concepts/a.md",
      "wiki/entities/a.md",
    );
    assert.equal(
      moved["wiki/entities/a.md"],
      "# A\n\nSee [C](../concepts/C:notes.md) and [me](mailto:x@y.z).\n",
    );
  });
});

// ---------------------------------------------------------------------------
// Property tests — the page-move and frontmatter contracts (ADR-0012)
// ---------------------------------------------------------------------------

// vaultDirs are the directories a generated page may live in — enough shape
// variation (sibling, cousin, vault root) to exercise every `../` case. The
// kind-folders are named separately: the YAML oracle can only read a page that
// lives in one, so the generator has to guarantee one.
const kindDirs = [
  "wiki/concepts",
  "wiki/entities",
  "wiki/sources",
  "wiki/synthesis",
];
const vaultDirs = [...kindDirs, ""];

// The names the generator draws pages from. The long ones are load-bearing: a
// destination that outgrows the writer's line width folds across two lines, and
// a fold is the one shape where the raw-text link scan and the YAML parser can
// disagree — the disagreement #486 was. Each is long enough that its own
// basename, the shortest destination any page can carry, still folds.
const shortNames = ["a", "b", "c", "d"];
const longNames = [
  "a-rather-long-target-page-title-that-will-definitely-wrap-across-two-lines",
  "the-second-long-page-name-that-the-writer-will-certainly-have-to-fold-away",
];

function posixBasename(ref: string): string {
  return path.posix.basename(ref);
}
function posixDirname(ref: string): string {
  return path.posix.dirname(ref);
}

// genVault draws a small vault of pages that link to each other, plus the
// old/new ref of a move to plan over it.
const genVaultArb = fc
  .record({
    // One long name is always drawn, so every generated vault folds.
    names: fc
      .tuple(
        fc.shuffledSubarray(shortNames, { minLength: 1, maxLength: 3 }),
        fc.constantFrom(...longNames),
      )
      .map(([short, long]) => [...short, long]),
    // The first page always lands in a kind-folder and is never the one moved,
    // so the YAML oracle has a page it can read both before and after the move
    // — and one whose every link to the long-named page folds.
    dirs: fc
      .tuple(
        fc.constantFrom(...kindDirs),
        fc.array(fc.constantFrom(...vaultDirs), { minLength: 0, maxLength: 3 }),
      )
      .map(([first, rest]) => [first, ...rest]),
    newDir: fc.constantFrom(...vaultDirs),
    oldIdx: fc.integer({ min: 1, max: 3 }),
  })
  .map(({ names, dirs, newDir, oldIdx }) => {
    const refs = names.map((name, i) =>
      path.posix.join(dirs[i % dirs.length], `${name}.md`),
    );
    const oldRel = refs[Math.min(oldIdx, refs.length - 1)];
    const newRel = path.posix.join(newDir, posixBasename(oldRel));
    const pages = buildVault(refs);
    return { pages, oldRel, newRel };
  })
  .filter(
    ({ pages, oldRel, newRel }) =>
      newRel === oldRel || !Object.prototype.hasOwnProperty.call(pages, newRel),
  );

/** Build a small vault of pages that link to each other, plus a frozen link
 * inside a code block.
 *
 * The frontmatter is rendered by [Page.set] — the emitter's own shape — and
 * then the items are folded **by hand**, because the emitter folds nothing any
 * more (ADR-0024): every item at the label/destination boundary (#550), and
 * the longest also inside its destination (#486). The folds matter more than
 * the fidelity that used to be the reason to let the writer produce them: they
 * are the shapes every raw-text reader has to cope with, and the thing the
 * YAML oracle below exists to compare, so the fixture has to carry them
 * whatever the writer does. What keeps the hand-written form honest is that
 * each value still has to survive the YAML parser, which is what the oracle
 * reads it back through. */
function buildVault(refs: string[]): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const ref of refs) {
    const dir = posixDirname(ref);
    const dests = refs.map((target) =>
      percentEncode(relPathForTest(target, dir)),
    );
    const links = dests.map((dest) => `[t](${dest})`);
    let body = "";
    for (const dest of dests) body += `Body link [t](${dest})\n`;
    body += "\n```\n[frozen](never-touched.md)\n```\n";
    pages[ref] = foldLinkItems(
      new Page(body).set("title", posixBasename(ref)).set("related", links)
        .text,
    );
  }
  return pages;
}

/** A quoted list item in a frontmatter block: `  - "[t](dest)"`. */
const LINK_ITEM_RE = /^(\s*- ")(.*)(")$/;

/** The continuation indent the emitter used for a folded item under a
 * top-level key — `  - ` plus two, which is where the old writer put the
 * second half of a destination. */
const FOLD_CONTINUATION = "    ";

/** Fold every quoted link item the way the pre-ADR-0024 writer could: a
 * trailing `\`, a break, then the continuation indent, all three dropped by a
 * conforming reader.
 *
 * Each item folds at the label/destination boundary (#550), which is the shape
 * a raw-text link scan went blind to; the longest item additionally folds
 * inside its destination (#486). Any cut point preserves the value, which is
 * why the destination cut can be a blunt midpoint rather than a search for a
 * space: the fold drops the break and the indentation after it, and nothing
 * else. */
function foldLinkItems(text: string): string {
  const lines = text.split("\n");
  const items = lines
    .map((line, i) => ({ i, match: LINK_ITEM_RE.exec(line) }))
    .filter(
      (e): e is { i: number; match: RegExpExecArray } => e.match !== null,
    );
  if (items.length === 0) return text;

  let longest = items[0]!;
  for (const item of items) {
    if (item.match[2]!.length > longest.match[2]!.length) longest = item;
  }

  for (const { i, match } of items) {
    const [, open, value, close] = match;
    const boundary = value!.indexOf("](");
    if (boundary < 0) continue;
    const dest = value!.slice(boundary + 2, -1);
    let folded = dest;
    if (i === longest.i) {
      const cut = Math.ceil(dest.length / 2);
      folded =
        dest.slice(0, cut) + "\\\n" + FOLD_CONTINUATION + dest.slice(cut);
    }
    lines[i] =
      `${open}${value!.slice(0, boundary + 1)}\\\n` +
      `${FOLD_CONTINUATION}(${folded})${close}`;
  }
  return lines.join("\n");
}

/** A minimal relPath for test fixture generation (mirrors the module's). */
function relPathForTest(target: string, base: string): string {
  const targetParts = posixPathParts(target);
  const baseParts = posixPathParts(base);
  let common = 0;
  while (
    common < targetParts.length &&
    common < baseParts.length &&
    targetParts[common] === baseParts[common]
  ) {
    common++;
  }
  const parts: string[] = [];
  for (let i = common; i < baseParts.length; i++) parts.push("..");
  parts.push(...targetParts.slice(common));
  return parts.length === 0 ? "." : parts.join("/");
}

function posixPathParts(p: string): string[] {
  const cleaned = path.posix.normalize(p);
  if (cleaned === "." || cleaned === "") return [];
  return cleaned.split("/");
}

/** Every link in text resolved from pageDir — the "where does this page point"
 * fact a move must leave unchanged. */
function resolvedTargets(text: string, pageDir: string): string[] {
  const out: string[] = [];
  for (const link of iterLinks(text)) {
    if (isRelativeDestForTest(link))
      out.push(resolveLinkDest(link.decodedPath, pageDir));
  }
  return out;
}

function isRelativeDestForTest(link: LinkMatch): boolean {
  return (
    link.decodedPath !== "" &&
    !link.decodedPath.startsWith("/") &&
    !link.decodedPath.startsWith("#") &&
    !link.decodedPath.includes("://")
  );
}

/** Where a ref — a page's or a link's target — points after the move. */
function movedRef(ref: string, oldRel: string, newRel: string): string {
  return ref === oldRel ? newRel : ref;
}

/** Whether a link destination in text's frontmatter is folded across two
 * lines — written by hand by [foldLinkItems], since the emitter no longer
 * produces one, or inherited from a page written before ADR-0024.
 *
 * Read from raw bytes and the YAML parser, never through [iterLinks]: a guard
 * built on that scan would go blind exactly when the fold it guards went blind,
 * and report "the fixture stopped folding" for "the scan stopped seeing". */
function hasFoldedDestination(text: string): boolean {
  const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter) return false;
  // A fold is an escaped line break, and it is inside a link scalar when the
  // parser reads that scalar back in a form the raw block does not hold.
  if (!frontmatter.includes("\\\n")) return false;
  const data = parseYaml(frontmatter) as { related?: unknown } | null;
  if (!Array.isArray(data?.related)) return false;
  return data.related.some(
    (link) => typeof link === "string" && !frontmatter.includes(link),
  );
}

/** Whether ref sits directly under a `wiki/` kind-folder — the depth
 * [newPageRecord] requires before it will describe a page at all. */
function underKindFolder(ref: string): boolean {
  return path.posix.dirname(path.posix.dirname(ref)) === "wiki";
}

/** A page's frontmatter edges, keyed by edge key, each target resolved
 * vault-relative — read by [newPageRecord] through the YAML parser.
 *
 * What that buys is the *link set*: it comes from the parser, so a fold cannot
 * hide a link from this oracle the way it hid one from the raw-text scan
 * (#486). Below that the two do meet — [newPageRecord] resolves each scalar
 * with [linkDest], which is [iterLinks] again — so this is an oracle for a
 * fold, not for a blind spot in the link grammar itself.
 *
 * Null for a page outside a kind-folder, the depth [newPageRecord] requires:
 * the frontmatter schema has nothing to say about such a page, so this oracle
 * says nothing about it either. */
function frontmatterEdges(
  ref: string,
  text: string,
): Record<string, string[]> | null {
  if (!underKindFolder(ref)) return null;
  const edges: Record<string, string[]> = {};
  for (const edge of newPageRecord(ref, text).edges) {
    edges[edge.key] = edge.targets;
  }
  return edges;
}

/** The runs of text between links, in order: every byte a move is not allowed
 * to touch, cut at each link's whole `[label](dest)` span.
 *
 * A folded destination's span covers the fold, so flattening one takes the
 * line break and indentation out of the link's own span rather than out of a
 * gap — which is what lets a correct move flatten a fold and still leave every
 * gap alone.
 *
 * A list rather than one concatenated remainder, because concatenation is blind
 * to where the cuts fell: a line break migrating across a link boundary leaves
 * the joined remainder identical while reflowing the document. */
function textBetweenLinks(text: string): string[] {
  const gaps: string[] = [];
  let at = 0;
  for (const link of iterLinks(text)) {
    gaps.push(text.slice(at, link.fullStart));
    at = link.fullEnd;
  }
  gaps.push(text.slice(at));
  return gaps;
}

const MOVE_NUM_RUNS = 100;

describe("move preserves every link target", () => {
  it("after the move, every link resolves to what it pointed at before", () => {
    fc.assert(
      fc.property(genVaultArb, ({ pages, oldRel, newRel }) => {
        const moved = planMove(pages, oldRel, newRel);
        // Guards the oracle below rather than the move: an edit that stopped
        // the fixture folding would leave it comparing edges it reads
        // perfectly well against each other, silently and forever.
        let oracleReadAFold = false;

        for (const [ref, before] of Object.entries(pages)) {
          const afterRef = movedRef(ref, oldRel, newRel);
          const after = moved[afterRef];
          assert.ok(
            after !== undefined,
            `page ${afterRef} missing after the move`,
          );

          // Oracle 1 — the raw-text link scan: every link, body links
          // included, still resolves where it did before.
          const wantTargets = resolvedTargets(before, posixDirname(ref));
          const gotTargets = resolvedTargets(after, posixDirname(afterRef));
          assert.equal(
            wantTargets.length,
            gotTargets.length,
            `${ref}: link count changed`,
          );
          for (let i = 0; i < wantTargets.length; i++) {
            assert.equal(
              gotTargets[i],
              movedRef(wantTargets[i], oldRel, newRel),
              `${ref}: link ${i}`,
            );
          }

          // Oracle 2 — the YAML parser. Its link set comes from the parser, so
          // a link the raw-text scan went blind to cannot make both sides of
          // this comparison agree: the scan alone is failing while the parser
          // still reads where the edge really points (#489, the #486 fold).
          const wantEdges = frontmatterEdges(ref, before);
          if (wantEdges === null) continue;
          const gotEdges = frontmatterEdges(afterRef, after);
          if (gotEdges === null) continue; // moved to the vault root
          const wantMoved: Record<string, string[]> = {};
          for (const [key, targets] of Object.entries(wantEdges)) {
            wantMoved[key] = targets.map((t) => movedRef(t, oldRel, newRel));
          }
          assert.deepEqual(gotEdges, wantMoved, `${ref}: frontmatter edges`);
          oracleReadAFold ||=
            hasFoldedDestination(before) && Object.keys(wantEdges).length > 0;
        }

        assert.ok(
          oracleReadAFold,
          "the YAML oracle compared no folded edge — it has nothing the raw-text scan could miss",
        );
      }),
      { numRuns: MOVE_NUM_RUNS },
    );
  });
});

describe("textBetweenLinks", () => {
  const folded =
    '---\nrelated:\n  - "[t](../entities/a-rather-long-tar\\\n    get-page-title-that-will-definitely-wrap.md)"\n---\nBody.\n';
  const flat =
    '---\nrelated:\n  - "[t](../entities/a-rather-long-target-page-title-that-will-definitely-wrap.md)"\n---\nBody.\n';

  it("tolerates a flattened fold but not a changed non-link byte", () => {
    // A retarget splices a flat destination over a folded span: one line
    // fewer, the same text either side of the link.
    assert.deepEqual(textBetweenLinks(flat), textBetweenLinks(folded));
    assert.deepEqual(textBetweenLinks(folded), [
      '---\nrelated:\n  - "',
      '"\n---\nBody.\n',
    ]);
    assert.notDeepEqual(
      textBetweenLinks(flat.replace("Body.", "Body!")),
      textBetweenLinks(folded),
    );
  });

  it("sees a line break that moves across a link boundary", () => {
    // The same bytes outside links in either text; only the cut between them
    // differs, as a splice that reflowed the line would leave them.
    const before = "A\n[x](b.md)\nB\n";
    const reflowed = "A[x](b.md)\n\nB\n";
    assert.notDeepEqual(textBetweenLinks(reflowed), textBetweenLinks(before));
  });
});

describe("move changes nothing outside a link", () => {
  it("holds for a flattened fold, and for a move to the same ref", () => {
    fc.assert(
      fc.property(genVaultArb, ({ pages, oldRel, newRel }) => {
        const moved = planMove(pages, oldRel, newRel);
        for (const [ref, before] of Object.entries(pages)) {
          const afterRef = movedRef(ref, oldRel, newRel);
          const after = moved[afterRef];
          assert.ok(
            after !== undefined,
            `page ${afterRef} missing after the move`,
          );

          // A splice replaces a span with a flat destination, so a move can
          // cost a line (flattening a fold) but never add one. Re-folding a
          // destination would, and in a body link it would break the link
          // outright, the fold being YAML's and not markdown's.
          assert.ok(
            after.split("\n").length <= before.split("\n").length,
            `${ref}: the move added a line`,
          );

          assert.deepEqual(
            textBetweenLinks(after),
            textBetweenLinks(before),
            `${ref}: bytes outside a link changed`,
          );

          // A move to where the page already is has nothing to rewrite, folds
          // included, so it must come back byte-identical.
          if (oldRel === newRel) {
            assert.equal(
              after,
              before,
              `${ref}: a move to the same ref rewrote the page`,
            );
          }
        }
      }),
      { numRuns: MOVE_NUM_RUNS },
    );
  });
});

/** Where a ref — a page's or a link's target — points after a Consolidation:
 * every consolidated page's links land on the survivor. The [movedRef] of the
 * property below. */
function consolidatedRef(
  ref: string,
  losers: string[],
  survivor: string,
): string {
  return losers.includes(ref) ? survivor : ref;
}

// A Consolidation is a move with many sources and one destination, so the same
// vault generator carries over. The difference the mapping has to survive is
// that several refs collapse onto one, and that a page can be *both* a link
// target and absorbed.
//
// The first generated page — always in a kind-folder, per genVaultArb — is
// never consolidated away, so the YAML oracle has a page it can read both
// before and after, the same guarantee the move property relies on.
const genConsolidationArb = fc
  .tuple(
    genVaultArb.map(({ pages }) => pages),
    fc.boolean(),
    fc.nat(),
    fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  )
  .map(([pages, promoteFirst, pick, mask]) => {
    const refs = Object.keys(pages);
    const first = refs[0];
    const rest = refs.slice(1);
    let survivor = first;
    if (!promoteFirst && rest.length > 0) survivor = rest[pick % rest.length];

    const absorbable = refs.filter((ref) => ref !== survivor && ref !== first);
    let losers = absorbable.filter((_, i) => mask[i % mask.length]);
    if (losers.length === 0 && absorbable.length > 0) losers = [absorbable[0]];
    if (losers.length === 0) {
      // Nothing can be absorbed without taking the kind-folder page the YAML
      // oracle needs, so promote that page and absorb the rest instead.
      survivor = first;
      losers = refs.slice(1);
    }
    return { pages, survivor, losers };
  })
  .filter(
    ({ pages, survivor, losers }) =>
      losers.length > 0 &&
      survivor in pages &&
      losers.every((loser) => loser !== survivor && loser in pages),
  );

describe("consolidation preserves every link target", () => {
  it("repoints every link at a consolidated page to the survivor", () => {
    fc.assert(
      fc.property(genConsolidationArb, ({ pages, survivor, losers }) => {
        const after = planConsolidate(pages, losers, survivor);
        let oracleReadAFold = false;

        // Every consolidated page is gone; every other page is still there.
        assert.equal(
          Object.keys(after).length,
          Object.keys(pages).length - losers.length,
          "the vault did not shrink by exactly the consolidated pages",
        );
        for (const ref of losers) {
          assert.ok(!(ref in after), `consolidated page ${ref} survived`);
        }

        for (const [ref, before] of Object.entries(pages)) {
          if (losers.includes(ref)) continue;
          const got = after[ref];
          assert.ok(
            got !== undefined,
            `page ${ref} missing after consolidating`,
          );

          // Oracle 1 — the raw-text link scan: every link, body links included,
          // now points at the survivor if it pointed at a consolidated page, and
          // exactly where it did before otherwise.
          const wantTargets = resolvedTargets(before, posixDirname(ref)).map(
            (target) => consolidatedRef(target, losers, survivor),
          );
          const gotTargets = resolvedTargets(got, posixDirname(ref));
          assert.deepEqual(gotTargets, wantTargets, `${ref}: link targets`);

          // Nothing outside a link changed, and a splice can only flatten — so
          // a line can be lost, never gained.
          assert.ok(
            got.split("\n").length <= before.split("\n").length,
            `${ref}: the consolidation added a line`,
          );
          assert.deepEqual(
            textBetweenLinks(got),
            textBetweenLinks(before),
            `${ref}: bytes outside a link changed`,
          );

          // Oracle 2 — the YAML parser, independent of the raw-text scan: a
          // frontmatter edge the scan went blind to (a folded destination,
          // #489) cannot make both sides of this comparison agree.
          const wantEdges = frontmatterEdges(ref, before);
          if (wantEdges === null) continue;
          const gotEdges = frontmatterEdges(ref, got);
          if (gotEdges === null) continue;
          const wantMoved: Record<string, string[]> = {};
          for (const [key, targets] of Object.entries(wantEdges)) {
            wantMoved[key] = targets.map((target) =>
              consolidatedRef(target, losers, survivor),
            );
          }
          assert.deepEqual(gotEdges, wantMoved, `${ref}: frontmatter edges`);
          oracleReadAFold ||=
            hasFoldedDestination(before) && Object.keys(wantEdges).length > 0;
        }

        assert.ok(
          oracleReadAFold,
          "the YAML oracle compared no folded edge — it has nothing the raw-text scan could miss",
        );
      }),
      { numRuns: MOVE_NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property test — no-op Set and the ADR-0012 frontmatter round-trip
// ---------------------------------------------------------------------------

// Value pool for generated frontmatter: safe plain tokens plus markdown-link
// scalars, authored with single quotes (non-canonical) so a no-op Set provably
// normalises the quote style and is never byte-identical.
//
// `tags` is deliberately absent: it is list-valued, so a scalar Set on it is
// not the no-op shape this property is about — the writer wraps the value in a
// one-element list (#575). `source` is a list *edge* key, but the writer
// normalises no edge key, so a scalar Set on it stays the scalar it was and the
// round trip below still holds.
const FM_KEYS = ["title", "summary", "volatility", "source"];
const FM_VALUES = [
  "deploy",
  "ci",
  "stable",
  "hello",
  "[B](b.md)",
  "[x](../c.md)",
  // Long enough that the emitter folded it before ADR-0024 — which is what
  // makes the round-trip property below a fold guard too: a fold is not a
  // quote character, so it survives `strip` and fails the comparison.
  "[A rather long target page title](../entities/a-rather-long-target-page-title-that-will-definitely-wrap.md)",
];

const genPageArb = fc
  .record({
    keys: fc.shuffledSubarray(FM_KEYS, {
      minLength: 1,
      maxLength: FM_KEYS.length,
    }),
    values: fc.array(fc.constantFrom(...FM_VALUES), {
      minLength: 1,
      maxLength: 5,
    }),
    body: fc.string(),
  })
  .map(({ keys, values, body }) => {
    // Keys are distinct (shuffledSubarray) so the frontmatter is always valid
    // YAML; values cycle to pair with every key.
    const pairs = keys.map(
      (k, i) => [k, values[i % values.length]] as [string, string],
    );
    const fm = pairs.map(([k, v]) => `${k}: '${v}'`).join("\n");
    return { text: `---\n${fm}\n---\n${body}`, pairs };
  });

describe("no-op Set preserves key order and changes only quote style", () => {
  it("is not byte-identical but keeps keys, values, order and body", () => {
    fc.assert(
      fc.property(genPageArb, ({ text, pairs }) => {
        const [key, value] = pairs[0];
        const page = new Page(text);
        const updated = page.set(key, value).text;

        // Not byte-identical: the single-quoted input normalises.
        assert.notEqual(updated, text);

        // Body after the frontmatter block is untouched.
        assert.equal(
          splitFrontmatter(updated).body,
          splitFrontmatter(text).body,
        );

        // Key order and values are preserved semantically.
        const before = new Page(text).frontmatter()!;
        const after = new Page(updated).frontmatter()!;
        assert.deepEqual(Object.keys(after), Object.keys(before));
        assert.deepEqual(after, before);

        // The only textual divergence is scalar quote style: strip quote
        // characters from both and they are identical.
        const strip = (s: string) => s.replace(/['"]/g, "");
        assert.equal(strip(updated), strip(text));
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property test — the emitter folds nothing (ADR-0024)
// ---------------------------------------------------------------------------

// Both shapes the emitter used to produce are generated here: a link whose
// label has no space (the destination folded mid-token, escaped) and one whose
// label has spaces (folded at a space, leaving the label split across lines).
const genLinkValueArb = fc
  .record({
    label: fc.constantFrom(
      "t",
      "Some long page title here",
      "RBWM Council Political Composition",
    ),
    // Space-free and past any sensible width: the shape that folded
    // mid-token with a trailing backslash, since a percent-encoded
    // destination offers no space to break at.
    slug: fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), {
        minLength: 90,
        maxLength: 160,
      })
      .map((chars) => chars.join("")),
  })
  .map(({ label, slug }) => `[${label}](../concepts/${slug}.md)`);

describe("the writer never folds a line", () => {
  it("emits each link on one line, and reads back what went in", () => {
    fc.assert(
      fc.property(genLinkValueArb, (value) => {
        const text = new Page("---\ntitle: x\n---\n\n").set("related", [
          value,
        ]).text;

        // Neither shape of fold: no escaped line break, and no item continued
        // onto a follow-on line. One line each for `title`, the key, the item.
        assert.doesNotMatch(text, /\\\r?\n/);
        const fmLines = splitFrontmatter(text)
          .frontmatter.split("\n")
          .filter((line) => line.trim() !== "");
        assert.equal(fmLines.length, 3, fmLines.join(" / "));

        // And no fold is hiding a corruption: the value survives the round
        // trip byte for byte.
        assert.deepEqual(parseYaml(splitFrontmatter(text).frontmatter), {
          title: "x",
          related: [value],
        });
      }),
      { numRuns: 100 },
    );
  });
});
