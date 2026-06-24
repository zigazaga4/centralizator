#!/usr/bin/env bash
#
# Centralizator — one-shot Windows release.
#
# Does EVERYTHING in a single command:
#   1. builds the signed Windows installer (cross-compiled from Linux),
#   2. generates latest.json (the file the in-app updater reads),
#   3. publishes a GitHub release with the installer + .sig + latest.json.
#
# After this runs, every installed copy older than this version sees the
# update on its next launch and shows the "Instalează" button.
#
# The version is read from app/src-tauri/tauri.conf.json — that is the
# updater's source of truth. Bump it (and app/package.json) and commit+push
# BEFORE running, so the release tag points at the built code.
#
# Usage:
#   ./release.sh                 # build + publish current tauri.conf version
#   NOTES="What changed" ./release.sh   # custom release notes
#
set -euo pipefail

REPO="zigazaga4/centralizator"
TARGET="x86_64-pc-windows-msvc"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # repo root (script lives here)
APP="$ROOT/app"
KEY="$ROOT/.keys/centralizator.key"
LLVM_BIN="/usr/lib/llvm-18/bin"          # llvm-rc / llvm-lib / lld-link
LOCAL_BIN="$HOME/.local/bin"             # clang-cl symlink

# ── 0 · sanity ───────────────────────────────────────────────────────────
command -v gh   >/dev/null || { echo "✗ gh (GitHub CLI) not found"; exit 1; }
command -v node >/dev/null || { echo "✗ node not found"; exit 1; }
[ -f "$KEY" ]   || { echo "✗ signing key missing: $KEY"; exit 1; }

# ── 1 · version = updater source of truth ────────────────────────────────
V="$(node -p "require('$APP/src-tauri/tauri.conf.json').version")"
TAG="v$V"
echo "▶ Centralizator $TAG — build + publish"

# ── 2 · build the signed installer ───────────────────────────────────────
(
  cd "$APP"
  PATH="$LOCAL_BIN:$LLVM_BIN:$PATH" \
  NODE_ENV=development \
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  pnpm tauri build --runner cargo-xwin --target "$TARGET"
)

# ── 3 · locate artifacts ─────────────────────────────────────────────────
NSIS="$APP/src-tauri/target/$TARGET/release/bundle/nsis"
EXE="$NSIS/Centralizator_${V}_x64-setup.exe"
SIG="$EXE.sig"
[ -f "$EXE" ] || { echo "✗ installer not found: $EXE"; exit 1; }
[ -f "$SIG" ] || { echo "✗ signature not found: $SIG (signing key not picked up?)"; exit 1; }

# ── 4 · generate latest.json ─────────────────────────────────────────────
NOTES="${NOTES:-$(git -C "$ROOT" log -1 --pretty=%s)}"
LATEST="$NSIS/latest.json"
cat > "$LATEST" <<JSON
{
  "version": "$V",
  "notes": $(node -p 'JSON.stringify(process.argv[1])' "$NOTES"),
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "windows-x86_64": {
      "signature": "$(cat "$SIG")",
      "url": "https://github.com/$REPO/releases/download/$TAG/Centralizator_${V}_x64-setup.exe"
    }
  }
}
JSON
echo "▶ latest.json written ($V)"

# ── 5 · publish (create or update the release) ───────────────────────────
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "▶ release $TAG exists — replacing assets"
  gh release upload "$TAG" "$EXE" "$SIG" "$LATEST" --repo "$REPO" --clobber
else
  echo "▶ creating release $TAG"
  gh release create "$TAG" "$EXE" "$SIG" "$LATEST" \
    --repo "$REPO" --title "Centralizator $TAG" --notes "$NOTES" --latest \
    --target "$(git -C "$ROOT" rev-parse HEAD)"
fi

echo "✓ Published $TAG. Installed copies will offer the update on next launch."
echo "  feed: https://github.com/$REPO/releases/latest/download/latest.json"
