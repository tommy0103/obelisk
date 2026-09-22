# zcode fixtures

`zcode-real-aggregate.sqlite` is the sanitized aggregate of twelve real-model
scenario fixtures produced by the zcode CLI 0.16.9 writer (Desktop 3.14.1
runtime) driven headless against a real bigmodel coding-plan account
(GLM-5.3), schema migration 0022. Seventeen sessions (interactive, subagent
children, a fork child, a selection-side chat), 91 messages, 228 parts, with
a rewind, a manual compaction chain, a mid-conversation model switch, tool
error/complete states, and an attachment.

Sanitization contract (applied per scenario before the merge, then re-gated
on the aggregate): timestamps shifted to a fixed epoch with order preserved,
paths rewritten to `/home/dev/...`, identity/hostname/machine tokens replaced
from a denylist, nix store hashes (base32) rewritten to a zero placeholder,
`VACUUM INTO` rebuild so freed pages cannot retain prior
content, and a final byte-scan that rejects any denylist token at any length.
Each scenario occupies its own one-hour window.

The source scenarios and the reproduction tooling live outside the repository
(`.obelisk/fixture-lab/` in the development workspace); see the zcode provider
design document for the inventory. The per-scenario split files are not
committed — the aggregate is the test corpus.

No production transcript is read by tests; the user's real zcode database is
never touched.
