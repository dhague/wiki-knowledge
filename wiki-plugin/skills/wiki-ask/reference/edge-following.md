# Edge-following rules

Read when the question's shape is not one you have already mapped. Every row follows the named edge in the named direction; anything not listed follows all typed edges in both directions, `source` excepted.

**Outbound** means X's own `<edge>:` list; **inbound** means the pages whose `<edge>:` list names X.

| Question pattern | Edge | Direction |
|---|---|---|
| "what does X refine" / "X refines" | `refines` | outbound from X |
| "what refines X" / "refined by" | `refines` | inbound to X |
| "what superseded X" / "replaces X" / "is X still current" | `supersedes` | inbound to X |
| "what does X supersede" | `supersedes` | outbound from X |
| "what contradicts X" / "is X contradicted" | `contradicts` | inbound to X |
| "examples of X" / "what is an example of X" | `example-of` | inbound to X |
| "what is X an example of" | `example-of` | outbound from X |
| "what did X draw on" / "what sources X" | `source` | outbound from X |
| "where is X used" / "what uses X" | `source` | inbound to X |
| "related to X" (default) | `related` | both |

The provenance pattern — "provenance of X", "evidence for X", "raw data behind X", "cite the original" — stays inline in `SKILL.md` under [Edge-following rules](../SKILL.md#edge-following-rules), because the provenance citation branch needs it without a file read.
