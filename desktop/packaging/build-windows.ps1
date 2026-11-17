# Fabrique l'installateur NSIS et l'exécutable portable de WaifuChat natif (Windows x64) — W07.
# NON EXÉCUTÉ sur la VM de développement (aucune chaîne Windows) : première validation au job `windows` de desktop-rust.yml.
# Prérequis : Rust (MSVC), NSIS (`makensis` dans le PATH). Sortie : desktop\packaging\out\
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = Split-Path -Parent $here
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# Version lue dans desktop/Cargo.toml ([workspace.package]).
$cargo = Get-Content (Join-Path $desktop 'Cargo.toml') -Raw
if ($cargo -notmatch '(?ms)\[workspace\.package\].*?^version\s*=\s*"([^"]+)"') { throw 'version introuvable dans desktop/Cargo.toml' }
$version = $Matches[1]

Push-Location $desktop
try { cargo build --release; if ($LASTEXITCODE -ne 0) { throw "cargo build a échoué ($LASTEXITCODE)" } } finally { Pop-Location }
$exe = Join-Path $desktop 'target\release\waifu-desktop.exe'
if (-not (Test-Path $exe)) { throw "binaire absent : $exe" }

# Portable : le même exécutable, nommé pour la distribution (aucune installation, données dans %APPDATA%\waifu-desktop-rust).
$portable = Join-Path $out "WaifuChat-$version-x64-portable.exe"
Copy-Item $exe $portable -Force

# Installateur NSIS (par utilisateur).
Push-Location (Join-Path $here 'windows')
try {
  makensis /DVERSION=$version /DEXE=$exe waifu-desktop.nsi
  if ($LASTEXITCODE -ne 0) { throw "makensis a échoué ($LASTEXITCODE)" }
} finally { Pop-Location }
Move-Item (Join-Path $here ("windows\WaifuChat-$version-x64-setup.exe")) $out -Force -ErrorAction SilentlyContinue

Get-ChildItem $out -Filter "WaifuChat-$version-x64-*.exe" | ForEach-Object {
  $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  "{0}  {1}  ({2} octets)" -f $hash, $_.Name, $_.Length
}
