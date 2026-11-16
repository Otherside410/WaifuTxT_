#!/usr/bin/env bash
# Les trois vérifications du chantier (CLAUDE.local.md), dans l'ordre, avec durée et code de sortie de chacune.
# Les tests d'interface sont headless (plateforme de test de GPUI) : aucun affichage, aucun GPU, aucun Xvfb requis.
# Les tests d'intégration contre un homeserver sont #[ignore] : ils ne tournent pas ici.
set -uo pipefail

step() {
  local name="$1"; shift
  local started; started=$(date +%s)
  echo "==> $name : $*"
  "$@"
  local code=$?
  echo "==> $name : exit=$code en $(( $(date +%s) - started )) s"
  return $code
}

echo "rustc $(rustc --version) | cargo $(cargo --version) | CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-?}"
step BUILD  cargo build --locked;                                  build=$?
step CLIPPY cargo clippy --all-targets --locked -- -D warnings;    clippy=$?
step TEST   cargo test --locked;                                   test=$?
echo "BUILD=$build CLIPPY=$clippy TEST=$test"
[ "$build" -eq 0 ] && [ "$clippy" -eq 0 ] && [ "$test" -eq 0 ]
