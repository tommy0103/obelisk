# DeepSeek Harness exposes Obelisk through a plugin-owned skill

**Context.** DeepSeek Harness (DSH) has native session-history capabilities,
while Obelisk provides a machine-local archive spanning supported agent
harnesses together with human-approved durable memory. The integration needs to
add that cross-harness retrieval channel without replacing DSH's native history
features or defining a different Obelisk query protocol. The shared Obelisk
skill establishes the common CLI, evidence, and memory-mutation boundaries, but
model guidance may evolve to use capabilities that exist only in DSH.

DSH also discovers skills from project and user-global roots. A user may have
installed Obelisk globally for another agent, producing a same-name candidate
under `~/.dsh/skills` or `~/.agents/skills`. The registry resolves duplicate
names to one winner, but its standard bundled rank is lower priority than those
user roots. The DSH plugin therefore needs to own the version presented through
its integration rather than letting an unrelated global installation select
its model instructions.

**Decision.** Maintain the DSH-facing `obelisk` skill and all of its resources
inside `packages/dsh-plugin/skill/`. This directory is a plugin asset, not a DSH
filesystem discovery root: opening the Obelisk repository does not make it a
second project skill. The skill begins from the shared Obelisk contract but has
its own lifecycle and may adopt DSH-specific guidance while preserving the
common CLI, evidence, and human-approved memory boundaries.

The build copies the complete plugin-owned tree to `dist/skill`, and the
runtime exposes that copied directory as the skill's resource base. Development
loads the same tree directly from the plugin directory. Neither mode reads the
skill installed globally for another agent.

The plugin registers its `obelisk` through DSH's runtime-skill API. DSH's
standard precedence produces one intentional order for duplicate names:
project-local skills, then the plugin runtime skill, then user-global skills.
The filesystem provider may continue to discover global candidates normally,
but the catalog and `skill` tool expose only the winning plugin definition for
`obelisk` unless the current project explicitly overrides it. This uses an
existing DSH capability and requires no DSH source change.

DSH presents the winning skill in its existing catalog and loads it through its
existing `skill` tool. After loading the instructions, the model uses DSH's
standard Bash tool to execute `obelisk --query "$qfile"`. The Obelisk CLI owns
query refresh and the retrieval data contract; DSH's Bash tool owns command
recording, permission handling, and presentation of stdout, stderr, and exit
status. The plugin's runtime prerequisite is the `obelisk` CLI on the DSH
process's `PATH`.

The package is an opt-in DSH bundle whose manifest points to its Cordis patch.
Installing a local checkout into a profile both links the package and enables
its plugin row; removing it withdraws both. The plugin directory is
self-contained so it can later be mirrored from the Obelisk repository into a
standalone distribution repository by GitHub Actions. That repository is a
distribution mirror, not a second hand-maintained source, and neither side uses
a Git submodule.

The integration preserves DSH's native session history as an independent
retrieval channel and introduces no settings namespace. Obelisk calls use
DSH's standard Bash presentation. A future dedicated presentation may be added
through a plugin-owned attribution or decoration seam that preserves the Bash
tool's identity and execution contract.

**Verification.** Package tests load the runtime contribution through DSH's
real skill registry, prove that it wins over a user-global same-name candidate
while retaining project-local override precedence, and verify every referenced
resource from the plugin-owned tree. Bundle tests pin the package manifest and
Cordis row. Build and pack verification confirm that the distributable contains
the complete skill tree and bundle patch. A DSH end-to-end session must be able
to install the local bundle, discover and load its skill, request normal Bash
permission when required, and complete a real Obelisk query.

**Consequences.** DSH gets a stable, self-contained Obelisk integration without
depending on machine-global instructions intended for other agents. Shared
Obelisk behavior still converges through the CLI and evidence contract, while
changes to DSH-facing guidance are reviewed as plugin changes instead of being
picked up implicitly. The checked-in skill tree is an intentional owned
artifact. A later standalone repository can be a release mirror without
changing runtime paths or package contents.
