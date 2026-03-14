/**
 * Matrix cross-signing / device verification.
 *
 * Supports:
 *  - SAS (emoji comparison) — initiated from either side
 *  - Incoming requests from any other session (mobile, browser, Element…)
 *  - Outgoing request to own other devices via requestOwnUserVerification()
 */

import type { SasEmoji } from '../stores/verificationStore'
import { useVerificationStore } from '../stores/verificationStore'
import { getClient } from './matrix'

type MatrixClient = import('matrix-js-sdk').MatrixClient

// Module-level reference to the active request so UI actions can operate on it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeRequest: any | null = null

// ---------------------------------------------------------------------------
// Bootstrap — called once from matrix.ts setupEventListeners()
// ---------------------------------------------------------------------------

export function setupVerificationListeners(client: MatrixClient): void {
  // CryptoEvent.VerificationRequestReceived is only in matrix-js-sdk/lib/crypto-api,
  // not in the main export. Use the raw string value to avoid the undefined issue.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client.on('crypto.verificationRequestReceived' as any, (request: any) => {
    handleIncomingRequest(request, client)
  })
}

// ---------------------------------------------------------------------------
// Incoming request handling
// ---------------------------------------------------------------------------

function displayName(request: any, client: MatrixClient): string {
  const userId: string = request.otherUserId ?? request.requestingUserId ?? ''
  if (!userId) return 'Appareil inconnu'
  if (userId === client.getUserId()) return 'Votre autre appareil'
  return userId
}

function handleIncomingRequest(request: any, client: MatrixClient): void {
  // Ignore already-terminal requests (phase >= 5 means Cancelled or Done)
  if ((request.phase ?? 0) >= 5) return

  const name = displayName(request, client)
  activeRequest = request
  useVerificationStore.getState().setIncoming(name)

  request.on('change', () => {
    const store = useVerificationStore.getState()
    const phase: number = request.phase ?? 0
    // VerificationPhase enum: Unsent=1 Requested=2 Ready=3 Started=4 Cancelled=5 Done=6
    if (phase === 5 /* Cancelled */ && store.phase !== 'done') {
      store.setError("Vérification annulée par l'autre appareil")
      activeRequest = null
    } else if (phase === 6 /* Done */) {
      store.setPhase('done')
      activeRequest = null
    }
  })
}

// ---------------------------------------------------------------------------
// UI action — decline the incoming request
// ---------------------------------------------------------------------------

export function declineIncoming(): void {
  if (activeRequest) {
    try {
      activeRequest.cancel()
    } catch {
      // ignore
    }
    activeRequest = null
  }
  useVerificationStore.getState().reset()
}

// ---------------------------------------------------------------------------
// UI action — accept incoming + start SAS
// ---------------------------------------------------------------------------

export async function acceptAndStartSas(): Promise<void> {
  const request = activeRequest
  if (!request) return
  const store = useVerificationStore.getState()

  try {
    if (!request.initiatedByMe) {
      await request.accept()
    }
    store.setPhase('ready')
    await runSasVerification(request)
  } catch (err) {
    store.setError(err instanceof Error ? err.message : 'Erreur lors de la vérification')
    activeRequest = null
  }
}

// ---------------------------------------------------------------------------
// UI action — start outgoing self-verification (sends to own other devices)
// ---------------------------------------------------------------------------

export async function startSelfVerification(): Promise<void> {
  const client = getClient()
  if (!client) return
  const crypto = client.getCrypto()
  if (!crypto) return

  const store = useVerificationStore.getState()
  store.reset()
  store.setOutgoing()

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = await (crypto as any).requestOwnUserVerification()
    activeRequest = request

    // Listen for the other device accepting & potentially starting verification
    request.on('change', async () => {
      const phase: number = request.phase ?? 0
      const currentPhase = useVerificationStore.getState().phase

      if (phase === 4 /* Started */ && request.verifier) {
        // Other device started verification (e.g. they chose emoji on their side)
        await bindVerifierEvents(request.verifier)
      } else if (phase === 5 /* Cancelled */ && currentPhase !== 'done') {
        store.setError('Vérification annulée')
        activeRequest = null
      } else if (phase === 6 /* Done */) {
        store.setPhase('done')
        activeRequest = null
      }
    })
  } catch (err) {
    store.setError(
      err instanceof Error ? err.message : 'Impossible de démarrer la vérification',
    )
  }
}

// ---------------------------------------------------------------------------
// UI action — start SAS from the "ready" state (outgoing request)
// ---------------------------------------------------------------------------

export async function startEmojiVerification(): Promise<void> {
  const request = activeRequest
  if (!request) return
  const store = useVerificationStore.getState()
  store.setPhase('ready')
  try {
    await runSasVerification(request)
  } catch (err) {
    store.setError(err instanceof Error ? err.message : 'Erreur lors de la vérification')
    activeRequest = null
  }
}

// ---------------------------------------------------------------------------
// Cancel whatever is in progress
// ---------------------------------------------------------------------------

export function cancelVerification(): void {
  if (activeRequest) {
    try {
      activeRequest.cancel()
    } catch {
      // ignore
    }
    activeRequest = null
  }
  useVerificationStore.getState().reset()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function waitForPhaseAtLeast(request: any, minPhase: number): Promise<void> {
  if ((request.phase ?? 0) >= minPhase) return
  return new Promise((resolve) => {
    const handler = () => {
      if ((request.phase ?? 0) >= minPhase) {
        request.off('change', handler)
        resolve()
      }
    }
    request.on('change', handler)
  })
}

async function runSasVerification(request: any): Promise<void> {
  // Wait until the request is in Ready (3) or Started (4) state.
  await waitForPhaseAtLeast(request, 3)

  if ((request.phase ?? 0) === 5 /* Cancelled */) {
    useVerificationStore.getState().setError("Vérification annulée par l'autre appareil")
    activeRequest = null
    return
  }

  // If the other side already started (phase 4) and a verifier exists, bind it.
  if ((request.phase ?? 0) === 4 && request.verifier) {
    await bindVerifierEvents(request.verifier)
    return
  }

  const verifier = await request.startVerification('m.sas.v1')
  await bindVerifierEvents(verifier)
}

async function bindVerifierEvents(verifier: any): Promise<void> {
  const store = useVerificationStore.getState()

  const handleShowSas = (sas: any) => {
    // ShowSasCallbacks = { sas: GeneratedSas, confirm(), mismatch() }
    // GeneratedSas = { emoji?: EmojiMapping[] }  — so emoji is at sas.sas.emoji
    const emojiList = (sas.sas?.emoji ?? []) as ReadonlyArray<readonly [string, string]>
    const emojis: SasEmoji[] = emojiList.map(([emoji, name]) => ({ emoji, name }))
    store.setSas(emojis, {
      confirm: () => sas.confirm(),
      mismatch: () => Promise.resolve(sas.mismatch()),
    })
  }

  verifier.on('show_sas', handleShowSas)

  // In case the show_sas event already fired before we registered the listener
  // (can happen when the other side initiates quickly), poll the callbacks directly.
  try {
    const existing = verifier.getShowSasCallbacks?.()
    if (existing) handleShowSas(existing)
  } catch {
    // getShowSasCallbacks not available or not yet populated — ignore
  }

  try {
    await verifier.verify()
    store.setPhase('done')
  } catch (err) {
    const current = useVerificationStore.getState().phase
    if (current !== 'done' && current !== 'cancelled') {
      store.setError(err instanceof Error ? err.message : 'Vérification SAS échouée')
    }
  }
  activeRequest = null
}
