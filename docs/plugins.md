# Bundled plugin contract

This document covers plugins compiled into DSH App. For third-party bundles
installed into the user's dsh profile, see [Remote plugin catalog](remote-plugins.md).

Each direct child of `plugins/` may contain `dsh-app.plugin.json`. The JSON
Schema is `schemas/dsh-app.plugin.schema.json`.

```json
{
  "$schema": "../../schemas/dsh-app.plugin.schema.json",
  "schemaVersion": 1,
  "id": "macos-helper",
  "enabled": true,
  "source": "src/index.ts",
  "entry": "dist/index.mjs",
  "client": {
    "source": "src/client.ts",
    "entry": "dist/client.js",
    "immediately": true
  },
  "targets": ["macos"],
  "editions": ["bundled", "lite"],
  "config": {}
}
```

Required fields:

- `schemaVersion`: currently `1`.
- `id`: globally unique kebab-case Cordis row id.
- `enabled`: build-time inclusion switch.
- `entry`: relative compiled Node-entry destination inside the generated
  package.
- `client`: optional browser half. Its entry is emitted in dsh's lazy-CJS
  module format and declared through the generated package's `dsh.client`
  metadata.
- `targets`: one or both of `macos` and `windows`.
- `editions`: optional Bundled/Lite build filter; omitted means both.
- `config`: JSON-serializable Cordis configuration.

`entry` is the relative compiled destination within the plugin's generated
Node package. `source` is optional and defaults to `entry`; it names the
TypeScript or JavaScript source that esbuild bundles as ESM. For example,
plugin `macos-helper` with `entry: "dist/index.mjs"` is packaged at
`dsh-runtime/node_modules/macos-helper/dist/index.mjs`. A `client` declaration
adds `exports["./client"]` and `dsh.client` metadata to that package so dsh can
compose it into `window.__DSH_BOOT__` and serve it from `/plugins/<id>/client.js`.

Only `enabled: true` manifests matching the current target and edition are
compiled. The same payload is injected into Bundled's embedded runtime and any
managed runtime built below `~/.dsh-app/runtime/dsh/`. The generated immutable
`plugins/index.json` is checked against
`runtime-manifest.json` at launch. Rust canonicalizes every entry and rejects
paths outside `dsh-runtime`.

The mutable patch is then atomically recreated under the user directory:

```json
[
  {
    "insert": [
      {
        "id": "macos-helper",
        "name": "macos-helper",
        "config": {}
      }
    ]
  }
]
```

JSON is valid YAML, so this is a Cordis patch-list accepted by dsh's official
`--patch` interface. The packaged runtime declares the generated plugin package
as a dependency, allowing dsh's existing profile fallback to resolve it. DSH
App never edits dsh configuration or invokes `dsh plugin add` at startup.
