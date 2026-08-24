# DSH App bundled plugins

Third-party bundles installed from npm or GitHub are declared separately in
the repository-root `remote-plugins.json`; see `docs/remote-plugins.md`.

Each direct child directory is one optional build-time plugin. A plugin is
selected only when its `dsh-app.plugin.json` has `enabled: true` and its
`targets` contains the current build target (`macos` or `windows`). Plugins that
do not match are not copied into the application package.

Example manifest:

```json
{
  "$schema": "../../schemas/dsh-app.plugin.schema.json",
  "schemaVersion": 1,
  "id": "example-plugin",
  "enabled": true,
  "source": "src/index.ts",
  "entry": "dist/index.mjs",
  "client": {
    "source": "src/client.ts",
    "entry": "dist/client.js",
    "immediately": true
  },
  "targets": ["macos"],
  "config": {}
}
```

The build bundles the Node half into ESM and an optional browser half into the
lazy-CJS format consumed by dsh's client module loader. Imports shared by dsh
remain external and resolve from its runtime module tables. Each selected
plugin is installed as a real package at `dsh-runtime/node_modules/<id>`;
the runtime manifest declares it as a dependency so dsh's profile module
fallback can resolve the package by name.

At launch, DSH App recreates `~/.dsh-app/runtime/plugins.patch.json` from the
packaged plugin index and passes it through dsh's official `--patch` option.
Patch entries use the package name, allowing dsh to discover `dsh.client`
metadata and serve the browser bundle through its standard `/plugins` route.
There is no runtime plugin switch in the first release.
