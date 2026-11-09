# Card 4 Workflow Writing

Workflow is the orchestration card. It should show the strongest few workflow
runs and the user's reaction to them. Before writing, remove any row whose
reaction is not traceable to a visible user reaction.

## Mock taste anchor

```json
{
  "type": "workflow",
  "title": "Three workflows. Forty-two agents.",
  "deck": "你召唤了机器军团。结果各有不同。",
  "stats": "3 workflows · 42 agents",
  "items": [
    { "name": "hono-plugin-review", "reaction": "完美" },
    { "name": "vue-migration", "reaction": "你这页面完全和之前的不一样…" },
    { "name": "split-render-js", "reaction": "可以" }
  ],
  "verdict": "Mostly tolerated."
}
```

The row reactions are user reactions. The title carries the metric; the verdict
is a small English seal.

## JSON Shape

```ts
type WorkflowCard = {
  type: "workflow";
  title: string;
  deck?: string;
  stats?: string;
  items: Array<{
    name: string;
    reaction: string;
    evidence_refs?: string[];
  }>;
  verdict: string;
};
```

Field duties:

- `title`: human story line or compact metric line.
- `deck`: optional second line; do not repeat stats mechanically.
- `stats`: compact count line.
- `items[].name`: actual workflow name, command name, or run-id prefix.
- `items[].reaction`: exact or lightly trimmed user reaction. Preserve source
  language. No feature description, implementation summary, agent count,
  duration, "framework switch", "modularization", "theming landed", or other
  internal progress label.
- `verdict`: compact seal based on the row reactions, often 3-6 words.

Agent counts belong only in `title` or `stats`, never in `items[].reaction`.
These row values are invalid because they are implementation labels, not user
reactions:

- `13 agents, the big build` is invalid.
- `9 agents, framework switch` is invalid.
- `6 agents, modularization` is invalid.
- `theming landed` is invalid.

If no user reaction exists, omit the row rather than write an implementation result.
After writing, check that every row name maps to retrieval evidence and every
reaction can be read as quoted user verdict text.
Update the JSON now before reading `pattern5-closing.md`.
