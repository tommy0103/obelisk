# Desktop update research: Sparkle and electron-updater

Date: 2026-10-01. Scope: primary-source review for the accepted combination in
[ADR-0015](adr/0015-desktop-sparkle-and-electron-updater.md). No Obelisk updater
code, native rebuild, signed upgrade, key generation, or release was executed
for this research. Proposed integration details are separated from verified
upstream behavior below.

## Reviewed versions and reference implementation

Lody's pinned reference is commit
`c687e45ae6a59e27b5cc7431889c08b3231e9446`. Its service selects Sparkle for
packaged macOS when the bridge loads and initializes, otherwise initializes
electron-updater. It translates events into renderer state and provides an
explicit install action. Its JavaScript 30-minute timer belongs to the fallback;
the Sparkle branch enables Sparkle's scheduler and returns before that timer.
[Source](https://github.com/LodyAI/Lody/blob/c687e45ae6a59e27b5cc7431889c08b3231e9446/apps/electron/src/main/services/app-updater-service.ts)

Lody pins `electron-sparkle-updater` 0.5.1. Its September 19 note reports an
arm64 rebuild against Electron 39.5.1, explicitly without repeating packaged
end-to-end verification. The current reference package declares Electron
43.7.6; that declaration alone establishes no executed compatibility test.
[Historical verification](https://github.com/LodyAI/Lody/blob/c687e45ae6a59e27b5cc7431889c08b3231e9446/.agents/notes/implemented/process/2026-09-19-electron-sparkle-updater-0-5-1.zh.md),
[package](https://github.com/LodyAI/Lody/blob/c687e45ae6a59e27b5cc7431889c08b3231e9446/apps/electron/package.json).

Bridge 0.5.1 resolves to commit
`e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d`. It contains Sparkle 2.9.4 with a
maintained delta-chain patch, rather than an unmodified upstream framework.
Obelisk must validate this actual shipped dependency against its locked
Electron 43 runtime.
[Patch provenance](https://github.com/Innei/electron-sparkle-updater/blob/e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d/native/patches/README.md).

## Bridge contract and product behavior

The public bridge exposes `init`, `checkForUpdates`, `installUpdateNow`,
`installUpdateOnQuit`, `setAutomaticChecks`, and `setEventHandler`. Lifecycle
events include checking, available, progress, downloaded, unavailable, and
error. Progress can distinguish download from apply. Loading failure returns
null; there is no exposed cancellation, disposal, or allowed-channel setter.
[API](https://github.com/Innei/electron-sparkle-updater/blob/e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d/src/index.ts).

The native silent driver downloads an offered update and holds its installation
reply until the application calls install. This supports background download
and an explicit restart button without additional bridge API. Download reaching
100% is not readiness: extraction/validation precedes the downloaded event.
The signed Info.plist's `SUFeedURL` wins over `init.appcastUrl`; a runtime
`publicEdKey` cannot install a missing trusted public key. Native install/check
methods return void and catch some exceptions only in native logs, so return
alone cannot establish successful installation.
[Native implementation](https://github.com/Innei/electron-sparkle-updater/blob/e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d/native/src/sparkle_bridge.mm).

**Proposed:** use a stable channel, default automatic checks, background
download, and user-triggered restart. Configure `SUAutomaticallyUpdate=false`
to keep the silent-driver event path; 0.5.1 does not force that setting off in
`init`. Configure Sparkle's interval at least one hour, its documented minimum.
Keep the app's resource cleanup ahead of invoking native installation.
[Scheduler/settings](https://github.com/sparkle-project/sparkle-project.github.io/blob/02e5b5c62488d1ec6de65329a2e6c9afca762515/documentation/customization/index.md).

## Native packaging and fallback metadata

The package deliberately skips install-time node-gyp compilation. Its rebuild
CLI targets the consumer's exact Electron headers and selected arm64/x64 arch;
universal explicitly builds both then combines them. Node 22 build tools and
Electron's embedded Node 24 remain different targets.
[Rebuild implementation](https://github.com/Innei/electron-sparkle-updater/blob/e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d/src/cli.ts).

The builder fragment unpacks `native/build/Release/*.node`, copies the framework
to `Contents/Frameworks/Sparkle.framework`, excludes its vendor/archive copies
from asar, and injects the public key/feed into Info.plist. Its defaults disable
DMG/ZIP update info. **Proposed overrides for dual engines:** retain existing
unpack rules; set `dmg.writeUpdateInfo=true` and `zip.writeUpdateInfo=true`;
include builder's ZIP target and GitHub publish configuration while retaining
`--publish never`. Developer ID signing must cover the final framework/helper
layout; do not copy the library's ad-hoc signing hook as the distribution
signature. Generate fallback metadata against the finalized uploaded archive.
[Builder fragment](https://github.com/Innei/electron-sparkle-updater/blob/e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d/src/builder.ts).

electron-updater 6.6.2's MacUpdater uses a ZIP and native Squirrel.Mac. It detects
Rosetta/Apple Silicon and prefers arm64 assets on that hardware. **Proposed:**
merge and validate both architectures' `latest-mac.yml` entries, upload required
blockmaps. The implementation plan retains the stock fallback preference,
including x64-to-arm64 migration under Rosetta; Sparkle's architecture-specific
feed retains the installed build architecture. That difference requires an
explicit acceptance case rather than a promise that both preserve process.arch.
[Pinned MacUpdater](https://github.com/electron-userland/electron-builder/blob/e4d00c65b59343cc07e190469b4947d0fb352171/packages/electron-updater/src/MacUpdater.ts).

## Architecture feeds, release routing, and channels

The bridge release Action requires one current ZIP per architecture directory,
hardcodes `appcast.xml`, and can publish immediately when enabled. Its history
fetcher also hardcodes that filename. **Proposed:** first delivery uses separate
`appcast-arm64.xml` and `appcast-x64.xml`, generated with the underlying tools
in isolated directories, without deltas/history. Do not blindly apply the
Action to renamed feeds or combine same-version arm64/x64 entries.
[Action](https://github.com/Innei/electron-sparkle-updater/blob/e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d/action/action.yml),
[history fetcher](https://github.com/Innei/electron-sparkle-updater/blob/e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d/native/scripts/appcast-history.py).

Sparkle's `hardwareRequirements=arm64` requires Apple Silicon; it is not a
general architecture discriminator. Default-channel items are visible by
default; beta needs an allowed-channel delegate. Bridge 0.5.1 exposes no such
delegate API. Its enclosure URL fixer assumes stable numeric triplets, making
prerelease use another integration change.
[Feed semantics](https://github.com/sparkle-project/sparkle-project.github.io/blob/02e5b5c62488d1ec6de65329a2e6c9afca762515/documentation/publishing/index.md),
[URL fixer](https://github.com/Innei/electron-sparkle-updater/blob/e7a82fe864faae89cd58ef9abd1e52f8fa1ad82d/src/appcast.ts).

**Proposed:** embed the matching latest stable feed URL; use immutable versioned
URLs for archives. GitHub's latest endpoint excludes drafts/prereleases, but is
repository-wide, so CLI releases must not advance the desktop pointer or omit
its assets. GitHub supports `make_latest=false` for non-desktop publication.
[GitHub release API](https://docs.github.com/en/rest/releases/releases).

## Keys, rejection, and acceptance

Sparkle archive EdDSA signing is independent of Developer ID and notarization.
Generate/retain one owner-controlled key pair; bake `SUPublicEDKey` before code
signing and supply only the private key to signing automation. Official tools
support private-key export for CI. Existing Apple secrets cannot replace it.
[Key setup](https://github.com/sparkle-project/sparkle-project.github.io/blob/02e5b5c62488d1ec6de65329a2e6c9afca762515/documentation/index.md).

Require valid enclosure/archive signatures. The initial integration plan sets
`SUVerifyUpdateBeforeExtraction=true` and `SURequireSignedFeed=false`. Signing
the feed itself is optional later and separately enabled by `SURequireSignedFeed`, requiring
`SUVerifyUpdateBeforeExtraction`. Sparkle 2.9.4's `sign_update` embeds XML feed
signatures inside the XML; there is no necessary separate `.sig` asset. If
enabled, sign after all XML rewrites and verify the final feed; archive signing
does not authenticate its URL or release-note metadata.
[Signature tool](https://github.com/sparkle-project/Sparkle/blob/b6496a74a087257ef5e6da1c5b29a447a60f5bd7/sign_update/main.swift).

**Proposed security boundary:** choose fallback only when Sparkle cannot load
or initialize, before checking. A bad feed, download, or signature fails within
the chosen backend. Sparkle's authenticated delta-to-full fallback is distinct
from switching to electron-updater after rejection.

Test two isolated packaged versions against a local test feed baked before
signing, with isolated data and keys; no tag push is necessary. Lody supplies a
local ad-hoc harness, but it does not establish production Developer ID,
notarization, Intel, or data-preservation acceptance. Real signed upgrades for
both architectures and both backend selections remain unverified delivery
gates, alongside corrupted-signature rejection and cleanup failures.
[Local harness](https://github.com/LodyAI/Lody/blob/c687e45ae6a59e27b5cc7431889c08b3231e9446/apps/electron/scripts/verify-sparkle-update.mjs).

## Implementation verification, 2026-10-02

The implementation uses the pinned Sparkle bridge on Electron 43.2.0, with
the archive verifier and native installer exercised through copied packaged
apps. The earlier prospective lifecycle description is superseded by the
[current implementation document](desktop-app-update-plan.md): main now has the
#187 bounded deferred quit path; updates await real cleanup separately.

The official [Sparkle 2.9.4 Secret.swift](https://github.com/sparkle-project/Sparkle/blob/2.9.4/common_cli/Secret.swift)
accepts a 32-byte seed or a 96-byte legacy expanded-private/public layout.
Its sign_update malformed-key diagnostic mentions 64 bytes, but the actual
decoder rejects that layout. Node-generated Ed25519 seeds/signatures were
verified against official sign_update during the packaged acceptance tests.
The repository validates the actual decoder's formats without echoing key data.

electron-builder 26.15.3's actual schema rejects a top-level `zip` option.
The upstream builder helper is a useful source for framework/ASAR placement,
but cannot be copied wholesale. The integrated configuration retains builder's
default ZIP update metadata and enables DMG update metadata explicitly.
