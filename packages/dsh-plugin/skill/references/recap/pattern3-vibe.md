# Card 3 Vibe Retrieval

Goal: find small human signals in visible user messages. Vibe is not a correction log, not bracketed runtime text, and not a psychological profile.

Look for:

- catchphrases and repeated tiny reactions;
- unusually blunt praise or rejection;
- late-night disbelief, jokes, or rituals;
- one quotable sentence that captures the period's character.

Only count visible user messages. Helper APIs omit meta by default, but custom
SQL for phrase counts must filter user text with `COALESCE(m.is_meta,0)=0` and
`m.content_type='text'`. Do not count tool results, injected command envelopes,
UI labels, or bracketed runtime strings.

Useful retrieval:

- targeted phrase counts after you notice a likely catchphrase;
- `thread(sessionId)` around high-energy moments;
- `search()` for exact phrases, then `context()` for timing;
- a bounded SQL count only after reading `references/schema.md`.

Read this card's writing file immediately after you have the small user signals:
`references/recap/writing3-vibe.md`. Then update the JSON `vibe` card and add
evidence for every quote, count, and timestamp.
Do not read `pattern4-workflow.md` until this JSON update is done.

Stop when every observation is either exact user words or a tiny label backed by
exact user words.
