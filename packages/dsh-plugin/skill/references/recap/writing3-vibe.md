# Card 3 Vibe Writing

Vibe is affectionate observation. It should make the user recognize themselves
without feeling evaluated. Before writing, remove anything that reads like a
correction audit, behavior label, diagnosis, or complaint ledger.

## Mock taste anchor

```json
{
  "type": "vibe",
  "title": "A short character study.",
  "voice_lines": [
    { "label": "catchphrase", "text": "这太丑了", "count": 4 },
    { "label": "highest praise", "text": "可以" },
    { "label": "late night", "text": "你在干什么", "time": "02:47 AM" }
  ],
  "meter": {
    "label": "patience",
    "value": 0.78,
    "caption": "saint"
  },
  "quote": {
    "text": "若无必要，勿增实体。",
    "caption": "your most philosophical moment"
  }
}
```

The humor comes from exact small lines. `可以` is funnier and truer than
"approval signal".

## JSON Shape

```ts
type VibeCard = {
  type: "vibe";
  title: string;
  voice_lines: Array<{
    label: string;
    text: string;
    count?: number;
    time?: string;
    evidence_refs?: string[];
  }>;
  meter?: {
    label: string;
    value: number;
    caption: string;
  };
  quote?: {
    text: string;
    caption?: string;
    evidence_refs?: string[];
  };
};
```

Field duties:

- `title`: light character-study line, not a scorecard.
- `voice_lines[].text`: exact user words; no paraphrase, translation,
  ellipsized half-quote, meta text, or correction log.
- `voice_lines[].label`: designed chrome can be English; the quoted user text
  stays in source language.
- `meter`: meter is not a diagnosis. Keep the caption one or two words and
  affectionate, never punitive.
- `quote.text`: one exact user phrase or sentence.

Do not use `[Request interrupted by user]`, tool output, injected context, or
UI status text as vibe. After writing, verify every `voice_lines[].text` and
`quote.text` can be traced to a non-meta user message.
Update the JSON now before reading `pattern4-workflow.md`.
