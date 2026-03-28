import { useCallback, useEffect, useRef, useState } from 'react'
import { useVoiceStore } from '../../stores/voiceStore'
import { applyOutputDeviceToAll } from '../../lib/voice'

// ── Device list ───────────────────────────────────────────────────────────────

interface MediaDeviceEntry {
  deviceId: string
  label: string
}

function useAudioDevices() {
  const [inputs, setInputs] = useState<MediaDeviceEntry[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceEntry[]>([])
  const [hasPermission, setHasPermission] = useState(false)

  const refresh = useCallback(async () => {
    try {
      // Request permission if labels are empty
      const devices = await navigator.mediaDevices.enumerateDevices()
      const hasLabels = devices.some((d) => d.kind === 'audioinput' && d.label)
      if (!hasLabels) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((t) => t.stop())
      }
      setHasPermission(true)
      const fresh = await navigator.mediaDevices.enumerateDevices()
      setInputs(
        fresh
          .filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Micro ${i + 1}` })),
      )
      setOutputs(
        fresh
          .filter((d) => d.kind === 'audiooutput')
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Sortie ${i + 1}` })),
      )
    } catch {
      setHasPermission(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  return { inputs, outputs, hasPermission, refresh }
}

// ── Mic test meter ────────────────────────────────────────────────────────────

function MicTestMeter({ deviceId }: { deviceId: string | null }) {
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0) // 0-100
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)

  const startTest = useCallback(async () => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      const ctx = new AudioContext()
      ctxRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.3
      analyserRef.current = analyser
      src.connect(analyser)

      const data = new Float32Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getFloatFrequencyData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const lin = Math.pow(10, data[i] / 20)
          sum += lin * lin
        }
        const rmsDb = 10 * Math.log10((sum / data.length) || 1e-12)
        // Map -60dB…0dB to 0…100%
        const pct = Math.max(0, Math.min(100, ((rmsDb + 60) / 60) * 100))
        setLevel(pct)
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
      setTesting(true)
    } catch {
      setTesting(false)
    }
  }, [deviceId])

  const stopTest = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (ctxRef.current) { ctxRef.current.close().catch(() => {}); ctxRef.current = null }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null }
    analyserRef.current = null
    setLevel(0)
    setTesting(false)
  }, [])

  useEffect(() => () => stopTest(), [stopTest])

  // Restart test if device changes while testing
  useEffect(() => {
    if (testing) { stopTest(); void startTest() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  const color = level > 75 ? 'bg-danger' : level > 40 ? 'bg-success' : 'bg-accent-pink'

  return (
    <div className="flex flex-col gap-3">
      {/* Level bar */}
      <div className="h-3 w-full rounded-full bg-bg-primary overflow-hidden border border-border">
        <div
          className={`h-full rounded-full transition-all duration-75 ${color}`}
          style={{ width: `${level}%` }}
        />
      </div>

      <button
        onClick={testing ? stopTest : () => void startTest()}
        className={`self-start flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
          testing
            ? 'bg-danger/15 hover:bg-danger/30 text-danger'
            : 'bg-bg-hover hover:bg-bg-active text-text-primary'
        }`}
      >
        {testing ? (
          <>
            <span className="w-2 h-2 rounded-full bg-danger animate-pulse inline-block" />
            Arrêter le test
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
            </svg>
            Tester le micro
          </>
        )}
      </button>

      {testing && (
        <p className="text-xs text-text-muted">Parlez — le niveau affiché doit monter.</p>
      )}
    </div>
  )
}

// ── Device selector ───────────────────────────────────────────────────────────

function DeviceSelect({
  label,
  devices,
  value,
  onChange,
  disabled,
}: {
  label: string
  devices: MediaDeviceEntry[]
  value: string | null
  onChange: (id: string | null) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">{label}</label>
      <select
        disabled={disabled || devices.length === 0}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-pink disabled:opacity-40 cursor-pointer"
      >
        <option value="">Par défaut du système</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function AudioSettings() {
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId)
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId)
  const setInputDevice = useVoiceStore((s) => s.setInputDevice)
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice)

  const { inputs, outputs, hasPermission } = useAudioDevices()

  const handleOutputChange = useCallback((id: string | null) => {
    setOutputDevice(id)
    // Apply to any currently playing remote streams
    applyOutputDeviceToAll()
  }, [setOutputDevice])

  return (
    <div className="mt-6 space-y-5">
      {!hasPermission && (
        <div className="p-3 rounded-lg bg-warning/10 border border-warning/30 text-xs text-warning">
          L&apos;accès au microphone est nécessaire pour lister les périphériques. Autorise-le dans les paramètres du navigateur.
        </div>
      )}

      <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Entrée (microphone)</h3>

        <DeviceSelect
          label="Périphérique d'entrée"
          devices={inputs}
          value={inputDeviceId}
          onChange={setInputDevice}
          disabled={!hasPermission}
        />

        <div className="space-y-2">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wider">Test du microphone</p>
          <MicTestMeter deviceId={inputDeviceId} />
        </div>
      </div>

      <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Sortie (haut-parleurs)</h3>
        <DeviceSelect
          label="Périphérique de sortie"
          devices={outputs}
          value={outputDeviceId}
          onChange={handleOutputChange}
          disabled={!hasPermission || outputs.length === 0}
        />
        {outputs.length === 0 && hasPermission && (
          <p className="text-xs text-text-muted">
            La sélection de sortie n&apos;est pas supportée par ce navigateur (Firefox ne supporte pas setSinkId).
          </p>
        )}
      </div>
    </div>
  )
}
