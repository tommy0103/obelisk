# Obelisk for DeepSeek Harness

Installable distribution mirror of
[`@obelisk/dsh-obelisk-plugin`](https://github.com/tommy0103/obelisk/tree/main/packages/dsh-plugin).
It provides the Obelisk retrieval skill for DeepSeek Harness (DSH) and an
optional context-window rollover plugin.

This repository is generated from the Obelisk monorepo by GitHub Actions. Do
not edit it directly; changes are overwritten by the next publication.

## Prerequisite

Install the Obelisk CLI so `obelisk` is available on `PATH`:

```bash
npm install --global @obelisk-apps/cli
```

## Install

Clone this generated package, install its runtime dependencies, and add it to
the desired DSH profile:

```bash
git clone https://github.com/tommy0103/obelisk-dsh-plugin.git
cd obelisk-dsh-plugin
npm install --ignore-scripts
dsh plugin --profile web add --workspace-root "$PWD"
```

Replace `web` with another profile name if needed. The default bundle adds the
plugin-owned `obelisk` skill without changing DSH's normal tool surface.

## Optional context-window rollover

The context-window plugin is exported separately and is not mounted by the
default bundle. Add it only to an agent composition that should receive prose
handoffs, structured related-file references, pressure reminders, and safe
active-context rollover:

```yaml
- insert:
    - id: obelisk-context-window
      name: '@obelisk/dsh-obelisk-plugin/context-window'
```

That composition must disable `compaction-basic.auto`; manual `/compact` may
remain available.

See the
[source package documentation](https://github.com/tommy0103/obelisk/tree/main/packages/dsh-plugin)
for configuration, development, and uninstall instructions.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
