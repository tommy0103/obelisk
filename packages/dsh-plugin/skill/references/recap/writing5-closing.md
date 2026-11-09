# Card 5 Closing Writing

Closing is a receipt, not a second summary. Before writing, read the headline
alone. If it does not mean anything without the rest of the card, add the unit
or choose a better line.

## Mock taste anchor

```json
{
  "type": "closing",
  "headline": "19 days",
  "receipts": ["847 messages exchanged", "12 corrections · 47 approvals"],
  "most_said_phrase": "好的开始做吧",
  "signoff": "See you next week."
}
```

This works because `19 days` has a unit, the receipts feel like a small receipt,
and `See you next week.` is a quiet goodbye instead of a slogan.

## JSON Shape

```ts
type ClosingCard = {
  type: "closing";
  headline: string;
  receipts: string[];
  most_said_phrase?: string;
  signoff: string;
  evidence_refs?: string[];
};
```

Field duties:

- `headline`: compact stat or phrase with its unit; not a naked number.
- `receipts`: at most two `receipts`, compact and personal.
- `most_said_phrase`: complete phrase the user actually said, or omit it.
- `signoff`: short and earned; quiet goodbye, not advice or a brand slogan.
  English signoff chrome such as `See you next week.` is allowed.

After writing, remove internal scope notes from visible fields and put them in
`evidence`. The final card should feel like the deck ending, not the report
continuing.

Final save rules:

- The file contains only the JSON object: no Markdown fence, no prose.
- Keep exactly five cards in this order: cover, thinking_path, vibe, workflow,
  closing.
- Keep private SQL, raw tool output, secrets, long paths, and source caveats out
  of visible card text; put traceability in `evidence`.
- After saving, reply briefly with the saved path and important evidence caveats.
