const STORAGE_KEY = 'waifutxt_accent'

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** Mix hex color with white by `amount` (0–1) to produce a lighter variant. */
function lightenHex(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(
    Math.min(255, Math.round(r + (255 - r) * amount)),
    Math.min(255, Math.round(g + (255 - g) * amount)),
    Math.min(255, Math.round(b + (255 - b) * amount)),
  )
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function setAccentCssVars(hex: string): void {
  const root = document.documentElement
  const hover = lightenHex(hex, 0.18)
  root.style.setProperty('--color-accent-pink', hex)
  root.style.setProperty('--color-accent-pink-hover', hover)
  root.style.setProperty('--color-accent-pink-dim', hex + '33')
  root.style.setProperty('--color-link', hex)
  root.style.setProperty('--color-link-hover', hover)
  root.style.setProperty('--color-mention', hex)
  root.style.setProperty('--color-mention-bg', hex + '26')
  root.style.setProperty('--color-mention-hover-bg', hex + '40')
}

function removeGradientOverride(): void {
  document.getElementById('waifutxt-accent-override')?.remove()
}

function injectGradientOverride(gradient: string, baseHex: string): void {
  removeGradientOverride()
  const style = document.createElement('style')
  style.id = 'waifutxt-accent-override'
  // Override every element that uses the accent background-color with a gradient.
  // We target Tailwind's generated bg-accent-pink / hover:bg-accent-pink-hover classes.
  style.textContent = `
    .bg-accent-pink,
    button.bg-accent-pink,
    a.bg-accent-pink {
      background-image: ${gradient} !important;
      background-color: transparent !important;
      --color-accent-pink: ${baseHex};
    }
    .hover\\:bg-accent-pink-hover:hover {
      background-image: ${gradient} !important;
      filter: brightness(1.08);
      background-color: transparent !important;
    }
  `
  document.head.appendChild(style)
}

export function applyAccentColor(value: string, isGradient: boolean): void {
  if (isGradient) {
    // Extract first hex color from gradient string for text / border / focus vars
    const match = value.match(/#[0-9a-fA-F]{6}/)
    const baseHex = match ? match[0] : '#ff2d78'
    setAccentCssVars(baseHex)
    injectGradientOverride(value, baseHex)
  } else {
    removeGradientOverride()
    setAccentCssVars(value)
  }
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

export function saveAccentColor(value: string, isGradient: boolean): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ value, isGradient }))
}

export function loadAccentColor(): { value: string; isGradient: boolean } {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return JSON.parse(stored) as { value: string; isGradient: boolean }
  } catch {
    // ignore
  }
  return { value: '#ff2d78', isGradient: false }
}

/** Call once at app startup (before React renders) to restore saved accent. */
export function loadAndApplyAccentColor(): void {
  const { value, isGradient } = loadAccentColor()
  if (value !== '#ff2d78' || isGradient) {
    applyAccentColor(value, isGradient)
  }
}

// Re-export helpers for use in the picker
export { hexToRgb, rgbToHex }

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = (h / 360) * 6
  const i = Math.floor(hh)
  const f = hh - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  let r: number, g: number, b: number
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    default: r = v; g = p; b = q
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  const s = max === 0 ? 0 : d / max
  const v = max
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }
  return [Math.round(h * 360), s, v]
}
