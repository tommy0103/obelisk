# Working in this repository

Before a consequential choice, state the constraint, its practical effect, and
the options. Ask when an unresolved decision changes behavior, compatibility, or
scope; otherwise continue within the agreed scope and respect decisions already
made in the discussion.

## Before implementation

Read [CONTRIBUTING.md](CONTRIBUTING.md), starting with its
[intake policy](CONTRIBUTING.md#before-you-open-a-pull-request),
[cross-cutting requirements](CONTRIBUTING.md#six-things-that-decide-whether-a-pr-lands),
[runtime requirements](CONTRIBUTING.md#node-and-electron-runtimes),
[verification contract](CONTRIBUTING.md#verification-contract), and
[scope and review guidance](CONTRIBUTING.md#scope-and-review).
Then read the area-specific sections relevant to the task using the index below.
Read the associated issue discussion and applicable ADRs alongside the current
implementation. If they disagree, explain the discrepancy and its consequences
before making a decision that depends on it.

## Read as the work enters an area

| Area | Guidance |
| --- | --- |
| Architecture and shared boundaries | Applicable [ADRs](docs/adr/); for indexing, start with [provider and persistence layers](docs/adr/0001-parse-core-and-persist-layers.md) |
| Provider discovery, source roots, parsing, and history | [Provider requirements](CONTRIBUTING.md#provider-adapters), [indexing requirements](CONTRIBUTING.md#indexing-daemon-and-write-ownership), [canonical transcript contract](docs/adr/0007-canonical-transcript-session-detail-seam.md), and [retrieval semantics](skill-doc/references/retrieval-semantics.md) |
| Renderer and Electron | [Renderer requirements](CONTRIBUTING.md#renderer--electron-ui-changes), [main process and untrusted input](CONTRIBUTING.md#main-process-and-untrusted-input), and [Electron source/build decision](docs/adr/0005-app-electron-vite-ts-esm.md), and [desktop update decision](docs/adr/0015-desktop-sparkle-and-electron-updater.md) |
| Schema, indexing, and write ownership | [Schema requirements](CONTRIBUTING.md#schema-and-migrations), [indexing requirements](CONTRIBUTING.md#indexing-daemon-and-write-ownership), and [transaction and concurrency contract](docs/adr/0006-write-transaction-rollback-and-concurrency.md) |
| CLI and query/tool interfaces | [Runtime contract](docs/adr/0002-two-tier-runtime-contract.md), [bounded retrieval decision](docs/adr/0017-bounded-messages-and-default-retrieval-surface.md), authoritative [API reference](skill-doc/references/api-reference.md), [error message requirements](CONTRIBUTING.md#cli-and-tool-error-messages), and [CLI package guidance](packages/cli/README.md) |
| Performance changes | [Performance requirements](CONTRIBUTING.md#performance-changes) |
| Packaging, skills, and DSH integration | [Skill artifact decision](docs/adr/0004-skill-artifact-readable-not-bundled.md), [plugin contract](docs/adr/0012-obelisk-as-dsh-optional-retrieval-plugin.md), and [plugin package guidance](packages/dsh-plugin/README.md) |

## Before delivery

Revisit the [verification contract](CONTRIBUTING.md#verification-contract) for the
final change and use the applicable sections of the
[PR template](.github/pull_request_template.md). Resolve commands from the current
[root scripts](package.json) and [App scripts](app/package.json), and check the
actual [CI workflows](.github/workflows/) before reporting what is covered.

## What the tooling already enforces

These rules fail a command, so follow the error message instead of re-reading
the prose. `npm run lint` runs ESLint over every tracked JS/TS file (including
`app/`, excluding `.vue`) and then knip, twice: once over everything and once
in production mode (`!` entries in [knip.jsonc](knip.jsonc), tests excluded).

| Rule | Enforced by |
| --- | --- |
| No unused variables, imports, or `eslint-disable` directives | ESLint, `npm run lint` |
| No file, export, or dependency without a user; delete dead code rather than ignoring it | knip, `npm run lint` ([knip.jsonc](knip.jsonc)) |
| No production export whose only user is a test; tests import the defining module, and a deliberate test seam carries `/** @internal Exported for tests. */` | `knip --production`, `npm run lint` |
| Renderer JS/TS never assigns `innerHTML`/`outerHTML` or calls `insertAdjacentHTML` outside `renderMarkdown()` | ESLint `no-restricted-syntax` |
| Main process never calls `shell.openPath` | ESLint `no-restricted-properties` |
| Renderer images never use `loading="lazy"` | `tests/renderer-virtualized-rows.test.mjs` |
| No new synchronous IO in main-process modules, no new `v-html` | Budgets in `tests/app-source-budgets.test.mjs`; lower them when you remove a use |
| Every `app/tests/electron-*.mjs` suite runs in `test:electron:all` | `app/tests/run-electron-suites.mjs` discovers suites by name |
| `schema.sql` changes are deliberate | sha256 pin in `tests/provider-schema-stability.test.mjs` |

An exception goes on the offending line as an `eslint-disable-next-line` with
the reason above it. When a review catches a mistake that a check could catch,
add the check and a row here.

## Keep one home for each kind of guidance

This file owns reading directions and when to bring context into a decision.
`CONTRIBUTING.md` owns development and delivery rules; ADRs own architectural
decisions and their rationale. Improve the relevant source when a rule changes,
and update this index if the reading path changes. Keep detailed rules in that
source so contributors and agents consult the same standard.
