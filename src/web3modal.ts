// src/web3modal.ts
import { createWeb3Modal } from '@web3modal/wagmi/react'
import { wagmiConfig, TARGET_CHAIN, WC_PROJECT_ID } from './wagmi'
// IMPORTANT: use the SAME project id as wagmi.ts to avoid mismatches.

declare global {
  interface Window {
    __w3mInit?: boolean
  }
}

export function ensureWeb3ModalLoaded() {
  if (typeof window === 'undefined') return
  if (window.__w3mInit) return
  if (!WC_PROJECT_ID) {
    console.warn('[web3modal] Skipping init: missing WC project id')
    return
  }

  window.__w3mInit = true
  try {
    createWeb3Modal({
      wagmiConfig,
      projectId: WC_PROJECT_ID,
      defaultChain: TARGET_CHAIN,
      themeMode: 'dark',
    })
    console.log('[web3modal] created')
  } catch (e) {
    // If something throws, clear the flag so a later call may retry.
    console.error('[web3modal] init failed', e)
    window.__w3mInit = false
  }
}

ensureWeb3ModalLoaded()
