#!/usr/bin/env bash
# Construit l'ARTEFACT DE STAGING de WaifuChat natif (W09). Jamais une release.
#
#   staging.sh [--sha <sha court ou complet attendu pour HEAD>] [--out <dossier>]
#
# Sortie : desktop/packaging/staging-out/waifu-desktop-staging-<version>-<sha court>
#          + .sha256 (format sha256sum) + .build.txt (version, sha, date, rustc, empreinte, taille, mention NON-RELEASE).
# Refus (aucun artefact produit) : arbre git sale (3), HEAD différent du sha annoncé (4), disque < 2 Go (5).
# Codes de sortie : 0 artefact produit et vérifié ; 2 usage ; 3 arbre sale ; 4 sha ; 5 disque ; 6 build ; 7 artefact absent ;
#                   8 vérification post-build.
# Aucune action git qui écrit (lecture seule : rev-parse, status). Aucune clé de mise à jour n'est compilée
# (WAIFU_UPDATE_PUBKEY est retirée de l'environnement) : un binaire de staging ne se met jamais à jour tout seul.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(dirname "$HERE")"
REPO="$(dirname "$DESKTOP")"
OUT="$HERE/staging-out"
EXPECT="${STAGING_SHA:-}"
MIN_FREE=2000000000   # 2 Go : consigne du chantier, en dessous on s'arrête

die() { local code="$1"; shift; echo "staging.sh : REFUS ($code) : $*" >&2; exit "$code"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --sha) EXPECT="${2:?--sha attend une valeur}"; shift 2 ;;
    --out) OUT="${2:?--out attend un dossier}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die 2 "option inconnue : $1" ;;
  esac
done

free_bytes() { df -B1 --output=avail "$1" | tail -1 | tr -d ' '; }
[ "$(free_bytes "$HERE")" -ge "$MIN_FREE" ] || die 5 "moins de 2 Go libres ($(free_bytes "$HERE") o)"

command -v git >/dev/null || die 2 "git absent"
HEAD_FULL="$(git -C "$REPO" rev-parse HEAD)"
SHA="$(git -C "$REPO" rev-parse --short=7 HEAD)"
if [ -n "$EXPECT" ]; then
  case "$HEAD_FULL" in
    "$EXPECT"*) ;;
    *) die 4 "HEAD est $SHA mais le sha annoncé est $EXPECT" ;;
  esac
fi

# Arbre propre : tout fichier modifié ou non suivi hors de desktop/packaging/ (scripts, doc, sorties : ils ne contribuent
# pas au binaire) et de .design/ (exclu de git) bloque la production.
DIRTY="$(git -C "$REPO" status --porcelain --untracked-files=all -- . ':(exclude)desktop/packaging' ':(exclude).design')"
if [ -n "$DIRTY" ]; then
  echo "$DIRTY" | head -20 >&2
  die 3 "arbre git sale (voir ci-dessus) : committer ou écarter les changements avant de produire un artefact de staging"
fi

VERSION="$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version *= *"\(.*\)"/\1/p}' "$DESKTOP/Cargo.toml" | head -n1)"
[ -n "$VERSION" ] || die 2 "version introuvable dans desktop/Cargo.toml"
NAME="waifu-desktop-staging-${VERSION}-${SHA}"
case "$NAME" in *release*) die 2 "le nom d'un artefact de staging ne contient jamais « release »" ;; esac

echo "==> staging : $NAME (HEAD $HEAD_FULL, arbre propre)"
STARTED=$SECONDS
if ! (cd "$DESKTOP" && env -u WAIFU_UPDATE_PUBKEY cargo build --release --locked -p app); then
  die 6 "cargo build --release a échoué"
fi
BUILD_SECONDS=$((SECONDS - STARTED))
BIN="$DESKTOP/target/release/waifu-desktop"
[ -x "$BIN" ] || die 7 "binaire absent : $BIN"

mkdir -p "$OUT"
install -m 0755 "$BIN" "$OUT/$NAME"
( cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" )
SUM="$(cut -d' ' -f1 "$OUT/$NAME.sha256")"
SIZE="$(stat -c %s "$OUT/$NAME")"

REPORTED="$("$OUT/$NAME" --version 2>&1 | head -1)"
[ "$REPORTED" = "waifu-desktop $VERSION" ] || die 8 "--version affiche « $REPORTED » au lieu de « waifu-desktop $VERSION »"

cat > "$OUT/$NAME.build.txt" <<INFO
NON-RELEASE : artefact de staging, jamais à distribuer.
nom        : $NAME
version    : $VERSION
sha git    : $HEAD_FULL
arbre      : propre (hors desktop/packaging et .design)
date       : $(date -Is)
rustc      : $(rustc --version)
profil     : release (--locked, sans clé de mise à jour)
sha256     : $SUM
taille     : $SIZE octets
durée build: $BUILD_SECONDS s (cache cargo existant)
scripts    : (sha256 des fichiers de desktop/packaging au moment du build, exclus du contrôle d'arbre propre ; traçabilité si non commités)
$(cd "$HERE" && sha256sum staging.sh bench-headless.sh parity-checklist.md 2>/dev/null)
INFO

echo "==> sha256  $SUM"
echo "==> taille  $SIZE octets ; build $BUILD_SECONDS s"
echo "STAGING OK $OUT/$NAME"
