// src/web3modal.ts
import { createWeb3Modal } from '@web3modal/wagmi/react'
import { wagmiConfig, TARGET_CHAIN, WC_PROJECT_ID } from './wagmi'

// Run exactly once, before any `useWeb3Modal()` usage.
createWeb3Modal({
  wagmiConfig,
  projectId: WC_PROJECT_ID,
  defaultChain: TARGET_CHAIN,
  enableAnalytics: false,
  themeMode: 'dark',
  // keep the modal above everything (your mask uses 2147483647)
  themeVariables: { '--w3m-z-index': 2147483647 as any }
})

// tiny sanity ping in console so we know this ran
if (import.meta.env.DEV) console.log('[web3modal] created')
