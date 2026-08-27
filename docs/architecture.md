# Architecture

English | [中文](architecture.zh.md)

## Release baseline

`scripts/prepare-resources.mjs` reads the clean `dsh/` submodule's exact commit,
matching tag, CLI version, Node engine, frozen package-manager version, and the
submodule URL declared by `.gitmodules`. It generates a signed
`bootstrap-manifest.json` for both editions. No runtime source URL is hardcoded
separately from that submodule declaration.

Bundled additionally creates a detached local clone, builds upstream, deploys
the production closure, removes source and temporary metadata, injects selected
app plugins, and packages `dsh-runtime/`. Lite packages no dsh files. Both
editions package the target-selected plugin payload, a small Corepack runner,
and the self-contained source runtime manager.

The Bundled production closure uses pnpm's hoisted `node_modules` layout so an
installer never publishes the repeated `.pnpm/<key>/node_modules` path. Managed
runtime updates keep the isolated pnpm layout and their existing builder
version. On Windows, packaged resources use the short `r/` container instead
of `resources/`; manifest entries remain relative to the resource stage and do
not change between platforms.

Plugin payload schema v2 keeps the build-selection `platform` (`macos` or
`windows`) separate from the runtime identity `targetTriple`. Resource and
artifact verification require the payload edition, target triple, platform,
digest, and plugin index to match `bootstrap-manifest.json`; a mismatched
payload therefore fails the build instead of failing on an installed App's
next launch.

The fixed baseline is identical:

```text
dsh submodule gitlink
        ├── Bundled embedded runtime
        └── Lite bootstrap commit
```

## Node providers

Cargo features `bundled` and `lite` are mutually exclusive.

- Bundled resolves only its Tauri Node sidecar.
- Lite checks an explicit `lite.json`, inherited `PATH`, common installation
  locations, and `~/.dsh-app/runtime/node/<version>/<platform>-<arch>/`. When no
  compatible candidate exists it downloads the pinned official Node archive
  and verifies the SHA-256 recorded at release build time.

The system discovery, picker, download errors and Lite configuration parser are
not compiled into Bundled.

## Common dsh resolver

After Node identity and ABI are known, both editions run the same resolver:

1. Read a pending update or restore action.
2. Validate the managed current pointer under `runtime/dsh/`.
3. Prefer any compiled managed runtime matching the target and Node ABI;
   Commit and Tag are update metadata, not startup compatibility checks.
4. Use the embedded runtime when the Bundled provider supplies one.
5. If no valid candidate exists, Git-fetch and build the bootstrap manifest's
   fixed commit from its recorded submodule repository.

Managed installs live below `runtime/dsh/installs/`. Their compiled dsh body is
retained; only the App-owned plugin layer is replaceable. When an App upgrade
carries a different plugin payload, startup refreshes those small local plugin
packages and their index, then uses the same compiled dsh runtime. A plugin
digest change never triggers Git, pnpm, or an upstream rebuild.
`runtime/dsh/source/` is a persistent Git checkout: the first build initializes
it, while later builds fetch and force-checkout the exact requested commit. The
working tree and ignored dependency/build caches survive both success and
failure. `runtime/dsh/staging/` contains only a pending production runtime;
publication and current/pending pointers are atomic. Startup does not query
remote tags, and requires Git only when it has to assemble the fixed baseline.
Dependency downloads use bounded concurrency and an extended request timeout;
the package store remains under `runtime/dsh/cache/` so a retry resumes from
verified cached content instead of restarting a cold download. Before invoking
upstream scripts, the packaged Corepack creates pinned pnpm shims under
`runtime/dsh/cache/pnpm-home/` and places that directory first on `PATH`, so
nested dsh build commands use the same pnpm `11.7.0` toolchain. Some upstream
package scripts spell their nested runner as `npm`/`npx`; App-owned POSIX and
Windows compatibility shims map those names back to pinned pnpm (`npx` to
`pnpm dlx`) rather than packaging or invoking npm.

## Runtime updates

`dsh-app-runtime` contributes a dsh settings section and a Host Remote service.
The browser calls that service through dsh's trusted `/api` connection, never
through Tauri IPC. Entering the **App Runtime** section clears the previous
discovery result without contacting upstream. Only the explicit check action
runs `git ls-remote`. The persisted **Stable** channel orders upstream `dsh-v*`
Tags and selects the latest Tag commit; **Latest** resolves the remote default
branch through symbolic `HEAD` and selects that branch's tip commit. The
discovery result remains in client memory and never fetches a source checkout;
exact commit identity alone decides whether an update is available.

Confirmed updates pass the selected Tag or branch plus its checked commit to
the manager. Git fetches that ref into isolated staging, verifies that it still
resolves to the checked commit, and only then compiles beside the running
process and creates `runtime/pending-action.json`. The current process continues until the user
chooses **Restart now** or later restarts the app. The Host writes a one-use
control request and asks `ctx.appExit` for a graceful exit. Tauri then starts the
whole desktop process again so the WebView begins from local bootstrap content
instead of racing two navigations away from a stopped loopback page. The new
process starts the pending candidate, commits it only after readiness, and
leaves the previous runtime available if startup fails.

Both editions expose restore only when the running commit differs from the App
baseline. Bundled switches to its embedded runtime. Lite prepares the baseline
commit through the same exact-ref Git builder, then switches on the restart
boundary. After readiness, Bundled removes all external dsh data; Lite keeps
only its active baseline install and removes the checkout, caches, staging and
other installs. Profiles, sessions and other user data are untouched.

When discovery finds a newer commit, the settings page also offers a localized
summary action. It writes a repository/compare prompt into the current
conversation draft and closes Settings; it never submits the prompt itself.
The section also owns the fixed command-line launcher action: it creates a
private wrapper bound to the active Node, dsh entry and `DSH_HOME`, opens the
platform terminal, and accepts no browser-provided command or path.

## Launch and trust boundary

dsh is spawned as:

```text
node dsh-runtime/lib/bin.js \
  --profile web \
  --patch ~/.dsh-app/runtime/plugins.patch.json \
  --port 0 \
  --no-open
```

The child inherits the normal environment while DSH App overwrites `DSH_HOME`,
sets the validated spawn-helper and runtime-manager facts, and removes
`NODE_OPTIONS` and `NODE_PATH`. Only an exact
`dsh web: http://127.0.0.1:<port>` readiness line is accepted.

The local bootstrap page alone receives edition-specific Tauri capabilities.
The dsh loopback origin receives none. HTTPS links open in the system browser;
all other unexpected navigations are denied. Unix process groups and Windows
Job Objects keep dsh, update builds and their descendants bounded by the app
lifecycle.

The bootstrap failure page can open the same cross-platform data root resolved
by `UserDirs` for the running App. The browser supplies no path, so this
affordance cannot select an arbitrary filesystem location.

The desktop shell restores and saves only the main window's size and position.
State is kept in `~/.dsh-app/window-state.json`; maximized, fullscreen,
visibility and decoration state are intentionally excluded.
