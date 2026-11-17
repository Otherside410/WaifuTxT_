# Image de build et de test du workspace desktop (Rust / GPUI / matrix-sdk) — W11.
#
# Contexte de build : desktop/ (voir .dockerignore : ni target/, ni spikes/, ni packaging/).
# L'image ne contient NI les sources NI les artefacts de compilation : les sources sont montées en lecture seule et le
# répertoire cible de cargo vit dans un volume (`/cache`). Ainsi l'image reste de l'ordre de 2 Go et `desktop/target`
# (plus de 10 Go) n'entre jamais dans une couche.
#
#   podman build -t waifu-desktop-ci -f desktop/Dockerfile desktop
#   podman run --rm -v "$PWD":/src:ro,Z -v waifu-desktop-ci-cache:/cache:Z waifu-desktop-ci
#
# Debian 12 (glibc 2.36) : un binaire n'est exécutable que sur une glibc >= à celle de compilation ; c'est aussi la base
# de packaging/Containerfile.build. Chaîne Rust épinglée (même version que le poste de développement au 2026-11-16).
FROM docker.io/library/debian:12-slim

ARG RUST_VERSION=1.100.0
ENV DEBIAN_FRONTEND=noninteractive

# Paquets système : liste exacte, justifiée dans .design/gpui/ENVIRONNEMENTS.md §3.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential clang pkg-config \
      libssl-dev libvulkan-dev libwayland-dev \
      libxkbcommon-dev libxkbcommon-x11-dev libx11-xcb-dev libxcb1-dev \
      libfontconfig-dev libfreetype-dev libasound2-dev \
      curl ca-certificates git file \
    && rm -rf /var/lib/apt/lists/*

# Chaîne Rust hors de $HOME (le conteneur tourne sous l'identifiant mappé par podman rootless).
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/cache/cargo PATH=/opt/cargo/bin:$PATH
RUN CARGO_HOME=/opt/cargo curl -fsSL https://sh.rustup.rs \
      | CARGO_HOME=/opt/cargo sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION} --component clippy \
    && chmod -R a+rX /opt/rustup /opt/cargo

# Économie de disque (poste de développement à 96 % d'occupation) : pas d'informations de débogage pour le profil dev
# ni de compilation incrémentale. Surchargeables : -e CARGO_PROFILE_DEV_DEBUG=1 -e CARGO_INCREMENTAL=1.
ENV CARGO_TARGET_DIR=/cache/target \
    CARGO_PROFILE_DEV_DEBUG=0 \
    CARGO_INCREMENTAL=0 \
    CARGO_BUILD_JOBS=3 \
    CARGO_TERM_COLOR=never

COPY docker/check.sh /usr/local/bin/waifu-check
RUN chmod 0755 /usr/local/bin/waifu-check

WORKDIR /src/desktop
CMD ["waifu-check"]
