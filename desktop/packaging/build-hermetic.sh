#!/usr/bin/env bash
# Build reproductible de l'AppImage dans un conteneur Debian 12 (glibc 2.36).
# Sortie : desktop/packaging/out/WaifuChat-<version>-x86_64.AppImage
# Cache cargo et target/ persistants dans le volume nommé waifu-build-cache.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(dirname "$HERE")"
REPO="$(dirname "$DESKTOP")"
IMAGE="waifu-build:debian12"
VOLUME="waifu-build-cache"

mkdir -p "$HERE/out"

echo "==> podman build $IMAGE"
podman build -t "$IMAGE" -f "$HERE/Containerfile.build" "$HERE"

echo "==> build dans le conteneur"
podman run --rm --userns=keep-id \
  -v "$REPO":/src:Z \
  -v "$VOLUME":/cache:Z \
  -e HOME=/cache/home \
  -e CARGO_HOME=/cache/cargo \
  -e CARGO_TARGET_DIR=/cache/target \
  -w /src/desktop \
  "$IMAGE" bash -euo pipefail -c '
    mkdir -p "$HOME" /cache/tools
    cargo build --release
    BIN=/cache/target/release/waifu-desktop

    VERSION="$(sed -n "/^\[workspace.package\]/,/^\[/{s/^version *= *\"\(.*\)\"/\1/p}" Cargo.toml | head -n1)"
    [ -n "$VERSION" ] || { echo "version introuvable" >&2; exit 1; }

    APPDIR=/tmp/WaifuChat.AppDir
    rm -rf "$APPDIR"; mkdir -p "$APPDIR/usr/bin"
    install -m 0755 "$BIN" "$APPDIR/usr/bin/waifu-desktop"
    printf "#!/bin/sh\nHERE=\"\$(dirname \"\$(readlink -f \"\$0\")\")\"\nexec \"\$HERE/usr/bin/waifu-desktop\" \"\$@\"\n" > "$APPDIR/AppRun"
    chmod 0755 "$APPDIR/AppRun"
    cat > "$APPDIR/waifu-desktop.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=WaifuChat
Comment=Client Matrix natif
Exec=waifu-desktop
Icon=waifu-desktop
Categories=Network;InstantMessaging;
Terminal=false
DESK
    if [ -f /src/build/icon.png ]; then cp /src/build/icon.png "$APPDIR/waifu-desktop.png"
    else printf "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw+8/wHwAEoAIB3ZV5HQAAAABJRU5ErkJggg==" | base64 -d > "$APPDIR/waifu-desktop.png"; fi
    ln -sf waifu-desktop.png "$APPDIR/.DirIcon"

    TOOL=/cache/tools/appimagetool-x86_64.AppImage
    if [ ! -x "$TOOL" ]; then
      curl -fL --retry 3 -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
      chmod 0755 "$TOOL"
    fi
    OUT="/src/desktop/packaging/out/WaifuChat-${VERSION}-x86_64.AppImage"
    rm -f "$OUT"
    ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" "$APPDIR" "$OUT"
    chmod 0755 "$OUT"
    echo "==> $OUT"
  '
ls -lh "$HERE"/out/*.AppImage
