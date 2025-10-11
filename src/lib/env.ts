// Unify on ONE var name
export const WC_PROJECT_ID =
  (import.meta as any)?.env?.VITE_WALLETCONNECT_PROJECT_ID as string | undefined

// Optional kill-switch to force WalletConnect QR modal (bypasses Web3Modal UI)
export const WC_FORCE_QR =
  String((import.meta as any)?.env?.VITE_WC_FORCE_QR ?? '').trim().toLowerCase() === 'true'

export function assertEnv() {
  if (!WC_PROJECT_ID || typeof WC_PROJECT_ID !== 'string' || WC_PROJECT_ID.trim().length < 8) {
    if (typeof window !== 'undefined') delete (window as any).__W3M_PROJECT_ID
  } else if (typeof window !== 'undefined') {
    const masked = `${WC_PROJECT_ID.slice(0, 4)}…${WC_PROJECT_ID.slice(-4)}`
    console.log('[ENV] WalletConnect ID present:', masked)
    ;(window as any).__W3M_PROJECT_ID = masked
  }
}
