# Card 1 Cover Writing

The cover should be readable in one glance: badge, persona, one plain claim,
activity, footer. Before writing, say the claim to the user in a chat bubble.
If it sounds like a topic list or report heading, shrink it.

## Mock taste anchor

```json
{
  "type": "cover",
  "badge": "Week 24",
  "title": "The Architect",
  "claim": "从零设计了一个完整的 memory 系统。",
  "activity": [0.85, 0.92, 0.72, 0.45, 0.88, 0.30, 0],
  "footer": "12 sessions · 2.4M tokens"
}
```

This works because `从零设计了一个完整的 memory 系统。` is one plain claim, in
the user's language, and can be read in one breath. `The Architect` is English
chrome; it gives the card a designed surface without translating the user's
actual work.

## JSON Shape

```ts
type CoverCard = {
  type: "cover";
  badge: string;
  title: string;
  claim: string;
  activity: number[];
  footer: string;
  evidence_refs?: string[];
};
```

Field duties:

- `badge`: compact period chrome, such as `Week 24`.
- `title`: persona label, usually `The Architect`, `The Debugger`, etc.
- `claim`: one plain claim; not a topic list, project inventory, colon-led
  tagline, or clever English that hides the user's language.
- `activity`: period intensity values from retrieval.
- `footer`: public metric line with no internal filter notes.

After writing, check that `persona.claim` and `cover.claim` tell the same
story, and attach `evidence_refs` to the claim or metric if it is surprisingly
specific.

## First JSON Write

After Card 1, create or update the recap JSON file. Do this before reading
`pattern2-thinking.md`.

Use this top-level shape:

```ts
type Recap = {
  schema_version: "obelisk.recap.v1";
  kind: "weekly" | "monthly";
  generated_at: string;
  period: { label: string; start: string; end: string; timezone: string };
  source: { project?: string; session_ids: string[]; memory_ids?: string[] };
  metrics: {
    sessions?: number;
    messages?: number;
    tokens?: number;
    active_days?: number[];
    streak_days?: number;
    workflows?: number;
    workflow_agents?: number;
    corrections?: number;
  };
  persona: { archetype: string; title: string; claim: string; tone: string };
  cards: [CoverCard, { type: "thinking_path" }, { type: "vibe" }, { type: "workflow" }, { type: "closing" }];
  evidence?: Array<{ id: string; session_id?: string; message_uuid?: string; memory_id?: string; summary?: string }>;
};
```

For app handoff, write JSON under `~/.obelisk/recap/`. Weekly filenames are
`recap-{YYYY}-W{WW}.json`; monthly filenames are `recap-{YYYY}-{MM}.json`.
