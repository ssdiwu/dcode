#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST_DIR="${ROOT_DIR}/host"
DIST_DIR="${PI_DCODE_DIST_DIR:-${ROOT_DIR}/dist}"
APP_DIR="${DIST_DIR}/D Code.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
HOST_RESOURCES_DIR="${RESOURCES_DIR}/host"
LEGAL_RESOURCES_DIR="${RESOURCES_DIR}/Legal"
APP_ICON_FILE="${ROOT_DIR}/app/Resources/AppIcon.icns"
NODE_BIN="${PI_DCODE_NODE_BIN:-${HOME}/.hermes/node/bin/node}"
NODE_ROOT="$(dirname "$(dirname "${NODE_BIN}")")"
NODE_LICENSE_FILE="${PI_DCODE_NODE_LICENSE:-${NODE_ROOT}/LICENSE}"
D_CODE_LICENSE_FILE="${ROOT_DIR}/LICENSE"
THIRD_PARTY_NOTICES_FILE="${ROOT_DIR}/THIRD_PARTY_NOTICES.md"
PI_LICENSE_FILE="${ROOT_DIR}/legal/Pi-v0.84.1-MIT.txt"
MISSING_NPM_NOTICES_FILE="${ROOT_DIR}/legal/Missing-NPM-License-Notices.txt"
AWS_LICENSE_FILE="${HOST_DIR}/node_modules/@aws-sdk/client-bedrock-runtime/LICENSE"
GROK_MERMAID_LICENSE_FILE="${HOST_DIR}/node_modules/grok-mermaid/LICENSE"
MODULE_LIST="$(mktemp)"
trap 'rm -f "${MODULE_LIST}"' EXIT

require_file() {
    if [[ ! -f "$1" ]]; then
        echo "error: required file is missing: $1" >&2
        exit 1
    fi
}

require_file "${ROOT_DIR}/app/Info.plist"
require_file "${APP_ICON_FILE}"
require_file "${HOST_DIR}/package.json"
require_file "${D_CODE_LICENSE_FILE}"
require_file "${THIRD_PARTY_NOTICES_FILE}"
require_file "${PI_LICENSE_FILE}"
require_file "${MISSING_NPM_NOTICES_FILE}"
require_file "${AWS_LICENSE_FILE}"
require_file "${GROK_MERMAID_LICENSE_FILE}"
if [[ ! -d "${HOST_DIR}/node_modules" ]]; then
    echo "error: Host dependencies are not installed. Run: cd host && npm ci" >&2
    exit 1
fi
if [[ ! -x "${NODE_BIN}" ]]; then
    echo "error: Node runtime is not executable: ${NODE_BIN}" >&2
    echo "Set PI_DCODE_NODE_BIN to an arm64 Node v22.22.3 binary." >&2
    exit 1
fi
require_file "${NODE_LICENSE_FILE}"

NODE_VERSION="$(${NODE_BIN} --version)"
NODE_ARCH="$(file -b "${NODE_BIN}")"
REQUIRED_NODE_VERSION="v22.22.3"
if [[ "${NODE_VERSION}" != "${REQUIRED_NODE_VERSION}" ]]; then
    echo "error: the D Code 0.0.14 app bundle requires Node ${REQUIRED_NODE_VERSION}; found ${NODE_VERSION}" >&2
    exit 1
fi
if [[ "${NODE_ARCH}" != *"arm64"* ]]; then
    echo "error: the local app build currently requires an arm64 Node binary: ${NODE_ARCH}" >&2
    exit 1
fi

printf '==> Building Node/Pi Host\n'
(
    cd "${HOST_DIR}"
    npm run build
    npm ls --all --omit=dev --parseable > "${MODULE_LIST}"
)

printf '==> Building internal PiDCode release executable\n'
(
    cd "${ROOT_DIR}"
    swift build -c release
)
SWIFT_BIN_DIR="$(cd "${ROOT_DIR}" && swift build -c release --show-bin-path)"
require_file "${SWIFT_BIN_DIR}/PiDCode"
require_file "${HOST_DIR}/dist/src/index.js"

printf '==> Assembling %s\n' "${APP_DIR}"
rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}/runtime" "${HOST_RESOURCES_DIR}/dist" "${LEGAL_RESOURCES_DIR}"
ditto "${SWIFT_BIN_DIR}/PiDCode" "${MACOS_DIR}/D Code"
ditto "${NODE_BIN}" "${RESOURCES_DIR}/runtime/node"
chmod 755 "${MACOS_DIR}/D Code" "${RESOURCES_DIR}/runtime/node"
ditto "${HOST_DIR}/dist/src" "${HOST_RESOURCES_DIR}/dist/src"
ditto "${HOST_DIR}/package.json" "${HOST_RESOURCES_DIR}/package.json"
ditto "${APP_ICON_FILE}" "${RESOURCES_DIR}/AppIcon.icns"
ditto "${ROOT_DIR}/app/Info.plist" "${CONTENTS_DIR}/Info.plist"
ditto "${D_CODE_LICENSE_FILE}" "${LEGAL_RESOURCES_DIR}/D-Code-LICENSE.txt"
ditto "${THIRD_PARTY_NOTICES_FILE}" "${LEGAL_RESOURCES_DIR}/THIRD-PARTY-NOTICES.md"
ditto "${PI_LICENSE_FILE}" "${LEGAL_RESOURCES_DIR}/Pi-v0.84.1-MIT.txt"
ditto "${MISSING_NPM_NOTICES_FILE}" "${LEGAL_RESOURCES_DIR}/Missing-NPM-License-Notices.txt"
ditto "${NODE_LICENSE_FILE}" "${LEGAL_RESOURCES_DIR}/Node.js-LICENSE.txt"
ditto "${AWS_LICENSE_FILE}" "${LEGAL_RESOURCES_DIR}/Apache-2.0-LICENSE.txt"
ditto "${GROK_MERMAID_LICENSE_FILE}" "${LEGAL_RESOURCES_DIR}/grok-mermaid-LICENSE.txt"
printf 'APPL????' > "${CONTENTS_DIR}/PkgInfo"

printf '==> Copying production Node dependencies\n'
while IFS= read -r module_path; do
    [[ "${module_path}" == "${HOST_DIR}" ]] && continue
    relative_path="${module_path#"${HOST_DIR}/"}"
    [[ "${relative_path}" == node_modules/* ]] || continue
    package_path="${relative_path#node_modules/}"
    # A top-level package copy already contains its private nested node_modules.
    [[ "${package_path}" == */node_modules/* ]] && continue
    destination="${HOST_RESOURCES_DIR}/${relative_path}"
    mkdir -p "$(dirname "${destination}")"
    ditto "${module_path}" "${destination}"
done < "${MODULE_LIST}"

"${NODE_BIN}" \
    "${HOST_DIR}/scripts/generate-license-manifest.mjs" \
    "${HOST_RESOURCES_DIR}/node_modules" \
    "${LEGAL_RESOURCES_DIR}/npm-packages.txt"

cat > "${RESOURCES_DIR}/build-info.txt" <<EOF
D Code local build
Node: ${NODE_VERSION}
Architecture: arm64
Host package: @pi-dcode/host 0.0.14
EOF

printf '==> Validating bundle metadata and embedded Host\n'
plutil -lint "${CONTENTS_DIR}/Info.plist" >/dev/null
"${RESOURCES_DIR}/runtime/node" "${HOST_RESOURCES_DIR}/dist/src/index.js" --help >/dev/null

printf '==> Applying local ad-hoc signature\n'
while IFS= read -r -d '' candidate; do
    if file -b "${candidate}" | grep -q 'Mach-O'; then
        codesign --force --sign - "${candidate}" >/dev/null
    fi
done < <(find "${CONTENTS_DIR}" -type f \( -perm -111 -o -name '*.node' \) -print0)
codesign --force --deep --sign - "${APP_DIR}" >/dev/null
codesign --verify --deep --strict --verbose=2 "${APP_DIR}"

APP_SIZE="$(du -sh "${APP_DIR}" | awk '{print $1}')"
printf '\nBuilt %s (%s)\n' "${APP_DIR}" "${APP_SIZE}"
printf 'Open it with: open %q\n' "${APP_DIR}"
