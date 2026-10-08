# Obelisk desktop updates

The implementation for [#209](https://github.com/tommy0103/obelisk/issues/209)
follows [ADR-0015](adr/0015-desktop-sparkle-and-electron-updater.md). The initial
scope was macOS arm64 and x64. The Debian extension below adds Linux amd64
`.deb` installs, with stable desktop releases hosted on GitHub.
The CLI retains its independent npm lifecycle. No version tag or release is
created as part of implementation verification.

## App behavior

Packaged macOS and Linux amd64 `.deb` apps automatically check and download
without forcing a restart. Development builds, Windows, AppImage and other Linux
architectures disable updates. Sparkle schedules hourly checks; electron-updater
backends check at startup and every
30 minutes. A manual check lives in Settings → About, alongside status, progress,
last check time and retry errors. The sidebar notice offers View changes, Later,
and Update & restart. Later keeps the validated download and its About action.
The next version becomes visible again. The notice floats above Settings without
changing the reader's layout; release notes open in an accessible in-app dialog.

The UI reuses Obelisk's existing surfaces, typography, spacing and accent tokens.
Its downloading/ready interactions follow
[Lody's sidebar updater](https://github.com/LodyAI/Lody/blob/c687e45ae6a59e27b5cc7431889c08b3231e9446/packages/components/src/components/sidebar-update-banner.tsx).
Release notes are treated as untrusted Markdown/HTML, rendered with bundled
Marked and DOMPurify, and allow no active content or media. User-initiated HTTPS
links use the existing main-process navigation guard. No remote script is needed
to render update notes.

## Runtime and restart ownership

`app/src/main/update-service.ts` owns snapshots, revision ordering, single-flight
checks/installs, deadlines, and stable-version eligibility. The sandboxed preload
exposes typed get/subscribe/check/install operations, with no renderer-supplied
feed URL, command, channel or destination. Subscriptions are removed on unmount;
renderer requests have rejection paths and deadlines. A newer pushed revision
cannot be overwritten by a late snapshot response.

`update-backends.ts` selects Sparkle (`electron-sparkle-updater` 0.5.1) first.
Only load/initialization failure selects `electron-updater` 6.6.2 for that
process. Feed, download, checksum and signature errors remain with the selected
backend. Sparkle's own native verification policy may authenticate with
Developer ID as well as EdDSA; that is distinct from switching JS backends.
Sparkle emits failure before its native session finishes dismissing; a retry
allows that session to settle. `autoInstallOnAppQuit` is false in the fallback.

Ordinary quit remains bounded by the existing five-second deferred quit helper
from #187. Update installation uses a separate completion gate: new mutations
are blocked, existing manual rebuild/settings operations finish, then the indexer
service becomes idle, watchers finish closing, the worker terminates and the
main DB closes. Only successful cleanup admits the native installer. A cleanup
failure or 30-second deadline keeps the app running and the download retryable.
If cleanup is still pending after a deadline, writes remain blocked until it
settles; it never starts a late install. Recovery respects auto-refresh settings
and cannot reopen resources after the user requested ordinary quit.

## Trusted keys and packaged assets

`app/build/sparkle-public-key.txt` is the trusted public key. Keep it across
releases; changing it requires an explicit key-rotation plan for installed apps.
The matching Actions variable is `SPARKLE_ED_PUBLIC_KEY`; the Actions secret is
`SPARKLE_ED_PRIVATE_KEY`. The private value is the exported Sparkle key text,
not another base64 encoding of that text. Current `generate_keys` exports a
32-byte seed in base64; the official legacy layout has 96 decoded bytes.
Apple signing/notarization credentials remain separate:
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.

`scripts/sparkle-packaging.mjs` rebuilds the bridge for the selected Electron
version/architecture, copies Sparkle.framework outside ASAR, unpacks the addon,
and writes the architecture feed and key into Info.plist before signing.
It checks that any repository public-key variable matches the committed key.
`SUAutomaticallyUpdate` is false, `SUVerifyUpdateBeforeExtraction` is true,
and delta history is disabled. Electron-builder emits the packaged
`app-update.yml`; DMG and ZIP targets retain update information/blockmaps.
Electron-builder 26.15.3 does not accept a top-level `zip` option, so the
upstream builder fragment's `zip.writeUpdateInfo` is not copied into config.

The build host remains Node 22. The lockfile's Electron 43.2.0 runs embedded
Node 24.18.0 / ABI 148 on both tested architectures. Native modules are verified
through the actual packaged executable, not inferred from the build host.

## Release workflow

`.github/workflows/release-app.yml` retains matching tag/app/lockfile versions,
native arm64 and Intel build runners, Developer ID signing, notarization,
DMG/ZIP verification and draft-only upload. Before building, it validates key
format, key pairing and the committed public key. After final archive signing,
official Sparkle 2.9.4 `sign_update` signs each ZIP and Node independently
verifies its Ed25519 signature with the trusted public key. The downloaded tool
archive is pinned by SHA-256. Private key files exist only in a protected runner
temporary directory and are removed by the step's EXIT trap.

`scripts/update-release.mjs` validates the collected archive names, versions,
architectures, lengths, hashes and signatures. It assembles
`appcast-arm64.xml` and `appcast-x64.xml`, each with one immutable versioned ZIP
URL. Feed URLs baked into the app use the corresponding asset under
`releases/latest/download`. There are no deltas or signed XML feeds in this
delivery; EdDSA authenticates the ZIP. One `latest-mac.yml` contains both
architectures, generated after collecting both builds so parallel manifests
cannot overwrite each other. Generated blockmaps are uploaded too. Release notes
come from the release draft body when final feeds are assembled.

Sparkle retains the installed architecture. Stock electron-updater prefers the
device's native architecture: an x64 app on Apple Silicon can migrate to arm64
when both archives are advertised. Intel devices must receive x64. Prerelease
drafts retain the existing packaging path but do not advance the stable latest
feed; prerelease update channels remain outside the initial runtime contract.
Published releases cannot be overwritten by a rerun. Editing release notes
after feed assembly requires regenerating the feed assets in the draft.

To validate signing without making a version tag or GitHub Release, dispatch
Release macOS App on the feature branch with `verify_only: true` and no tag.
Signing builds and repository/UI checks run independently; the Release upload
job requires both plus validated feeds. Verification-only mode
signs/notarizes both architectures and validates both feed formats, while
skipping the release job. Normal dispatch selects an existing app version tag as its workflow ref,
for example `gh workflow run release-app.yml --ref v0.2.4`. Every job checks out
the run’s immutable SHA; the optional tag input only checks consistency.
Publishing remains a separate maintainer action after acceptance. The repository's
latest stable Release must contain complete desktop packages and both feed
formats; a notes-only CLI release must not replace it.

## Verification

The root suite covers updater state, deadlines, cleanup, retries, key pairing,
feed separation and tamper rejection. All six Electron suites cover the actual
preload/UI, reader anchors, and existing reader interactions. PR CI runs both
native macOS architectures and real two-version updates with disposable fixtures:

```bash
node app/tests/packaged-updates.mjs sparkle arm64 \
  app/release/mac-arm64/Obelisk.app /path/to/Sparkle/bin/sign_update
node app/tests/packaged-updates.mjs fallback arm64 \
  app/release/mac-arm64/Obelisk.app /path/to/Sparkle/bin/sign_update
```

For x64 use `x64` and `app/release/mac/Obelisk.app`. On Apple Silicon with
Rosetta installed, append the packaged ARM64 app path to the fallback/x64
command to verify migration through a manifest containing both architectures
(with x64 first). The replacement must relaunch as ARM64 and preserve data. The harness copies the
packaged app into isolated versions, redirects HOME/userData in a fixture-only
bootstrap, serves localhost feeds, and clicks the actual renderer restart
action. It checks replacement version/architecture, relaunch, SQLite memory and
recap preservation, and invalid Sparkle signature rejection without another
backend. The fallback also checks an older advertised version without downloading
it before accepting a newer release. Disposable ad-hoc packages use a stable identifier requirement for
Squirrel; production packages retain Developer ID signing. Fixture keys are
deleted and successful temporary packages are cleaned up. Set
`OBELISK_KEEP_UPDATE_FIXTURES=1` only to inspect a local test's artifacts.

Report these tests separately from production Developer ID/notarization
verification. Rosetta x64 execution does not replace the native Intel CI runner.
Existing app versions need one manual installation of the first updater-enabled
version. DMG-mounted or read-only apps should be installed into a writable
Applications location before updating. No public release is needed for the
verification-only workflow or the local harness.

## Linux Debian release extension

The desktop release workflow also builds `Obelisk-<version>-linux-amd64.deb`
on Ubuntu 22.04 and installs/verifies it on Ubuntu 22.04 and 24.04 before draft
upload. The package declares its Electron runtime libraries and Polkit helper.
`latest-linux.yml` contains the verified Debian archive's SHA512, size, version,
and the same release notes as the macOS feeds.

Only packaged x64 applications carrying `resources/package-type=deb` enable
`DebUpdater`. They reuse background check/download, release notes, Later,
Update & restart, downgrade rejection and the cleanup/recovery lifecycle.
The system requests administrator authorization to replace `/opt/Obelisk`;
cancellation retains the staged update and reopens background resources for retry.
Existing 0.2.2 Linux installations need one manual upgrade to this version.

`app/tests/packaged-deb-updates.mjs` makes two disposable versions from the
actual Debian installer, redirects only their feed and test-home bootstrap,
and drives the shipped UI/preload/main. It verifies non-newer-release rejection,
SHA512 mismatch and retry, authorization cancellation, actual dpkg installation
through CI sudo, relaunch, and preserved memory/recap data. The authorization
helper is a test-only substitute for the desktop authentication dialog; the
DebUpdater installer command and system package manager are real. AppImage,
Linux arm64 and Windows automatic updates remain outside this delivery.
