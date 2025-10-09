// src/web3modal.ts
import { createWeb3Modal } from '@web3modal/wagmi/react'
import { wagmiConfig, TARGET_CHAIN } from './wagmi'

// Make sure this runs exactly once (even with HMR or multiple imports)
declare global {
  interface Window {
    __W3M_INITIALIZED__?: boolean
  }
}

const projectId = import.meta.env.VITE_WC_PROJECT_ID as string | undefined

if (!projectId) {
  // Fail loudly in dev, be visible in prod
  console.error(
    '[web3modal] Missing VITE_WC_PROJECT_ID. Set it in Cloudflare Pages (Production env) and redeploy.'
  )
}

if (!window.__W3M_INITIALIZED__ && projectId) {
  createWeb3Modal({
    wagmiConfig,
    projectId,
    defaultChain: TARGET_CHAIN,
    enableAnalytics: false,
    themeMode: 'dark',
    // Keep modal above any app overlays/masks
    themeVariables: { '--w3m-z-index': '2147483648' }
  })
  window.__W3M_INITIALIZED__ = true

  // Tiny sanity ping so you can verify on the live site
  // (Open DevTools → Console and look for this)
  console.log('[web3modal] initialized', {
    hasProjectId: !!projectId
  })
}
