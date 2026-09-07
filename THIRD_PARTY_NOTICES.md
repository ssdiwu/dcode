# D Code Third-Party Notices

D Code is source-visible proprietary software. The repository-root `LICENSE`
(copied to `D-Code-LICENSE.txt` in the application bundle) applies only to D
Code material owned by its copyright holder. The components below remain
governed by their own licenses.

## Embedded runtime

### Node.js 22.22.3

- Project: <https://nodejs.org/>
- Source: <https://github.com/nodejs/node/tree/v22.22.3>
- License: MIT plus the licenses for externally maintained libraries listed in
  the Node.js distribution license.
- Binary distribution: D Code copies the unmodified complete Node.js 22.22.3
  `LICENSE` into `D Code.app/Contents/Resources/Legal/Node.js-LICENSE.txt`.

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
is also copied to `D Code.app/Contents/Resources/Legal/`.

## Other npm production dependencies

The exact production dependency graph is fixed by `host/package-lock.json`.
During application assembly, D Code preserves license files already shipped by
each package and generates
`Contents/Resources/Legal/npm-packages.txt`, containing every embedded package,
version, declared SPDX license, and retained license filenames. The build fails
if a package omits a license declaration or introduces a license outside the
reviewed allowlist.

Some upstream npm archives declare a license in `package.json` but omit a
license text. Their exact versions are listed in
`legal/Missing-NPM-License-Notices.txt`, which is copied into the application
bundle together with the applicable MIT and Apache 2.0 terms.

## Development-only Swift dependencies

### ViewInspector 0.10.3

- Project: <https://github.com/nalexn/ViewInspector>
- License: MIT. Copyright (c) 2020 Alexey Nekrasov.

`ViewInspector` is pinned by the root `Package.swift` and used exclusively by
the `PiDCodeTests` target for view-hierarchy assertions in `swift test`. It is
not linked into the `PiDCode` executable and is not distributed inside the
`D Code.app` bundle.

This file is an attribution and distribution notice. It does not replace or
modify any third-party license.
