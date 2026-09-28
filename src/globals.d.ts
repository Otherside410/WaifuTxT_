declare const __APP_VERSION__: string

// Exposed by electron/preload.cjs — only present when running inside the
// Electron desktop app (undefined on the web build).
interface WaifuUpdaterStatus {
  state:
    | 'idle'
    | 'unsupported'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
  version?: string
  percent?: number
  message?: string
  reason?: 'dev' | 'portable'
  checkedAt?: number | null
}

interface WaifuUpdaterApi {
  onStatus: (callback: (status: WaifuUpdaterStatus) => void) => () => void
  restartAndInstall: () => void
  getStatus: () => Promise<WaifuUpdaterStatus>
  checkNow: () => Promise<WaifuUpdaterStatus>
}

interface WaifuSystemApi {
  getLaunchAtStartup: () => Promise<boolean>
  setLaunchAtStartup: (enabled: boolean) => Promise<boolean>
}

interface WaifuSteamApi {
  request: (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token?: string,
  ) => Promise<{ status: number; body: string }>
}

interface WaifuWindowState {
  maximized: boolean
  fullscreen: boolean
}

interface WaifuWindowApi {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  getState: () => Promise<WaifuWindowState>
  onState: (callback: (state: WaifuWindowState) => void) => () => void
}

interface Window {
  waifuUpdater?: WaifuUpdaterApi
  waifuSystem?: WaifuSystemApi
  waifuSteam?: WaifuSteamApi
  // Frameless Windows/Linux desktop window only.
  waifuWindow?: WaifuWindowApi
}
