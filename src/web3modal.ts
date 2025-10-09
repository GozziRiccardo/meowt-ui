// src/web3modal.ts
import { createWeb3Modal } from '@web3modal/wagmi/react'
import { wagmiConfig, TARGET_CHAIN } from './wagmi'
import { WC_PROJECT_ID, assertEnv } from './lib/env'

declare global {
  interface Window {
    __w3mInit?: boolean
  }
}

export function ensureWeb3ModalLoaded() {
  if (typeof window === 'undefined') return
  if (window.__w3mInit) return
  assertEnv()
  if (!WC_PROJECT_ID) return

  window.__w3mInit = true
  createWeb3Modal({
    wagmiConfig,
    projectId: WC_PROJECT_ID,
    defaultChain: TARGET_CHAIN,
    themeMode: 'dark',
    // NOTE: we intentionally removed themeVariables.zIndex to avoid TS number/string mismatch.
  })
  console.log('[web3modal] created')
}

ensureWeb3ModalLoaded()
