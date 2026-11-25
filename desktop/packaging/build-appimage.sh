#!/usr/bin/env bash
# Construit l'AppImage de waifu-desktop (x86_64). Idempotent : l'AppDir est recréée à chaque exécution.
# Aucune donnée de session n'est embarquée ; les données restent dans ~/.local/share/waifu-desktop-rust/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(dirname "$HERE")"
REPO="$(dirname "$DESKTOP")"
APPDIR="$HERE/build/WaifuChat.AppDir"
TOOLS="${HOME}/tools"
APPIMAGETOOL="${APPIMAGETOOL:-$TOOLS/appimagetool-x86_64.AppImage}"
APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"

VERSION="$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version *= *"\(.*\)"/\1/p}' "$DESKTOP/Cargo.toml" | head -n1)"
[ -n "$VERSION" ] || { echo "version introuvable dans desktop/Cargo.toml" >&2; exit 1; }
OUT="$HERE/WaifuChat-${VERSION}-x86_64.AppImage"

echo "==> cargo build --release"
(cd "$DESKTOP" && cargo build --release --locked)
TARGET_DIR="${CARGO_TARGET_DIR:-$DESKTOP/target}"
BIN="$TARGET_DIR/release/waifu-desktop"
[ -x "$BIN" ] || { echo "binaire release absent : $BIN" >&2; exit 1; }

echo "==> AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
install -m 0755 "$BIN" "$APPDIR/usr/bin/waifu-desktop"

cat > "$APPDIR/AppRun" <<'RUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/waifu-desktop" "$@"
RUN
chmod 0755 "$APPDIR/AppRun"

cat > "$APPDIR/waifu-desktop.desktop" <<'DESK'
[Desktop Entry]
Type=Application
Name=WaifuChat
Comment=Client Matrix natif
Exec=waifu-desktop
Icon=waifu-desktop
Categories=Network;InstantMessaging;
Terminal=false
DESK

if [ -f "$REPO/build/icon.png" ]; then
  cp "$REPO/build/icon.png" "$APPDIR/waifu-desktop.png"
else
  # Icône de repli : PNG 1x1, suffisant pour appimagetool.
  printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw+8/wHwAEoAIB3ZV5HQAAAABJRU5ErkJggg==' | base64 -d > "$APPDIR/waifu-desktop.png"
fi
ln -sf waifu-desktop.png "$APPDIR/.DirIcon"

# Reproductibilité : toutes les dates de l'AppDir et du squashfs sont fixées à SOURCE_DATE_EPOCH (par défaut : date du
# dernier commit, sinon 0), de sorte que deux exécutions sur le même binaire donnent la même AppImage, octet pour octet.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$REPO" log -1 --format=%ct 2>/dev/null || echo 0)}"
find "$APPDIR" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

echo "==> appimagetool"
if [ ! -x "$APPIMAGETOOL" ]; then
  mkdir -p "$TOOLS"
  curl -fL --retry 3 -o "$APPIMAGETOOL" "$APPIMAGETOOL_URL"
  chmod 0755 "$APPIMAGETOOL"
fi

rm -f "$OUT"
# Sans FUSE (VM, conteneur), appimagetool s'exécute par extraction.
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" "$APPDIR" "$OUT"
chmod 0755 "$OUT"
echo "==> $OUT ($(du -h "$OUT" | cut -f1))"
