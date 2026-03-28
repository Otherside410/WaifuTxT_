/**
 * Voice room notification sounds — generated via Web Audio API, no external files needed.
 * Four distinct sounds:
 *   joinSelf   — ascending two-note chime (you joined)
 *   leaveSelf  — descending two-note chime (you left)
 *   joinOther  — short bright ping (someone joined)
 *   leaveOther — short low blip (someone left)
 */

function tone(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  volume = 0.12,
  type: OscillatorType = 'sine',
) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, startAt)
  gain.gain.setValueAtTime(volume, startAt)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.01)
}

export function playJoinSelf(): void {
  try {
    const ctx = new AudioContext()
    tone(ctx, 880, ctx.currentTime, 0.15)
    tone(ctx, 1320, ctx.currentTime + 0.12, 0.18)
    setTimeout(() => ctx.close(), 800)
  } catch { /* ignore */ }
}

export function playLeaveSelf(): void {
  try {
    const ctx = new AudioContext()
    tone(ctx, 1100, ctx.currentTime, 0.12)
    tone(ctx, 660, ctx.currentTime + 0.10, 0.15)
    setTimeout(() => ctx.close(), 800)
  } catch { /* ignore */ }
}

export function playJoinOther(): void {
  try {
    const ctx = new AudioContext()
    tone(ctx, 1400, ctx.currentTime, 0.08, 0.07)
    tone(ctx, 1800, ctx.currentTime + 0.06, 0.09, 0.05)
    setTimeout(() => ctx.close(), 600)
  } catch { /* ignore */ }
}

export function playLeaveOther(): void {
  try {
    const ctx = new AudioContext()
    tone(ctx, 500, ctx.currentTime, 0.10, 0.07, 'triangle')
    tone(ctx, 350, ctx.currentTime + 0.08, 0.12, 0.05, 'triangle')
    setTimeout(() => ctx.close(), 600)
  } catch { /* ignore */ }
}
