# Retour à la version précédente (WaifuChat natif)

Après une mise à jour (`--update`), la version remplacée est conservée à côté du fichier installé : `<fichier>.previous`.
**Le nom du fichier ne change pas** : une AppImage `WaifuChat-0.1.0-x86_64.AppImage` mise à jour en 0.2.0 s'appelle toujours
`WaifuChat-0.1.0-x86_64.AppImage`. Pour savoir quelle version tourne vraiment :

    ./WaifuChat-0.1.0-x86_64.AppImage --version        # affiche « waifu-desktop X.Y.Z »
    ./WaifuChat-0.1.0-x86_64.AppImage.previous --version

Dans les commandes ci-dessous, `X` est le **chemin de l'AppImage installée** (avec son nom d'origine).

## 1. La nouvelle version démarre

    ./X --rollback

`X` et `X.previous` échangent leur place : la version précédente redevient `X`, la version courante devient `X.previous`
(rien n'est perdu ; relancer `--rollback` revient en avant). Relancer ensuite l'application.
Il faut lancer **l'AppImage** : le lanceur AppImage pose `$APPIMAGE`, que la commande lit pour savoir quel fichier échanger.
Lancé hors du lanceur (par exemple le binaire `usr/bin/waifu-desktop` d'une AppImage extraite), `--rollback` vise l'exécutable
courant et non l'AppImage ; le message d'erreur nomme le fichier visé (« fichier visé : … »).

## 2. La nouvelle version ne démarre plus

Lancer la **version précédente** avec la même option : elle sait qu'elle est la `.previous` et vise le fichier principal.

    ./X.previous --rollback

Résultat : `X` = ancienne version, `X.previous` = la version cassée (conservée pour analyse).

## 3. À la main, sans rien perdre

    mv X "X.broken-$(date +%F)" && mv X.previous X

La version cassée est gardée sous `X.broken-AAAA-MM-JJ`. **Ne pas faire `mv X.previous X` seul** : cela écrase `X` (la version
courante) sans la conserver.
