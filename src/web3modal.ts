import { createWeb3Modal } from '@web3modal/wagmi/react'
import { wagmiConfig, TARGET_CHAIN, WC_PROJECT_ID } from './wagmi'

declare global {
  interface Window {
    __w3mInit?: boolean
    __w3mModal?: ReturnType<typeof createWeb3Modal>
  }
}

export function ensureWeb3ModalLoaded() {
  if (typeof window === 'undefined') return
  if (window.__w3mInit && window.__w3mModal) return window.__w3mModal

  if (!WC_PROJECT_ID || WC_PROJECT_ID.trim().length < 8) {
    console.warn('[web3modal] Skipping init: invalid WC project id')
    return
  }

  try {
    const modal = createWeb3Modal({
      wagmiConfig,
      projectId: WC_PROJECT_ID,
      defaultChain: TARGET_CHAIN,
      themeMode: 'dark',
      enableAnalytics: false,
    })

    window.__w3mInit = true
    window.__w3mModal = modal
    console.log('[web3modal] initialized successfully')
    return modal
  } catch (e) {
    console.error('[web3modal] init failed:', e)
    window.__w3mInit = false
    window.__w3mModal = undefined
  }
}

ensureWeb3ModalLoaded()
