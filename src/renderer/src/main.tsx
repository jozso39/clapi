import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { useStore } from './store'

// Handle for the Playwright driver (scripts/drive.mjs); harmless in normal use.
;(window as unknown as { __clapi: unknown }).__clapi = { useStore }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
