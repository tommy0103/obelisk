# Card 2 Thinking Writing

Thinking Path should feel like a few bends in the user's reasoning, not a
weekly changelog. Before writing, test each row by asking: "what changed here?"

## Mock taste anchor

```json
{
  "type": "thinking_path",
  "title": "Five questions, five turns.",
  "items": [
    { "day": "Mon", "prompt": "为什么要把 session 编译成 wiki？", "turn": "raw SQLite, no wiki" },
    { "day": "Tue", "prompt": "buildWhere 是什么", "turn": "unified filter opts, not DSL" },
    { "day": "Wed", "prompt": "failures() 90% 误报", "turn": "is_error in JSONL" },
    { "day": "Thu", "prompt": "memory 层需要清理机制吗", "turn": "soft-delete, human-only" },
    { "day": "Fri", "prompt": "热力图不选中默认显示本月", "turn": "GitHub-style activity timeline" }
  ]
}
```

The prompts stay close to the user's words. Each turn is a short decision
fragment, not a full explanation.

## JSON Shape

```ts
type ThinkingPathCard = {
  type: "thinking_path";
  title: string;
  items: Array<{
    day: string;
    prompt: string;
    turn: string;
    evidence_refs?: string[];
  }>;
};
```

Field duties:

- `title`: designed deck line, not `本周路径`, not a research-paper heading.
- `prompt`: user's compact question, friction, or task. Use source language.
- `turn`: short decision fragment, finding, or shift; usually under 10 words.
  Compact English fragments are allowed when they work as designed chrome.

After writing, remove any row whose prompt is a workflow name or whose turn
describes implementation rather than changed thinking.
Update the JSON now before reading `pattern3-vibe.md`.
