#!/usr/bin/env bash
# Banc automatisé de recette (staging) de WaifuChat natif — W09.
#
#   bench-headless.sh [--homeserver URL] [--binary CHEMIN] [--out DOSSIER]
#
# Déroule : démarrage de l'app, connexion au homeserver de test, envoi/réception chiffré, historique après redémarrage,
# média chiffré, réactions, édition/suppression, fil, épinglage, bug « image + texte ». Chaque étape imprime
# PASS / FAIL / SKIP AVEC SA RAISON et l'écrit dans staging-out/rapport-<horodatage>.txt. Un plantage laisse le rapport
# (trap EXIT : la dernière ligne est « VERDICT: PLANTÉ … »).
#
# Verdict et code de sortie : 0 = OK (tout PASS) ; 1 = KO (au moins un FAIL : promotion bloquée) ;
# 2 = INCOMPLET (aucun FAIL mais au moins un SKIP : NE VAUT PAS OK) ; 3 = PLANTÉ.
#
# Règles : aucun succès simulé ; un test introuvable est un FAIL ; pas de homeserver ⇒ SKIP (le banc n'en lance jamais) ;
# disque < 2 Go libres ⇒ arrêt immédiat avec rapport. Le banc réutilise desktop/target (variables d'économie de disque
# identiques à celles de la recette W11, sinon cargo recompilerait tout le workspace : > 5 Go).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(dirname "$HERE")"
OUT="$HERE/staging-out"
HS="${WAIFU_IT_HOMESERVER:-http://127.0.0.1:8008}"
BIN=""
CREDS="${WAIFU_IT_CREDENTIALS:-$HOME/matrix-test/CREDENTIALS.txt}"
MIN_FREE="${WAIFU_BENCH_MIN_FREE:-2000000000}"   # plancher de disque ; surchargeable seulement pour tester la garde
STEP_TIMEOUT=420

while [ $# -gt 0 ]; do
  case "$1" in
    --homeserver) HS="${2:?}"; shift 2 ;;
    --binary) BIN="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 3 ;;
  esac
done

mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUT/rapport-$STAMP.txt"
LOGDIR="$OUT/logs-$STAMP"
mkdir -p "$LOGDIR"
: > "$REPORT"

PASS=0; FAIL=0; SKIP=0; CURRENT="(démarrage)"; DONE=0
say() { echo "$*" | tee -a "$REPORT"; }

XPID=""; APID=""; SIG=""
finish() {
  local code=$?   # statut réel : 143 (SIGTERM), 130 (SIGINT) via les trap ci-dessous, sinon celui de la commande en échec
  # Ne laisse ni application ni serveur X orphelins (plantage ou signal pendant B02).
  [ -n "$APID" ] && kill "$APID" 2>/dev/null
  [ -n "$XPID" ] && kill "$XPID" 2>/dev/null
  if [ "$DONE" -eq 0 ]; then
    say ""
    say "VERDICT: PLANTÉ à l'étape « $CURRENT » (code $code${SIG:+, signal $SIG}) — PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    say "rapport : $REPORT"
    exit 3
  fi
}
trap finish EXIT
trap 'SIG=SIGTERM; exit 143' TERM
trap 'SIG=SIGINT; exit 130' INT
# SIGKILL (137) ne peut pas être capturé : aucun rapport de fin n'est alors écrit, les lignes déjà écrites restent lisibles.

free_bytes() { df -B1 --output=avail "$OUT" | tail -1 | tr -d ' '; }

begin() { CURRENT="$1 $2"; STEP_ID="$1"; STEP_NAME="$2"; STEP_T0=$SECONDS; }
elapsed() { echo "$((SECONDS - STEP_T0)) s"; }
pass() { PASS=$((PASS+1)); say "PASS  $STEP_ID  $STEP_NAME — $1 ($(elapsed))"; }
fail() { FAIL=$((FAIL+1)); say "FAIL  $STEP_ID  $STEP_NAME — $1 ($(elapsed))"; }
skip() { SKIP=$((SKIP+1)); say "SKIP  $STEP_ID  $STEP_NAME — $1"; }

disk_guard() {
  if [ "$(free_bytes)" -lt "$MIN_FREE" ]; then
    say "ARRÊT : moins de 2 Go libres ($(free_bytes) o) avant « $CURRENT » : le banc s'arrête, rien n'est simulé."
    DONE=1
    say ""
    say "VERDICT: INCOMPLET (arrêt disque) — PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
    exit 2
  fi
}

say "banc de recette WaifuChat natif — $(date -Is)"
say "homeserver : $HS ; identifiants : $CREDS ; disque libre : $(free_bytes) o"
say "sha git    : $(git -C "$DESKTOP" rev-parse --short=7 HEAD 2>/dev/null || echo inconnu) ; sale : $(git -C "$DESKTOP" status --porcelain -- . ':(exclude)packaging' 2>/dev/null | wc -l) fichier(s) hors packaging"
say "----"

# ── B00 disque ───────────────────────────────────────────────────────────────────────
begin B00 "garde disque"
disk_guard
pass "$(free_bytes) o libres (plancher 2 000 000 000 o)"

# ── B01 artefact de staging ──────────────────────────────────────────────────────────
begin B01 "artefact de staging présent et identifiable"
if [ -z "$BIN" ]; then
  BIN="$(ls -t "$OUT"/waifu-desktop-staging-*-* 2>/dev/null | grep -Ev '\.(sha256|build\.txt)$' | head -1 || true)"
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  skip "aucun artefact de staging dans $OUT (lancer packaging/staging.sh sur un arbre propre)"
  BIN=""
else
  if [ -f "$BIN.sha256" ] && ( cd "$(dirname "$BIN")" && sha256sum -c "$(basename "$BIN").sha256" >/dev/null 2>&1 ); then
    VERS="$("$BIN" --version 2>&1 | head -1)"
    pass "$(basename "$BIN") : empreinte conforme au .sha256 ; --version « $VERS »"
  else
    fail "$(basename "$BIN") : .sha256 absent ou différent de l'artefact"
  fi
fi

# ── B02 démarrage de l'application (X virtuel, rendu logiciel : seul le démarrage est jugé) ─
begin B02 "démarrage de l'application"
disk_guard
if [ -z "$BIN" ]; then
  skip "pas d'artefact (B01)"
elif ! command -v Xvfb >/dev/null 2>&1; then
  skip "Xvfb absent : aucune session graphique ; le rendu réel exige le poste Nobara (ENVIRONNEMENTS.md §5)"
else
  N=88; while [ -e "/tmp/.X11-unix/X$N" ]; do N=$((N+1)); done
  Xvfb ":$N" -screen 0 1280x900x24 >/dev/null 2>&1 & XPID=$!
  sleep 1
  DISPLAY=":$N" "$BIN" --demo-timeline > "$LOGDIR/demarrage.log" 2>&1 & APID=$!
  sleep 7
  if kill -0 "$APID" 2>/dev/null; then
    if grep -qiE 'panicked|fatal' "$LOGDIR/demarrage.log"; then
      fail "processus vivant mais panique dans le journal ($LOGDIR/demarrage.log)"
    else
      pass "--demo-timeline : processus vivant après 7 s sous Xvfb (llvmpipe), aucune panique ; rendu NON jugé"
    fi
    kill "$APID" 2>/dev/null; wait "$APID" 2>/dev/null
  else
    wait "$APID" 2>/dev/null; CODE=$?
    fail "le processus s'est arrêté avant 7 s (code $CODE) : $(tail -2 "$LOGDIR/demarrage.log" | tr '\n' ' ' | cut -c1-200)"
  fi
  kill "$XPID" 2>/dev/null; wait "$XPID" 2>/dev/null
fi

# ── B03 homeserver ───────────────────────────────────────────────────────────────────
begin B03 "homeserver de test joignable"
HS_OK=0
if curl -fsS -m 8 -o /dev/null "$HS/_matrix/client/versions" 2>/dev/null; then
  if [ -r "$CREDS" ]; then
    HS_OK=1; pass "$HS répond (/_matrix/client/versions) ; fichier d'identifiants lisible"
  else
    skip "le homeserver répond mais le fichier d'identifiants est illisible ($CREDS) : aucun compte de test"
  fi
else
  skip "pas de homeserver à $HS : le banc n'en lance jamais (consigne W09) ; démarrer ~/matrix-test/start.sh ou passer --homeserver"
fi

# ── tests d'intégration réels (crate matrix, tests/homeserver.rs) ────────────────────
run_it() { # $1 = nom exact du test ; renvoie 0 si PASS ; journal dans $LOGDIR/$1.log
  local name="$1" log="$LOGDIR/$1.log"
  disk_guard
  ( cd "$DESKTOP" && env CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=3 WAIFU_IT_HOMESERVER="$HS" \
      timeout "$STEP_TIMEOUT" cargo test -p matrix --test homeserver --locked -- --ignored --test-threads=1 --exact "$name" ) > "$log" 2>&1
  local code=$?
  RECOMPILED="$(grep -c '^ *Compiling ' "$log" || true)"
  if [ "$code" -eq 124 ]; then RUN_WHY="délai de ${STEP_TIMEOUT} s dépassé"; return 1; fi
  if grep -q 'test result: ok. 1 passed' "$log" && [ "$code" -eq 0 ]; then RUN_WHY="test « $name » : 1 passé"; return 0; fi
  if grep -q 'test result: ok. 0 passed' "$log"; then RUN_WHY="test « $name » introuvable (0 exécuté) : un test absent n'est pas un succès"; return 1; fi
  RUN_WHY="code $code : $(grep -E 'panicked|FAILED|error(\[|:)' "$log" | head -2 | tr '\n' ' ' | cut -c1-220)"
  return 1
}
it_step() { # $1 id, $2 nom, $3 test
  begin "$1" "$2"
  if [ "$HS_OK" -ne 1 ]; then skip "pas de homeserver exploitable (B03)"; return; fi
  if run_it "$3"; then pass "$RUN_WHY (recompilé : $RECOMPILED crate(s)) ; journal $(basename "$LOGDIR")/$3.log"; else fail "$RUN_WHY ; journal $(basename "$LOGDIR")/$3.log"; fi
}

it_step B04 "connexion et persistance de session"      login_then_restore_the_session_from_the_same_store
it_step B05 "envoi / réception chiffré"                an_encrypted_message_is_received_decrypted
it_step B06 "historique après redémarrage"             history_is_readable_after_a_restart
it_step B07 "message reçu pendant l'arrêt"             a_message_received_while_stopped_shows_up_in_the_timeline
it_step B08 "média chiffré (md5 identique)"            an_encrypted_attachment_downloads_with_the_same_md5

# ── fonctionnalités : preuve mécanique de présence dans le code natif ────────────────
absent_or_untested() { # $1 motif grep -E, $2 libellé
  local hits; hits="$(grep -rIlE "$1" "$DESKTOP"/crates/*/src 2>/dev/null | wc -l)"
  if [ "$hits" -eq 0 ]; then
    skip "$2 absent du client natif (grep -E '$1' dans crates/*/src : 0 fichier) ; la parité le classe « absent »"
  else
    skip "$2 : du code existe ($hits fichier(s)) mais le banc n'a aucun scénario pour l'exercer"
  fi
}
begin B09 "réactions";  absent_or_untested 'm\.reaction|toggle_reaction|ReactionSummary|[Rr]eaction' "réactions"
begin B10 "édition puis suppression"
if [ "$HS_OK" -ne 1 ]; then skip "pas de homeserver exploitable (B03)"
elif run_it an_encrypted_message_can_be_edited_then_deleted; then pass "$RUN_WHY (recompilé : $RECOMPILED crate(s)) ; journal $(basename "$LOGDIR")/an_encrypted_message_can_be_edited_then_deleted.log"
else fail "$RUN_WHY ; journal $(basename "$LOGDIR")/an_encrypted_message_can_be_edited_then_deleted.log"; fi
begin B11 "fil de discussion (m.thread)"; absent_or_untested 'm\.thread|thread_root|ThreadSummary|ThreadPanel' "fils"
begin B12 "épinglage (m.room.pinned_events)"; absent_or_untested 'pinned_events|PinnedEvent|pin_event|unpin' "épinglage"

begin B13 "bug connu : image + texte dans un même message (Element)"
skip "non automatisable : exige un message réel d'Element (image avec légende) ; aucun test ne le crée ; statut « non mesuré » dans parity-checklist.md (voir README.md:167)"

begin B14 "rendu réel (GPU, fenêtre, polices, fluidité)"
skip "nécessite le poste Nobara : lancer packaging/visual-check.sh puis renvoyer le verdict (.design/gpui/ENVIRONNEMENTS.md §5)"

# ── verdict ──────────────────────────────────────────────────────────────────────────
say "----"
say "PASS=$PASS FAIL=$FAIL SKIP=$SKIP ; journaux : $LOGDIR"
DONE=1
if [ "$FAIL" -gt 0 ]; then
  say "VERDICT: KO — $FAIL FAIL : promotion bloquée"
  say "rapport : $REPORT"; exit 1
elif [ "$SKIP" -gt 0 ]; then
  say "VERDICT: INCOMPLET — $SKIP SKIP, aucun FAIL : ne vaut pas OK (chaque SKIP doit être accepté par écrit par Otherside)"
  say "rapport : $REPORT"; exit 2
else
  say "VERDICT: OK — $PASS PASS, aucun FAIL, aucun SKIP"
  say "rapport : $REPORT"; exit 0
fi
