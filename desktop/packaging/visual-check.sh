#!/usr/bin/env bash
# Collecte les faits de la recette visuelle d'un poste avec GPU réel (Nobara / Fedora) — W11.
# Usage : ./visual-check.sh /chemin/vers/WaifuChat-0.1.0-x86_64.AppImage [fichier-verdict.txt]
# Automatise : identité du poste, GPU et pilote Vulkan, version de l'application, banc de défilement (--bench-timeline).
# NE juge PAS le rendu : les fenêtres de démonstration se regardent à l'œil (liste imprimée en fin de fichier).
set -uo pipefail

APP="${1:?usage : $0 /chemin/vers/WaifuChat-<version>-x86_64.AppImage [fichier-verdict.txt]}"
OUT="${2:-verdict-$(hostname)-$(date +%F).txt}"
[ -x "$APP" ] || chmod +x "$APP" || { echo "AppImage introuvable ou non exécutable : $APP" >&2; exit 2; }

# Sans FUSE (cas courant sous Fedora récente), l'AppImage s'exécute par extraction.
if ! command -v fusermount >/dev/null 2>&1 && ! command -v fusermount3 >/dev/null 2>&1; then
  export APPIMAGE_EXTRACT_AND_RUN=1
fi

{
  echo "== poste"
  echo "date            : $(date -Is)"
  echo "système         : $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-inconnu}") ; noyau $(uname -r)"
  echo "glibc           : $(ldd --version 2>/dev/null | head -1)"
  echo "session         : XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-?} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} DISPLAY=${DISPLAY:-}"
  echo "écran           : $(xrandr --current 2>/dev/null | grep -E '\*' | head -1 | tr -s ' ' || echo 'xrandr indisponible')"
  echo "GPU (lspci)     : $(lspci 2>/dev/null | grep -Ei 'vga|3d|display' | head -2 | tr '\n' ';')"
  if command -v vulkaninfo >/dev/null 2>&1; then
    echo "Vulkan          : $(vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|driverName|driverInfo' | tr -s ' ' | tr '\n' ';')"
  else
    echo "Vulkan          : vulkaninfo absent (paquet vulkan-tools)"
  fi
  echo
  echo "== application"
  echo "AppImage        : $APP"
  echo "sha256          : $(sha256sum "$APP" | cut -d' ' -f1)"
  echo "version         : $("$APP" --version 2>&1 | head -1)"
  echo
  echo "== banc de défilement (--bench-timeline : 200 rendus, 5 000 messages, puis l'application se ferme)"
  timeout 180 "$APP" --bench-timeline 2>&1 | grep -E '^\[bench\]|error|panick|Vulkan|vulkan' | head -8
  echo "code de sortie  : ${PIPESTATUS[0]}"
  echo
  cat <<'LISTE'
== à regarder à l'œil (cocher puis ajouter une ligne d'observation chacun)
[ ] 1. ./WaifuChat-*.AppImage --demo-ui        : barre latérale (ESPACES « Démo Serveur », SALONS « général », MESSAGES DIRECTS « Alice Demo » avec pastille 1) + fenêtre « clé de récupération »
[ ] 2. ./WaifuChat-*.AppImage --demo-timeline  : salon « général » ouvert, messages « Message de démonstration n°… », boutons Modifier / Supprimer sur les messages « Moi (démo) », « Alice Demo écrit… » sous la liste
[ ] 3. molette dans la liste : défilement continu, sans saccade ni ligne vide qui clignote
[ ] 4. redimensionner la fenêtre (mini 800 px de large) : rien ne déborde, pas de zone noire
[ ] 5. texte net (pas flou), accents corrects (é, è, à, …), couleurs sombres (fond bleu nuit)
[ ] 6. fermeture par la croix : le processus s'arrête (vérifier avec : pgrep -a waifu)
LISTE
} 2>&1 | tee "$OUT"
echo
echo "Verdict enregistré dans : $OUT  (à renvoyer tel quel, avec une capture d'écran de --demo-timeline)"
