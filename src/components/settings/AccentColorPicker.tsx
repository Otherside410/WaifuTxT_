import { useRef, useState, useEffect, useCallback } from 'react'
import {
  applyAccentColor,
  saveAccentColor,
  loadAccentColor,
  hexToRgb,
  rgbToHex,
  hsvToRgb,
  rgbToHsv,
} from '../../lib/accent'

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const PRESET_COLORS = [
  { label: 'Rose (défaut)', hex: '#ff2d78' },
  { label: 'Violet',        hex: '#a259ff' },
  { label: 'Indigo',        hex: '#6366f1' },
  { label: 'Bleu',          hex: '#4dabf7' },
  { label: 'Cyan',          hex: '#22d3ee' },
  { label: 'Vert',          hex: '#3ddc84' },
  { label: 'Orange',        hex: '#ff6b35' },
  { label: 'Rouge',         hex: '#ff4458' },
]

const PRESET_GRADIENTS = [
  { label: 'Sakura',     value: 'linear-gradient(135deg, #ff2d78 0%, #ff6b9d 100%)' },
  { label: 'Neon Dream', value: 'linear-gradient(135deg, #ff2d78 0%, #a259ff 100%)' },
  { label: 'Aurora',     value: 'linear-gradient(135deg, #a259ff 0%, #4dabf7 100%)' },
  { label: 'Sunset',     value: 'linear-gradient(135deg, #ff6b35 0%, #ff2d78 100%)' },
  { label: 'Ocean',      value: 'linear-gradient(135deg, #4dabf7 0%, #22d3ee 100%)' },
  { label: 'Forest',     value: 'linear-gradient(135deg, #3ddc84 0%, #4dabf7 100%)' },
  { label: 'Fire',       value: 'linear-gradient(135deg, #ffb347 0%, #ff4458 100%)' },
  { label: 'Candy',      value: 'linear-gradient(135deg, #ff6b9d 0%, #ffb347 100%)' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AccentColorPicker() {
  const saved = loadAccentColor()

  const [hue, setHue] = useState(330)
  const [sat, setSat] = useState(1)
  const [val, setVal] = useState(1)
  const [hexInput, setHexInput] = useState('#ff2d78')
  const [rVal, setRVal] = useState(255)
  const [gVal, setGVal] = useState(45)
  const [bVal, setBVal] = useState(120)
  const [selectedGradient, setSelectedGradient] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)

  const svCanvasRef = useRef<HTMLCanvasElement>(null)
  const isDraggingSV = useRef(false)

  // Initialize from saved value
  useEffect(() => {
    if (saved.isGradient) {
      setSelectedGradient(saved.value)
    } else {
      syncFromHex(saved.value)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Draw the SV canvas whenever hue/sat/val changes
  const drawSVCanvas = useCallback(() => {
    const canvas = svCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height

    // Base hue color
    const [hr, hg, hb] = hsvToRgb(hue, 1, 1)

    // White → hue gradient (left → right = saturation)
    const satGrad = ctx.createLinearGradient(0, 0, w, 0)
    satGrad.addColorStop(0, '#ffffff')
    satGrad.addColorStop(1, `rgb(${hr},${hg},${hb})`)
    ctx.fillStyle = satGrad
    ctx.fillRect(0, 0, w, h)

    // Transparent → black gradient (top → bottom = brightness)
    const valGrad = ctx.createLinearGradient(0, 0, 0, h)
    valGrad.addColorStop(0, 'rgba(0,0,0,0)')
    valGrad.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.fillStyle = valGrad
    ctx.fillRect(0, 0, w, h)

    // Cursor ring
    const cx = sat * w
    const cy = (1 - val) * h
    ctx.beginPath()
    ctx.arc(cx, cy, 7, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(cx, cy, 7, 0, Math.PI * 2)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [hue, sat, val])

  useEffect(() => { drawSVCanvas() }, [drawSVCanvas])

  // ── Sync helpers ──────────────────────────────────────────────────────────

  function syncFromHex(hex: string) {
    const [r, g, b] = hexToRgb(hex)
    setRVal(r); setGVal(g); setBVal(b)
    setHexInput(hex)
    const [h, s, v] = rgbToHsv(r, g, b)
    setHue(h); setSat(s); setVal(v)
    setSelectedGradient(null)
    setApplied(false)
  }

  function syncFromRgb(r: number, g: number, b: number) {
    setRVal(r); setGVal(g); setBVal(b)
    const hex = rgbToHex(r, g, b)
    setHexInput(hex)
    const [h, s, v] = rgbToHsv(r, g, b)
    setHue(h); setSat(s); setVal(v)
    setSelectedGradient(null)
    setApplied(false)
  }

  function syncFromHsv(h: number, s: number, v: number) {
    setHue(h); setSat(s); setVal(v)
    const [r, g, b] = hsvToRgb(h, s, v)
    setRVal(r); setGVal(g); setBVal(b)
    setHexInput(rgbToHex(r, g, b))
    setSelectedGradient(null)
    setApplied(false)
  }

  // ── Canvas interaction ────────────────────────────────────────────────────

  function pickFromSVCanvas(e: React.MouseEvent | React.TouchEvent) {
    const canvas = svCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    const s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const v = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height))
    syncFromHsv(hue, s, v)
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  function handleApply() {
    if (selectedGradient) {
      applyAccentColor(selectedGradient, true)
      saveAccentColor(selectedGradient, true)
    } else {
      applyAccentColor(hexInput, false)
      saveAccentColor(hexInput, false)
    }
    setApplied(true)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const previewStyle = selectedGradient
    ? { backgroundImage: selectedGradient }
    : { backgroundColor: hexInput }

  return (
    <div className="space-y-5">

      {/* ── Preset solid colors ── */}
      <div>
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2.5">Couleurs</p>
        <div className="flex flex-wrap gap-2">
          {PRESET_COLORS.map(({ label, hex }) => (
            <button
              key={hex}
              onClick={() => syncFromHex(hex)}
              title={label}
              className="w-8 h-8 rounded-full border-2 transition-all cursor-pointer hover:scale-110 focus:outline-none"
              style={{
                backgroundColor: hex,
                borderColor: hexInput === hex && !selectedGradient ? 'white' : 'transparent',
                boxShadow: hexInput === hex && !selectedGradient ? `0 0 0 1px ${hex}` : 'none',
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Preset gradients ── */}
      <div>
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2.5">Dégradés</p>
        <div className="flex flex-wrap gap-2">
          {PRESET_GRADIENTS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => { setSelectedGradient(value); setApplied(false) }}
              title={label}
              className="w-16 h-8 rounded-md border-2 transition-all cursor-pointer hover:scale-105 focus:outline-none"
              style={{
                backgroundImage: value,
                borderColor: selectedGradient === value ? 'white' : 'transparent',
                boxShadow: selectedGradient === value ? `0 0 0 1px rgba(255,255,255,0.4)` : 'none',
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Custom picker ── */}
      <div>
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2.5">Personnalisé</p>

        <div className="space-y-2.5">
          {/* SV canvas */}
          <canvas
            ref={svCanvasRef}
            width={512}
            height={160}
            className="w-full rounded-lg cursor-crosshair select-none"
            style={{ height: 160 }}
            onMouseDown={(e) => { isDraggingSV.current = true; pickFromSVCanvas(e) }}
            onMouseMove={(e) => { if (isDraggingSV.current) pickFromSVCanvas(e) }}
            onMouseUp={() => { isDraggingSV.current = false }}
            onMouseLeave={() => { isDraggingSV.current = false }}
            onTouchStart={(e) => { e.preventDefault(); pickFromSVCanvas(e) }}
            onTouchMove={(e) => { e.preventDefault(); pickFromSVCanvas(e) }}
          />

          {/* Hue bar */}
          <div className="px-1">
            <input
              type="range"
              min={0}
              max={360}
              value={hue}
              onChange={(e) => syncFromHsv(Number(e.target.value), sat, val)}
              className="hue-slider w-full h-4 rounded-full cursor-pointer appearance-none"
              style={{
                background: 'linear-gradient(to right,#ff0000 0%,#ffff00 17%,#00ff00 33%,#00ffff 50%,#0000ff 67%,#ff00ff 83%,#ff0000 100%)',
              }}
            />
          </div>

          {/* RGB + Hex inputs */}
          <div className="grid grid-cols-4 gap-2">
            {(
              [
                { label: 'R', value: rVal, color: '#ef4444', set: (v: number) => syncFromRgb(v, gVal, bVal) },
                { label: 'G', value: gVal, color: '#22c55e', set: (v: number) => syncFromRgb(rVal, v, bVal) },
                { label: 'B', value: bVal, color: '#3b82f6', set: (v: number) => syncFromRgb(rVal, gVal, v) },
              ] as const
            ).map(({ label, value, color, set }) => (
              <div key={label} className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold text-center" style={{ color }}>{label}</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={value}
                  onChange={(e) => set(Math.max(0, Math.min(255, Number(e.target.value))))}
                  className="!text-xs !py-1 !px-1.5 text-center w-full"
                />
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-text-muted text-center">Hex</span>
              <input
                type="text"
                value={hexInput}
                maxLength={7}
                onChange={(e) => {
                  const v = e.target.value
                  setHexInput(v)
                  if (/^#[0-9a-fA-F]{6}$/.test(v)) syncFromHex(v)
                }}
                className="!text-xs !py-1 !px-1.5 font-mono uppercase w-full"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Preview + Apply ── */}
      <div className="flex items-center gap-3 pt-1">
        <div className="flex items-center gap-2 flex-1">
          <span className="text-xs text-text-muted shrink-0">Aperçu</span>
          <div
            className="flex-1 h-8 rounded-md border border-border"
            style={previewStyle}
          />
        </div>
        <button
          onClick={handleApply}
          className="shrink-0 px-4 py-2 rounded-md text-sm font-medium text-white transition-all cursor-pointer hover:brightness-110"
          style={previewStyle}
        >
          {applied ? '✓ Appliqué' : 'Appliquer'}
        </button>
      </div>
    </div>
  )
}
