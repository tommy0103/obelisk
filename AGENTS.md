# Working in this repository

Help contributors make informed decisions and deliver changes that fit the
project. Bring relevant conventions, established patterns, and verified facts
into the work when they matter. Before a consequential choice, explain the
relevant constraint, its practical effect, and the available options. Continue
routine work within the agreed scope; ask when an unresolved decision materially
changes behavior, compatibility, or scope. Respect decisions already made in the
current discussion. This guidance works with the contributor's chosen agent and
tools; it does not require a particular workflow skill.

## Before implementation

Read [CONTRIBUTING.md](CONTRIBUTING.md), starting with its
[intake policy](CONTRIBUTING.md#before-you-open-a-pull-request),
[cross-cutting requirements](CONTRIBUTING.md#six-things-that-decide-whether-a-pr-lands),
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
| Provider discovery, parsing, and history | [Provider requirements](CONTRIBUTING.md#provider-adapters), [canonical transcript contract](docs/adr/0007-canonical-transcript-session-detail-seam.md), and [retrieval semantics](skill-doc/references/retrieval-semantics.md) |
| Renderer and Electron | [Renderer requirements](CONTRIBUTING.md#renderer--electron-ui-changes), [main process and untrusted input](CONTRIBUTING.md#main-process-and-untrusted-input), and [Electron source/build decision](docs/adr/0005-app-electron-vite-ts-esm.md) |
| Schema, indexing, and write ownership | [Schema requirements](CONTRIBUTING.md#schema-and-migrations), [indexing requirements](CONTRIBUTING.md#indexing-daemon-and-write-ownership), and [transaction and concurrency contract](docs/adr/0006-write-transaction-rollback-and-concurrency.md) |
| CLI and query/tool interfaces | [Runtime contract](docs/adr/0002-two-tier-runtime-contract.md), authoritative [API reference](skill-doc/references/api-reference.md), [error message requirements](CONTRIBUTING.md#cli-and-tool-error-messages), and [CLI package guidance](packages/cli/README.md) |
| Performance changes | [Performance requirements](CONTRIBUTING.md#performance-changes) |
| Packaging, skills, and DSH integration | [Skill artifact decision](docs/adr/0004-skill-artifact-readable-not-bundled.md), [plugin contract](docs/adr/0012-obelisk-as-dsh-optional-retrieval-plugin.md), and [plugin package guidance](packages/dsh-plugin/README.md) |

## Before delivery

Revisit the [verification contract](CONTRIBUTING.md#verification-contract) for the
final change and use the applicable sections of the
[PR template](.github/pull_request_template.md). Resolve commands from the current
[root scripts](package.json) and [App scripts](app/package.json), and check the
actual [CI workflows](.github/workflows/) before reporting what is covered.

## Keep one home for each kind of guidance

This file owns reading directions and when to bring context into a decision.
`CONTRIBUTING.md` owns development and delivery rules; ADRs own architectural
decisions and their rationale. Improve the relevant source when a rule changes,
and update this index if the reading path changes. Keep detailed rules in that
source so contributors and agents consult the same standard.
