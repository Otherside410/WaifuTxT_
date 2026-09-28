import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const ICON_SRC = `${import.meta.env.BASE_URL}favicon.png`

// Discord-style title bar for the frameless Windows/Linux desktop window.
// Renders nothing on macOS / the web build (no window.waifuWindow) and hides in
// fullscreen (F11 or an element's HTML fullscreen), which also zeroes
// --titlebar-height so the layout reclaims the space.
export function TitleBar() {
  const api = window.waifuWindow
  const [windowState, setWindowState] = useState<WaifuWindowState>({ maximized: false, fullscreen: false })
  const [htmlFullscreen, setHtmlFullscreen] = useState(() => !!document.fullscreenElement)

  useEffect(() => {
    if (!api) return
    let active = true
    api.getState().then((s) => { if (active) setWindowState(s) }).catch(() => {})
    const unsubscribe = api.onState(setWindowState)
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  useEffect(() => {
    const onChange = () => setHtmlFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const hidden = windowState.fullscreen || htmlFullscreen
  useEffect(() => {
    document.documentElement.classList.toggle('titlebar-hidden', hidden)
  }, [hidden])

  if (!api || hidden) return null

  const buttonClass =
    'app-region-no-drag w-11 h-full flex items-center justify-center text-text-secondary transition-colors cursor-default'

  return createPortal(
    <div className="app-region-drag fixed top-0 inset-x-0 z-[200] h-[var(--titlebar-height)] flex items-center bg-bg-primary select-none">
      <div className="flex-1 min-w-0 flex items-center gap-2 pl-3">
        <img src={ICON_SRC} alt="" className="w-4 h-4 shrink-0" draggable={false} />
        <span className="text-xs font-semibold text-text-secondary truncate">WaifuChat</span>
      </div>
      <div className="flex h-full">
        <button
          type="button"
          tabIndex={-1}
          aria-label="Réduire"
          title="Réduire"
          onClick={() => api.minimize()}
          className={`${buttonClass} hover:bg-bg-hover hover:text-text-primary`}
        >
          <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M0 5.5h10" />
          </svg>
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={windowState.maximized ? 'Niveau inférieur' : 'Agrandir'}
          title={windowState.maximized ? 'Niveau inférieur' : 'Agrandir'}
          onClick={() => api.toggleMaximize()}
          className={`${buttonClass} hover:bg-bg-hover hover:text-text-primary`}
        >
          {windowState.maximized ? (
            <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M2.5 2.5V.5h7v7h-2" />
              <rect x=".5" y="2.5" width="7" height="7" />
            </svg>
          ) : (
            <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x=".5" y=".5" width="9" height="9" />
            </svg>
          )}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Fermer"
          title="Fermer"
          onClick={() => api.close()}
          className={`${buttonClass} hover:bg-[#e81123] hover:text-white`}
        >
          <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M.5.5l9 9M9.5.5l-9 9" />
          </svg>
        </button>
      </div>
    </div>,
    document.body,
  )
}
