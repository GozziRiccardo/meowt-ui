// Single source of truth for the WalletConnect Project ID.
// Supports BOTH env names and returns a normalized, trimmed value.
type ImportMetaWithEnv = ImportMeta & { env?: Record<string, unknown> }

type EnvShape = {
  VITE_WALLETCONNECT_PROJECT_ID?: string
  VITE_WC_PROJECT_ID?: string
}

const metaEnv = ((import.meta as ImportMetaWithEnv).env as EnvShape | undefined) ?? {}

const fromLong = metaEnv.VITE_WALLETCONNECT_PROJECT_ID
const fromShort = metaEnv.VITE_WC_PROJECT_ID
const rawProjectId = (fromLong ?? fromShort ?? '').trim()

export const WC_PROJECT_ID: string | undefined = rawProjectId.length >= 8 ? rawProjectId : undefined

// Optional: populate a masked value on window for debug panels
interface WindowWithProjectId extends Window {
  __W3M_PROJECT_ID?: string
}

export function assertEnv() {
  if (typeof window === 'undefined') return
  const win = window as WindowWithProjectId
  if (!WC_PROJECT_ID) {
    delete win.__W3M_PROJECT_ID
    return
  }
  const masked = `${WC_PROJECT_ID.slice(0, 4)}…${WC_PROJECT_ID.slice(-4)}`
  console.log('[ENV] WalletConnect ID present:', masked)
  win.__W3M_PROJECT_ID = masked
}
