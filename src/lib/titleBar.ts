// Frameless Windows/Linux desktop window: the renderer draws its own title bar
// (components/common/TitleBar.tsx). macOS and the web build keep none.
export const hasCustomTitleBar = typeof window !== 'undefined' && !!window.waifuWindow

// Height the title bar currently reserves at the top of the viewport (0 when
// there is none or the window is fullscreen). `position: fixed` content lives
// below it, so viewport coordinates need this subtracted.
export function getTitleBarHeight(): number {
  if (!hasCustomTitleBar) return 0
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height')) || 0
}
