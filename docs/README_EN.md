# DSH App

[中文](../README.md) | **English**

DSH App is a desktop client for [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness), built with Tauri 2.

The project aims to provide a stable and easy-to-use client environment for dsh. Apart from the desktop shell itself, all features are built on standard DSH without modifying dsh, ensuring 100% compatibility. You can also update the dsh source freely to keep up with upstream changes.

It currently supports macOS arm64/x64 and Windows x64, with two package editions:

- **Bundled**: Ready to use out of the box. It includes a pinned official Node distribution and a production dsh runtime built from the submodule commit, while still supporting dsh runtime updates.
- **Lite**: Smaller and includes neither Node nor dsh. It prefers a compatible system Node; if none is available, it downloads the same pinned official Node version. On startup, it automatically fetches and builds the dsh source.

Both editions share the same application identifier, user data, managed dsh updates, and bundled app plugins, so they can be installed over each other freely.

The project publishes releases periodically. To try the latest improvements, you can also open the CI run for any push and download its automatically built packages.

macOS users should read the [macOS first-launch authorization guide](macos-installation.md) before opening the app for the first time.

## Features

- **Desktop experience**: Automatically starts and manages local dsh on macOS and Windows.
- **Two editions**: Bundled works out of the box, while Lite is smaller and can reuse a system Node installation or use dsh source directly from its remote repository.
- **dsh runtime updates**: Supports Stable and Latest channels, with in-app checks, installation, restart, and restore options under **App Runtime** in Settings.
- **Persistent user data**: Configuration, credentials, sessions, and workspaces are stored outside the application directory, so installing over or uninstalling the app does not remove them.
- **Curated bundled plugins**: Includes selected dsh plugins that improve functionality and the overall experience.

## Development

```sh
git submodule update --init --recursive
corepack pnpm@11.7.0 install --frozen-lockfile
pnpm dev:bundled
pnpm dev:lite
```

Build unsigned installers on a matching native runner:

```sh
node scripts/build-app.mjs \
  --edition bundled \
  --target aarch64-apple-darwin \
  --formal false
```

Supported target triples are `aarch64-apple-darwin`, `x86_64-apple-darwin`, and `x86_64-pc-windows-msvc`. Final installers are written to `.build/installers/` and named `dsh-app-<bundled|lite>-<version>-<platform>-<architecture>.<dmg|exe>`; Tauri's `target/.../bundle/` directory is used only for temporary build output. GitHub Actions automatically packages every native target and edition on each push.

## Verification

```sh
pnpm check
node scripts/verify-resources.mjs
pnpm test:integration
pnpm test:integration:managed
```

After unpacking the application package:

```sh
node scripts/verify-artifact.mjs --edition bundled --path /path/to/app
node scripts/verify-artifact.mjs --edition lite --path /path/to/app
```

The Lite verifier rejects any Node executable or dsh runtime. The Bundled verifier requires both and checks that the embedded commit matches the submodule baseline.

## User Directory

macOS:   ~/.dsh-app/
Windows: %USERPROFILE%\.dsh-app\

```text

.dsh-app/
├── profile/                              # DSH_HOME
├── workspace/                            # Initial dsh working directory
├── logs/dsh.log                          # 10 MiB, with five backups retained
├── config.json                           # App preferences, including runtime channel
├── app-update.json                       # App release-check cache and dismissed version
├── updates/<release>/                    # Downloaded App installers awaiting user launch
├── window-state.json                     # Remembered window size and position
├── lite.json                             # Optional explicit Lite Node path
└── runtime/
    ├── dsh/
    │   ├── source/                       # Persistent Git working tree
    │   ├── cache/                        # Reusable package-manager cache
    │   ├── staging/                      # Pending production runtime only
    │   └── installs/                     # Published managed runtimes
    ├── node/<version>/<platform>-<arch>/ # Lite-managed fallback Node
    ├── control/
    ├── pending-action.json
    └── plugins.patch.json
```

Configuration, credentials, sessions, generated patches, and workspaces are never written into the application package. Removing a managed dsh runtime does not remove user data.

## Related Projects

[LinuxDo](https://linux.do/)

[dsh-market](https://github.com/dsh-market/dsh-market)

[dsh-message-fold](https://github.com/RyensX/dsh-message-fold)

[dsh-message-navigation](https://github.com/RyensX/dsh-message-navigation)

[dsh-resize](https://github.com/RyensX/dsh-resize)

[dsh-remote-gateway](https://github.com/RyensX/dsh-remote-gateway)

## License

[GNU Affero General Public License version 3](../LICENSE)
