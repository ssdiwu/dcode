# D Code Third-Party Notices

D Code is source-visible proprietary software. The repository-root `LICENSE`
(copied to `D-Code-LICENSE.txt` in the application bundle) applies only to D
Code material owned by its copyright holder. The components below remain
governed by their own licenses.

## Embedded runtime

### Electron and its embedded Node.js / Chromium

The current macOS client uses the Electron version fixed in
`client/package-lock.json`; the Host runs using that executable's Node mode.
There is no separately embedded Node.js 22.22.3 binary. Candidate assembly
copies Electron's complete `LICENSE` and `LICENSES.chromium.html` into
`Contents/Resources/Legal/`, preserving the runtime's bundled notices.

### Pi 0.85.1

D Code uses the following packages from the Pi Agent Harness. The three direct
SDK packages are pinned to npm version `0.85.1`; transitive versions are recorded
in `host/package-lock.json`:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/chord` (transitive SDK dependency)
- `@earendil-works/pi-telemetry`
- `@earendil-works/pi-tui` (transitive package; D Code does not use it as its
  product UI)

License: MIT. Copyright (c) 2025 Mario Zechner. The complete notice is in
`legal/Pi-v0.84.1-MIT.txt` in the source repository. Its wording matches the
upstream v0.85.1 license; the filename retains the original audit version.

### grok-mermaid 0.2.2

- Project: <https://github.com/xl0/grok-mermaid>
- License: Apache License 2.0
- Copyright 2023-2026 SpaceXAI
- Copyright 2026 Alexey Zaytsev

The package's complete `LICENSE` is retained inside its embedded package and
is also archived under `D Code.app/Contents/Resources/Legal/host-licenses/`.

## Other npm production dependencies

The production graphs are fixed by `host/package-lock.json` and
`client/package-lock.json`. Candidate assembly records their package versions,
SPDX declarations and retained license filenames separately in
`Contents/Resources/Legal/host-npm-packages.txt` and `client-npm-packages.txt`.
Complete license and notice files are archived in `host-licenses/` and
`client-licenses/`, including dependencies bundled into renderer JavaScript.
Unknown license declarations and unreviewed missing license texts fail the build.

Some archives declare a license but omit its text. Their exact reviewed versions
and copyright attribution are retained in `legal/Missing-NPM-License-Notices.txt`.
This file, the Pi MIT notice and complete Apache 2.0 terms accompany the package
inventories in `Legal/`. Upstream Node and Electron notices are not replaced by
these npm inventories.

ViewInspector was used only by the retired Swift client tests. It is no longer
a current dependency and is not shipped in the Electron candidate; historical
Swift dependencies remain traceable in Git before the retirement commit.

This file is an attribution and distribution notice. It does not replace or
modify any third-party license.
