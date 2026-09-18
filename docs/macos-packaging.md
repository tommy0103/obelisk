# macOS package signatures

Build the App with `pnpm --dir app dist:mac`, then run
`pnpm --dir app verify:mac` on macOS. The verification command extracts each ZIP,
mounts each DMG read-only, and checks the contained App with
`codesign --verify --deep --strict`. It does not modify the installation or disable
Gatekeeper.

Default macOS builds use an explicit ad-hoc identity (`-`) to sign the entire
final bundle, including nested Electron frameworks and native dependencies.
Without a signing identity, electron-builder can skip signing and leave the
Electron executable's original linker signature in a modified bundle. Such an
artifact can fail verification with "code has no resources but signature
indicates they must be present", even though packaging succeeded.

The default disables Hardened Runtime for ad-hoc builds. This avoids enforcing
Developer ID library validation for a build that has no Developer ID team.
The missing `build/icon.icns` override is removed so packaging can use the default
icon; a project icon can be configured when that asset is available.

An ad-hoc signature seals the files; it does **not** verify the publisher's
identity or grant Apple notarization. A browser-downloaded App can still be
blocked by Gatekeeper. Passing the signature check is not a claim that a fresh
Mac will accept the App without user intervention.

## Developer ID distribution

To use an Apple-issued identity instead of the default ad-hoc signature, override
`mac.identity` explicitly and enable `mac.hardenedRuntime` when building. For
example, with an existing Developer ID Application identity in the build keychain:

```sh
pnpm --dir app exec electron-builder --mac \
  -c.mac.identity='Developer ID Application: YOUR VERIFIED NAME (TEAMID)' \
  -c.mac.hardenedRuntime=true
```

Run this after building with electron-vite. Configure notarization credentials using the
[electron-builder v26 documentation](https://www.electron.build/v26/docs/notarization/).
The default ad-hoc setting intentionally does not select a personal certificate
from the local keychain automatically.

Developer ID/notarized distribution additionally requires Gatekeeper assessment
and notarization-ticket validation; `verify:mac` checks signature integrity only.
This change does not configure or validate Apple-issued signing credentials.
