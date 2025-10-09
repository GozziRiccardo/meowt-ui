// src/web3modal.ts
import { createWeb3Modal } from '@web3modal/wagmi/react'
import { wagmiConfig, TARGET_CHAIN, WC_PROJECT_ID } from './wagmi'

declare global {
  interface Window { _w3mReady?: boolean }
}

// Initialize exactly once
export function loadWeb3Modal() {
  if (typeof window === 'undefined') return
  if (window._w3mReady) return

  createWeb3Modal({
    wagmiConfig,
    projectId: WC_PROJECT_ID,
    defaultChain: TARGET_CHAIN,
    enableAnalytics: false,
    themeMode: 'dark'
    // If you need to force the modal above overlays later:
    // themeVariables: { '--w3m-z-index': 2147483647 as any }
  })

  window._w3mReady = true
  if (import.meta.env.DEV) console.log('[web3modal] created')
}

// Eager init in the browser
if (typeof window !== 'undefined') loadWeb3Modal()
