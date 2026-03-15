export type ThemeId = 'dark' | 'light' | 'oled'

const STORAGE_KEY = 'waifutxt_theme'

export const THEMES: { id: ThemeId; label: string; description: string }[] = [
  { id: 'dark',  label: 'Sombre',      description: 'Thème par défaut — violet profond' },
  { id: 'light', label: 'Clair',       description: 'Interface claire pour la journée' },
  { id: 'oled',  label: 'OLED / AMOLED', description: 'Noir pur — économise la batterie' },
]

export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id)
}

export function saveTheme(id: ThemeId): void {
  localStorage.setItem(STORAGE_KEY, id)
}

export function loadTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'dark' || stored === 'light' || stored === 'oled') return stored
  return 'dark'
}

export function loadAndApplyTheme(): void {
  applyTheme(loadTheme())
}
