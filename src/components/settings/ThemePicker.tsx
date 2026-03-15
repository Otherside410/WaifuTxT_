import { useState } from 'react'
import { applyTheme, saveTheme, loadTheme, THEMES } from '../../lib/theme'
import type { ThemeId } from '../../lib/theme'

// ---------------------------------------------------------------------------
// Mini UI preview per theme
// ---------------------------------------------------------------------------

const THEME_PALETTE: Record<ThemeId, {
  bg: string; sidebar: string; panel: string; hover: string
  text: string; textMuted: string; border: string; accent: string
}> = {
  dark: {
    bg:       '#0b0b14',
    sidebar:  '#12121f',
    panel:    '#1a1a2e',
    hover:    '#252540',
    text:     '#e8e8f0',
    textMuted:'#555570',
    border:   '#2a2a40',
    accent:   'var(--color-accent-pink, #ff2d78)',
  },
  light: {
    bg:       '#f0f2f5',
    sidebar:  '#ffffff',
    panel:    '#e8eaed',
    hover:    '#dde1e7',
    text:     '#1a1b1e',
    textMuted:'#8a8b8f',
    border:   '#d5d7dc',
    accent:   'var(--color-accent-pink, #ff2d78)',
  },
  oled: {
    bg:       '#000000',
    sidebar:  '#080808',
    panel:    '#111111',
    hover:    '#1c1c1c',
    text:     '#f0f0f0',
    textMuted:'#444444',
    border:   '#1c1c1c',
    accent:   'var(--color-accent-pink, #ff2d78)',
  },
}

function ThemePreview({ id }: { id: ThemeId }) {
  const p = THEME_PALETTE[id]
  return (
    <svg
      viewBox="0 0 120 80"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-full"
      aria-hidden
    >
      {/* App background */}
      <rect width="120" height="80" fill={p.bg} />

      {/* Space sidebar (narrow, leftmost) */}
      <rect x="0" y="0" width="18" height="80" fill={p.panel} />
      {/* Space icons */}
      <rect x="4" y="6"  width="10" height="10" rx="5" fill={p.hover} />
      <rect x="4" y="20" width="10" height="10" rx="5" fill={p.accent} opacity="0.8" />
      <rect x="4" y="34" width="10" height="10" rx="5" fill={p.hover} />

      {/* Room sidebar */}
      <rect x="18" y="0" width="34" height="80" fill={p.sidebar} />
      <rect x="18" y="0" width="34" height="12" fill={p.panel} />
      <rect x="22" y="3.5" width="20" height="5" rx="2.5" fill={p.textMuted} opacity="0.5" />
      {/* Room list items */}
      {[18, 30, 42, 54].map((y, i) => (
        <g key={y}>
          <rect x="22" y={y + 12} width="26" height="8" rx="3"
            fill={i === 0 ? p.hover : 'transparent'} />
          <rect x="25" y={y + 14.5} width={i === 0 ? 16 : 14} height="3" rx="1.5"
            fill={i === 0 ? p.text : p.textMuted} opacity={i === 0 ? 0.9 : 0.5} />
        </g>
      ))}
      {/* User bar */}
      <rect x="18" y="68" width="34" height="12" fill={p.panel} />
      <circle cx="26" cy="74" r="4" fill={p.hover} />
      <rect x="32" y="71.5" width="12" height="2.5" rx="1.25" fill={p.textMuted} opacity="0.6" />

      {/* Chat area */}
      <rect x="52" y="0" width="68" height="80" fill={p.bg} />
      {/* Chat header */}
      <rect x="52" y="0" width="68" height="12" fill={p.sidebar} />
      <rect x="57" y="4" width="24" height="4" rx="2" fill={p.textMuted} opacity="0.5" />
      {/* Messages */}
      {[
        { y: 16, w: 44, avatar: true },
        { y: 28, w: 36, avatar: true },
        { y: 40, w: 50, avatar: true },
      ].map(({ y, w, avatar }) => (
        <g key={y}>
          {avatar && <circle cx="59" cy={y + 4} r="4" fill={p.hover} />}
          <rect x="66" y={y}     width={w * 0.5} height="3" rx="1.5" fill={p.textMuted} opacity="0.4" />
          <rect x="66" y={y + 5} width={w}       height="3" rx="1.5" fill={p.text}     opacity="0.6" />
        </g>
      ))}
      {/* Accent message bubble */}
      <rect x="72" y="54" width="40" height="11" rx="4"
        fill={p.accent} opacity="0.85" />
      <rect x="76" y="58" width="28" height="3" rx="1.5" fill="white" opacity="0.9" />
      {/* Input bar */}
      <rect x="54" y="68" width="64" height="10" rx="3"
        fill={p.sidebar} stroke={p.border} strokeWidth="0.5" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

export function ThemePicker() {
  const [current, setCurrent] = useState<ThemeId>(loadTheme)

  const handleSelect = (id: ThemeId) => {
    setCurrent(id)
    applyTheme(id)
    saveTheme(id)
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      {THEMES.map(({ id, label, description }) => {
        const selected = current === id
        return (
          <button
            key={id}
            onClick={() => handleSelect(id as ThemeId)}
            className={`flex flex-col rounded-xl overflow-hidden border-2 transition-all cursor-pointer text-left focus:outline-none ${
              selected
                ? 'border-accent-pink shadow-lg shadow-accent-pink/20 scale-[1.02]'
                : 'border-border hover:border-border-strong hover:scale-[1.01]'
            }`}
          >
            {/* Preview */}
            <div className="aspect-[3/2] w-full overflow-hidden bg-bg-tertiary">
              <ThemePreview id={id as ThemeId} />
            </div>

            {/* Label */}
            <div className="px-3 py-2.5 bg-bg-tertiary border-t border-border">
              <div className="flex items-center gap-1.5">
                {selected && (
                  <svg className="w-3.5 h-3.5 text-accent-pink shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                <span className={`text-sm font-semibold truncate ${selected ? 'text-accent-pink' : 'text-text-primary'}`}>
                  {label}
                </span>
              </div>
              <p className="text-[11px] text-text-muted mt-0.5 leading-tight">{description}</p>
            </div>
          </button>
        )
      })}
    </div>
  )
}
