import { createWeb3Modal } from '@web3modal/wagmi/react'
import { wagmiConfig, TARGET_CHAIN } from './wagmi'
import { WC_PROJECT_ID, assertEnv } from './lib/env'

declare global {
  interface Window {
    __w3mInit?: boolean
  }
}

/**
 * Initialize Web3Modal exactly once. Returns true if initialized (now or already),
 * false if init is not possible (e.g., missing project id) or failed.
 */
export function ensureWeb3ModalLoaded(): boolean {
  if (typeof window === 'undefined') return false
  if (window.__w3mInit) return true
  assertEnv()
  if (!WC_PROJECT_ID) {
    console.warn('[web3modal] Skipping init: missing WalletConnect project id')
    return false
  }
  try {
    ;(createWeb3Modal as any)({
      wagmiConfig,
      projectId: WC_PROJECT_ID,
      defaultChain: TARGET_CHAIN,
      themeMode: 'dark',
      // Force on-top so app overlays can’t hide it.
      themeVariables: { zIndex: '2147483647' },
      // Keep noise down; this only disables telemetry.
      enableAnalytics: false,
      // IMPORTANT: leave Explorer enabled so the wallet list renders
      // once your origins are allow-listed in WalletConnect Cloud.
      enableExplorer: true,
    })
    window.__w3mInit = true
    console.log('[web3modal] created')
    return true
  } catch (e) {
    console.error('[web3modal] init failed', e)
    window.__w3mInit = false
    return false
  }
}

// Fire-and-forget init on module load; callers also guard with ensureWeb3ModalLoaded()
void ensureWeb3ModalLoaded()
