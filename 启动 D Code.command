#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec /usr/bin/python3 "${0:A:h}/tools/launch-desktop.py" "$@"
