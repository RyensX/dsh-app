# Repository rules

- Do not edit files under `dsh/`. Update only the submodule gitlink after review.
- Build upstream dsh only in `.build/dsh-src/<commit>` through
  `scripts/prepare-resources.mjs`.
- Keep Bundled and Lite Node-provider code, frontend inputs, capabilities, and
  package resources compile-time isolated.
- Do not add remote Tauri capability URLs for the dsh WebView.
- Any submodule update requires both edition tests and the real runtime
  integration test before commit.
