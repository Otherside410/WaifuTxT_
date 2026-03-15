import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.tsx'
import './styles/theme.css'
import { loadAndApplyAccentColor } from './lib/accent.ts'
import { loadAndApplyTheme } from './lib/theme.ts'

// Restore saved theme and accent color before React renders to avoid a flash.
loadAndApplyTheme()
loadAndApplyAccentColor()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
