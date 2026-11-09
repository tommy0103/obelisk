# Card 2 Thinking Retrieval

Goal: find turning points. This card is not a project timeline and not an implementation log. It is the record of what changed in the user's mind.

Retrieve 3-6 turns. A turn needs both sides:

- the user question, friction, doubt, or request that started the turn;
- the later decision, reframing, finding, or constraint that replaced the earlier
  state.

Useful searches:

- user questions in the period: "为什么", "是不是", "怎么", "我觉得", "不应该";
- places where the user corrected the direction and then approved a new frame;
- summaries that name decisions, followed by `context()` or `thread()` for the
  user's actual words;
- memory records only as hints; raw session evidence must provide the prompt and
  turn.

Prefer helpers first. If you need custom SQL for message windows or user-turn
counts, read `references/schema.md` before writing the SQL.

Do not use workflow names, feature names, or agent task labels as prompts when
the user had their own wording. Do not use counts, "5 rounds", "13 agents", or
implementation effort as turns unless that count is the turn itself.

Read this card's writing file immediately after the turns are chosen:
`references/recap/writing2-thinking.md`. Then update the JSON `thinking_path`
card and add evidence for each item.
Do not read `pattern3-vibe.md` until this JSON update is done.

Stop when each item has a source-language prompt label, a short changed-state
prompt, turn, and an `evidence` anchor.
