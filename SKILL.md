---
name: obelisk-installer
description: Install the official Obelisk CLI and then install the Obelisk agent skill. Use only for initial setup or repair when the `obelisk` command is missing.
allowed-tools:
  - Bash
---

# Install Obelisk

This is a one-time bootstrap guide. It installs the local Obelisk runtime, then
uses that runtime to install the official agent skill from
`github.com/tommy0103/obelisk-skill`.

## 1. Check for the CLI

```bash
command -v obelisk >/dev/null 2>&1 && obelisk --version
```

If this succeeds, skip to step 3. Do not reinstall a working CLI unless the user
asked to upgrade or repair it.

## 2. Install the CLI

Installing a global command changes the user's machine. Show the command and get
the user's approval before running one of these official installation methods.

With npm, skip automatic skill setup so step 3 can use the user's chosen scope:

```bash
OBELISK_SKIP_SKILL_INSTALL=1 npm install --global @obelisk-apps/cli
```

On macOS, Linux, or WSL, the official installer performs the same CLI-only
installation and never installs an agent skill:

```bash
curl -fsSL https://raw.githubusercontent.com/tommy0103/obelisk/main/install.sh | sh
```

Never use `sudo`, install a daemon, or download Obelisk from another source.

Verify the result:

```bash
obelisk --version
```

## 3. Choose the skill installation scope

The standard skills installer defaults to the current project. Before running
it, tell the user about that default and ask whether `/obelisk` should be
installed:

- **For the current project only** — available only in the project where the
  installer runs.
- **Globally** — available across the user's projects.

Do not silently choose the current-project default. If the user already stated
the scope explicitly, use that choice without asking again.

Run the command that matches the user's answer:

Current project:

```bash
obelisk install
```

Global:

```bash
obelisk install --global
```

Pass through any additional target options the user requested. The command
uses the standard skills installer, so follow its prompts instead of copying
skill files by hand.

After installation, tell the user to reload their agent if the new `/obelisk`
skill is not discovered immediately. This bootstrap document is not the query
skill and must not answer session-history questions itself.
