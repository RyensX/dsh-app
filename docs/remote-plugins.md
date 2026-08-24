# Remote plugin catalog

English | [中文](remote-plugins.zh.md)

`remote-plugins.json` at the repository root declares third-party dsh bundles
that DSH App installs remotely. It contains metadata only: the plugin packages
are not copied into the application resources or patched into the compiled dsh
runtime.

App-bundled plugins remain under `plugins/` and continue to use the trusted
`plugins.patch.json` path. Remote plugins are installed into the persistent
`web` profile under `~/.dsh-app/profile/profiles/web/` through dsh's official
`dsh plugin --profile web add ...` command.

## Format

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "name": "turtle-ui",
      "source": "github:deepseek-harness/turtle-ui#0123456789abcdef0123456789abcdef01234567",
      "policy": "default",
      "allowBuild": true,
      "targets": ["macos", "windows"],
      "editions": ["bundled", "lite"]
    },
    {
      "name": "@vendor/dsh-example",
      "source": "@vendor/dsh-example@1.2.3",
      "policy": "required",
      "targets": ["macos"]
    }
  ]
}
```

The build validates the root catalog and writes only entries matching the
current target and edition into the packaged `resources/remote-plugins.json`.

## Fields

| Field | Required | Meaning |
|---|---:|---|
| `schemaVersion` | yes | Catalog format version. The current value is `1`. |
| `plugins` | yes | Ordered remote plugin declarations. Package names must be unique. |
| `name` | yes | Expected installed `package.json.name`; also used for verification and ownership state. |
| `source` | yes | A pnpm source passed as one argument to `dsh plugin ... add`. See source rules below. |
| `policy` | yes | Either `default` or `required`. |
| `allowBuild` | no | Defaults to `false`. When `true`, DSH App adds the package name to the profile's pnpm `allowBuilds` map before installation. |
| `targets` | yes | One or both of `macos` and `windows`. |
| `editions` | no | Any combination of `bundled` and `lite`; omission means both. |

`default` plugins are installed automatically, but an installation failure
does not prevent dsh from starting. The failure is written to the DSH App log
and installation is retried on a later launch.

`required` plugins must be installed and verified before dsh starts. A missing,
conflicting, or invalid required plugin stops startup and is surfaced as a
retryable launch error.

## Source rules

Three source forms are supported:

- Bare npm package: `dshmarket` or `@vendor/dsh-example`.
- Exact npm version: `@vendor/dsh-example@1.2.3` or `dsh-example@1.2.3`.
- GitHub pnpm spec: `github:owner/repository` with an optional `#ref`.

A bare npm package follows the registry's current default version. Use an exact
version when the App release must reproduce the same package later.

For a reproducible release, pin GitHub sources to a full commit SHA:

```json
"source": "github:owner/repository#0123456789abcdef0123456789abcdef01234567"
```

A GitHub installation downloads repository sources into the user's pnpm store
and profile during installation; it does not add those sources to the DSH App
installer. A published npm package avoids a Git checkout and source build, but
its installed contents still depend on the publisher's package file list.

Git-hosted TypeScript packages commonly build through `prepare`. pnpm blocks
such lifecycle scripts unless explicitly allowed. Set `allowBuild: true` only
after reviewing and trusting the pinned source: this authorizes package code to
run outside the agent sandbox during installation.

## Package contract and ownership

Every remote package must be a dsh profile bundle. Its installed manifest must
declare a real patch file:

```json
{
  "name": "dsh-example",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

After dsh installs the package, DSH App verifies the package name, bundle patch,
profile dependency, and `dsh.profile.bundles` activation before recording it as
App-managed in `~/.dsh-app/runtime/remote-plugins.state.json`.

An existing user-installed dependency with the same name and a different
source is never overwritten. It is reported as a conflict. Entries removed
from the catalog are not automatically uninstalled in schema version 1.
