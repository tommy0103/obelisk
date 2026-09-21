# @obelisk/dsh-obelisk-plugin

Optional Obelisk skill provider for DeepSeek Harness (DSH). The plugin owns and
bundles its [DSH-facing `obelisk` skill](https://github.com/tommy0103/obelisk/blob/main/packages/dsh-plugin/skill/SKILL.md),
then contributes it to DSH's standard skill registry.

The default integration intentionally adds no dedicated model tool, system-prompt
section, frontend tool card, or DSH source change. Once the model loads the
skill through DSH's existing `skill` tool, it follows the same
`obelisk --query ...` Bash workflow used in every other supported agent
harness. See [ADR-0012](../../docs/adr/0012-obelisk-as-dsh-optional-retrieval-plugin.md).

## Prerequisite

Install the Obelisk CLI so `obelisk` is available on `PATH`:

```bash
npm install --global @obelisk-apps/cli
```

The local plugin flow also requires the `dsh` CLI and pnpm on `PATH`.

The plugin already carries the complete skill bundle, including its referenced
documents. A separate `obelisk install` is not required for DSH.

## Install locally

After cloning the Obelisk repository, run this one command from its root to
install dependencies, build the plugin, and add the local checkout to the
`web` profile:

```bash
npm ci && npm run build:core && npm run build --workspace @obelisk/dsh-obelisk-plugin && dsh plugin --profile web add --workspace-root "$PWD/packages/dsh-plugin"
```

Replace `web` with another profile name if needed. The package declares its
Cordis patch as a DSH bundle, so `dsh plugin add` both links the local package
and enables its plugin row; no recurring `--patch` argument is required.

Verify the composed layer, then start that profile normally:

```bash
dsh --profile web --dump-config
dsh --profile web
```

The default row is opt-in; without it, DSH behaves exactly as before. The root
plugin has no configuration or settings page.

## Optional context-window rollover

The package also exports a separate context-window plugin. It is not part of
`obelisk.cordis.yml` and is never mounted by the normal installation above.
Add another profile row only for an agent composition that should receive
prose handoffs, pressure reminders, and safe active-context rollover:

```yaml
- insert:
    - id: obelisk-context-window
      name: '@obelisk/dsh-obelisk-plugin/context-window'
```

That composition must disable `compaction-basic.auto`; the extra plugin fails
fast if it detects the competing automatic policy. Manual `/compact` may
remain available. The extra plugin derives its default reminder, fallback, and
output reserves from the effective model `maxTokens`. A profile can override
any reserve explicitly:

```yaml
- insert:
    - id: obelisk-context-window
      name: '@obelisk/dsh-obelisk-plugin/context-window'
      config:
        reminderThresholdTokens: 8192
        fallbackReserveTokens: 8192
        outputReserveTokens: 8192
```

The extra plugin never changes Obelisk's schema. After rollover it retains a
prose handoff plus the canonical Obelisk `session_id` and `message_uuid` needed
to recover older evidence through the bundled skill.

## Uninstall

Remove both the local dependency and its bundle layer with one command:

```bash
dsh plugin --profile web remove --workspace-root @obelisk/dsh-obelisk-plugin
```

Restart the profile after installing or removing the plugin.

## Model experience

DSH advertises `obelisk` in its normal skill catalog. When session history or a
past decision may help, the model loads that skill through the normal `skill`
tool and receives the plugin-owned Obelisk instructions. The skill then uses the
ordinary Bash tool to run the CLI.

The plugin registers its own `obelisk` as a DSH runtime skill. DSH still scans
its normal global skill roots, but a same-name skill installed in
`~/.dsh/skills` or `~/.agents/skills` remains shadowed by the plugin version;
the model sees and loads one winning `obelisk`, not two conflicting bodies. A
project-local `.dsh/skills/obelisk` or `.agents/skills/obelisk` remains an
explicit higher-priority override.

The plugin's `skill/` directory is not a DSH discovery root by itself. It is an
asset read and registered by this plugin, so merely opening the Obelisk
repository does not create another project skill. The DSH-facing skill starts
from Obelisk's shared retrieval contract but has its own lifecycle and may
adopt DSH-specific guidance while preserving the common CLI, evidence, and
human-approved memory boundaries.

The Obelisk repository remains the source of this plugin directory. GitHub
Actions synchronizes an installable distribution mirror to
[`tommy0103/obelisk-dsh-plugin`](https://github.com/tommy0103/obelisk-dsh-plugin);
no Git submodule or second hand-maintained source is required.

## Presentation

Obelisk commands remain visibly ordinary Bash calls. DSH's current keyed tool
view API can replace the complete Bash renderer but cannot decorate only
recognized Obelisk commands. This integration does not change DSH or introduce
a second tool identity merely to obtain branding.

## Limitations

- Obelisk is a local snapshot archive; just-finished sessions appear after its
  next index refresh.
- The plugin-owned skill intentionally exposes the same machine-wide archive and
  human-approved memory flow as other harnesses.
- If the CLI is absent, the standard Bash call reports the command failure.

## Development

```bash
npm ci
npm run build:core
npm run typecheck --workspace @obelisk/dsh-obelisk-plugin
npm run build --workspace @obelisk/dsh-obelisk-plugin
node --experimental-test-module-mocks --test tests/dsh-plugin.test.mjs
node --experimental-test-module-mocks --test tests/dsh-context-window-plugin.test.mjs
```
