# Desktop updates use Sparkle on macOS with an electron-updater fallback

**Status.** Accepted on 2026-10-01; runtime and release integration are implemented for issue [#209](https://github.com/tommy0103/obelisk/issues/209).

**Context.** Obelisk has an Electron desktop app, separate CLI releases, and a
macOS release workflow that builds signed and notarized arm64 and x64 packages
into a GitHub Release draft. Existing app installations cannot discover or
install updates. The contributor selected Sparkle plus `electron-updater`,
following [Lody's desktop updater](https://github.com/LodyAI/Lody/blob/c687e45ae6a59e27b5cc7431889c08b3231e9446/apps/electron/src/main/services/app-updater-service.ts).

**Decision.** Packaged macOS apps use Sparkle through
`electron-sparkle-updater`. If the native bridge cannot load or initialize at
startup, select `electron-updater` for that process. Windows and Linux will use
`electron-updater` when their release pipelines are added; the initial delivery
covers macOS arm64 and x64. Keep one updater service in the main process and one
typed state/command interface through the existing sandboxed preload.

Backend selection happens before a check or download. An invalid feed, failed
download, or rejected signature is an error in the selected backend; it never
triggers another backend to retry the same update. This preserves the update
verification boundary. Release builds must contain a working Sparkle bridge,
framework, and public key even though a runtime fallback exists.

Use GitHub Releases to host versioned packages and update feeds. The initial
channel is stable. Both backends must select an architecture compatible with
the device, reject downgrades, and expose only complete published desktop
releases. Drafts remain the review boundary. CLI publication does not advance
the desktop update feed.

Apple Developer ID signing and notarization remain required for distribution.
Sparkle adds an independent EdDSA update-signing key pair: the app contains the
public key and release automation alone receives the private key. Protect and
retain that private key across releases; changing the trusted public key needs
an explicit upgrade/rotation plan for already-installed apps. The existing
Apple certificate and app-specific password do not replace this key pair.

Automatically check and download updates without forcing a restart. The app
offers a manual check in Settings and an actionable notice when an update is
ready. Installation waits for index writes and resource cleanup to complete;
a cleanup failure or deadline expiry keeps the app running with a retryable
error. Reuse the indexing ownership and transaction rules in
[ADR-0006](0006-write-transaction-rollback-and-concurrency.md).

**Trade-off.** Using only `electron-updater` would fit the existing
electron-builder and Developer ID setup with fewer packaging steps. The chosen
combination follows Lody's native macOS update approach and retains a backend
for the other desktop platforms. It adds native bridge/framework packaging,
EdDSA key management, two feed formats, and verification of both macOS backends.
These are owned parts of the release pipeline, rather than optional downstream
setup for users.

**Verification.** In addition to repository and Electron suites, exercise real
two-version upgrades for both native macOS architectures, the initialized
fallback backend, and signature rejection. Confirm the replacement app's
version and architecture and the preservation of the user's existing data.
Source tests and successful packaging alone do not prove installation works.
Existing installations require one manual installation of an updater-enabled
version. Implementation and acceptance details live in the
[desktop update plan](../desktop-app-update-plan.md), with primary-source
evidence in the [research note](../desktop-app-update-research.md).
