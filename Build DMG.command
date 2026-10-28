#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
exec python3 build_macos.py "$@"
