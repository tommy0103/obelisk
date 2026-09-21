# Card 1 Cover Retrieval

Goal: choose the recap's dominant claim, persona, activity shape, and compact
footer. The cover is not a topic inventory; it is one glanceable claim about
what the period felt like.

Use the period from `overview.md`. Start from `overview({ limit: 6 })`, then
look at in-period sessions, summaries, memories, and any obvious project scope.
If the user asked for a project, keep that scope; otherwise prefer the current
project only when the evidence makes it the clear center.

Prefer helpers first. If you need custom SQL for activity, token/message counts,
or source-session scope, read `references/schema.md` before writing the SQL.

Retrieve:

- dominant claim: one thing that defined the period, supported by raw evidence;
- persona: which archetype best matches the user's attention;
- source sessions and memories used by this cover claim;
- activity: weekly day intensities or monthly day intensities when supported;
- footer: compact public metric such as sessions, messages, or tokens.

Avoid:

- a claim that lists three topics;
- an archetype chosen from the recap-generation session itself;
- footer caveats like excluded projects, exact SQL filters, or long session names;
- making the cover a workflow metric when the week was really about a decision.

Read this card's writing file immediately after the cover evidence is stable:
`references/recap/writing1-cover.md`. Then update the JSON fields
`period`, `source`, `metrics`, `persona`, and the first `cards[]` entry.
Do not read `pattern2-thinking.md` until this JSON update is done.

Stop when the cover has one evidence-backed dominant claim, one chosen persona,
one metric scope, and at least one `evidence` anchor.
