# Obelisk Recap Overview

Use this only when the first word after `/obelisk` is `recap`. Everything after
`recap` is the target period or style hint.

## Highest Priority: Phase Loop

This workflow is sequential. Do not preload all recap files. Do not gather all
evidence first and write all cards at the end.

Follow this loop exactly:

1. Resolve the target period from the user's phrase.
2. Run only a tiny orientation pass such as `overview({ limit: 6 })`.
3. For Card 1, read `pattern1-cover.md`.
4. Retrieve only Card 1 evidence.
5. Read `writing1-cover.md`.
6. Update/write the JSON for Card 1 now.
7. Only after the JSON is updated, move to Card 2 and repeat.

Card order:

| card | retrieve | write |
|---|---|---|
| 1 cover | `pattern1-cover.md` | `writing1-cover.md` |
| 2 thinking | `pattern2-thinking.md` | `writing2-thinking.md` |
| 3 vibe | `pattern3-vibe.md` | `writing3-vibe.md` |
| 4 workflow | `pattern4-workflow.md` | `writing4-workflow.md` |
| 5 closing | `pattern5-closing.md` | `writing5-closing.md` |

The per-card files own retrieval details, JSON field duties, and card-specific
taste. Do not move those concerns back into this file.

## Period Targets

- `this week`, `last week`: calendar week in the user's runtime timezone.
- `this month`, `last month`: calendar month in the user's runtime timezone.

Do not infer timezone from examples, UTC suffixes, or file timestamps when
runtime/session timezone is available.

## Overall Deck Taste

This is a Spotify Wrapped-like set of personal share cards: concise, designed,
slightly playful, and built to make the user's work feel seen.

Do not criticize the user. Do not scold, diagnose, rank their personality, or
turn friction into a performance review.

Use designed English chrome where it feels like card UI: week/month labels,
archetype labels, compact stats, verdict seals, and signoffs. Preserve the
user's own language for prompts, quotes, catchphrases, and reactions. This is
not a translation task.

The deck should feel like a small artifact from someone who noticed the week,
not a report generated from a database.

## Archetypes

Choose one dominant archetype from the period's dominant attention, not from the
current recap-generation session.

| archetype | when it fits | tone baseline |
|---|---|---|
| `architect` | structure, boundaries, schema, systems | matter-of-fact structural pride |
| `debugger` | symptoms, false positives, root-cause loops | wry and bug-comfortable |
| `shipper` | dense implementation cadence | energetic but not breathless |
| `curator` | organization, memory, docs, refinement | reflective and precise |
| `director` | workflows, subagents, orchestration | observant from a slight remove |
| `cartographer` | moving boundaries and redrawing maps | patient and surveyor-like |
| `wanderer` | many projects without one center | gentle, exploratory |

If two fit, pick the one that describes what the user spent more thinking time
on, not what shipped.
