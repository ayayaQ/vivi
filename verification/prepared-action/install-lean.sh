#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 ayayaQ
set -euo pipefail
# Pinned official Linux x86_64 distribution; no unpinned installer or third-party action.
destination="${1:?Pass an empty installation directory}"
[[ ! -e "$destination" ]] || { echo 'Destination already exists' >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Use elan with lean-toolchain on other platforms' >&2; exit 1; }
mkdir -p "$destination"
archive="$destination/lean.tar.zst"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/leanprover/lean4/releases/download/v4.34.0/lean-4.34.0-linux.tar.zst -o "$archive"
echo "caaa98356098c85dc0fcbbd28e1ec66f39eb6551829972b752ff20e1286b646b  $archive" | sha256sum -c -
tar --zstd -xf "$archive" -C "$destination"
"$destination/lean-4.34.0-linux/bin/lean" --version
