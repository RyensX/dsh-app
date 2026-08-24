# Releasing

English | [中文](releasing.zh.md)

## Preconditions

- The `dsh/` gitlink is reviewed and clean.
- Both frontend graphs, both Rust feature suites, runtime closure checks, and
  the real dsh integration test pass.
- The plugin payload platform and target triple match the bootstrap manifest;
  this identity check must pass again against the mounted installer artifact.
- Every target is built on its native CI runner.
- Bundled and Lite artifacts use the same DSH App version, dsh commit, and
  plugin sources.

Unsigned development artifacts use:

```sh
node scripts/build-app.mjs --edition <bundled|lite> \
  --target <triple> --formal false
```

Final installers are published only under the flat `.build/installers/`
directory using this format:

```text
dsh-app-<bundled|lite>-<version>-<macos|windows>-<arm64|x64>.<dmg|exe>
```

The target-specific Tauri `release/bundle` directory is temporary and is
removed after the verified installer is published. Application identity and
user directories remain equal.
DMG assembly always uses CI-safe mode so Finder windows or an interactive local
desktop cannot hold the temporary read/write image open during packaging.

`.github/workflows/build-installers.yml` runs the six native target/edition
jobs on every push and uploads only the standardized file from
`.build/installers/`. Push builds are unsigned. A manual `workflow_dispatch`
may set `formal: true` when all signing and notarization secrets are available.

## Formal macOS build

`--formal true` refuses to run unless Developer ID signing variables and one
complete notarization credential set are present. Tauri consumes its standard
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and
Apple ID or App Store Connect API variables.

## Formal Windows build

Import the Authenticode certificate into the current user's certificate store,
copy `build/windows-signing.example.json` outside the repository, and fill in
the certificate thumbprint and issuer timestamp service. Then run:

```powershell
node scripts/build-app.mjs `
  --edition bundled `
  --target x86_64-pc-windows-msvc `
  --formal true `
  --signing-config C:\secure\windows-signing.json
```

An Azure Artifact Signing `signCommand` overlay may be supplied instead. A
formal Windows invocation fails before building unless the overlay contains
either a complete certificate/timestamp configuration or a `signCommand` with
Tauri's `%1` file placeholder. Placeholder values from the example are rejected.

## Runtime provenance

Bundled's Node is downloaded only from `https://nodejs.org/dist`, checked against
the exact entry in `SHASUMS256.txt`, and recorded with archive SHA-256 in
`runtime-manifest.json`. The DSH App AGPLv3 license, Node and dsh licenses, and
production npm notices are packaged under `licenses/`.

The `dsh-app-runtime` plugin derives its Git remote from the release repository's
`dsh` submodule declaration. Entering App Runtime clears stale discovery state;
only the explicit check action queries the selected Stable Tag or Latest default
branch channel, and only confirmation fetches and compiles the exact checked
ref. It does not update DSH App itself or move the submodule baseline.
