// src/wagmi.ts
import { createConfig, http } from 'wagmi'
import { base, baseSepolia } from 'wagmi/chains'
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors'
import { fallback } from 'viem'
import { WC_PROJECT_ID } from './lib/env'

export { WC_PROJECT_ID } from './lib/env'

// --- Env helpers -------------------------------------------------------------
type ViteEnv = ImportMetaEnv & {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string
  readonly VITE_NETWORK?: string
  readonly VITE_BASE_RPC?: string
  readonly VITE_BASE_SEPOLIA_RPC?: string
  readonly VITE_ALCHEMY_KEY?: string
}

const VITE = import.meta.env as ViteEnv

// WalletConnect (NO fallback – fail fast if missing)
if (!WC_PROJECT_ID) {
  console.error('[ENV] Missing VITE_WALLETCONNECT_PROJECT_ID')
  throw new Error('VITE_WALLETCONNECT_PROJECT_ID is required')
}

// Target network: "base" | "baseSepolia"
const TARGET_NAME = (VITE?.VITE_NETWORK || 'base') as 'base' | 'baseSepolia'
export const TARGET_CHAIN = TARGET_NAME === 'base' ? base : baseSepolia

// Optional Alchemy key for more reliable RPC
const ALCHEMY_KEY = VITE?.VITE_ALCHEMY_KEY
const ALCHEMY_BASE_HTTP =
  ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : undefined
const ALCHEMY_SEPOLIA_HTTP =
  ALCHEMY_KEY ? `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}` : undefined

// Small helper to build a resilient HTTP transport
function resilientHttp(url: string) {
  return http(url, {
    batch: { wait: 20 }, // coalesce JSON-RPC calls
    retryCount: 5,
    retryDelay: 250,
    timeout: 12_000,
  })
}

// Helper: build a fallback transport list (env → Alchemy → official)
function buildBaseHttpFallback(kind: 'mainnet' | 'sepolia') {
  const envUrl = kind === 'mainnet' ? VITE?.VITE_BASE_RPC : VITE?.VITE_BASE_SEPOLIA_RPC
  const alchemyUrl = kind === 'mainnet' ? ALCHEMY_BASE_HTTP : ALCHEMY_SEPOLIA_HTTP
  const officialUrl = kind === 'mainnet' ? 'https://mainnet.base.org' : 'https://sepolia.base.org'
  const candidates = [envUrl, alchemyUrl, officialUrl].filter(Boolean) as string[]
  return fallback(candidates.map((u) => resilientHttp(u)), { retryCount: 2 })
}

const transports = {
  [base.id]: buildBaseHttpFallback('mainnet'),
  [baseSepolia.id]: buildBaseHttpFallback('sepolia'),
} as const

// --- wagmi config ------------------------------------------------------------
export const wagmiConfig = createConfig({
  chains: [TARGET_CHAIN],
  transports,

  connectors: [
    injected({ shimDisconnect: true }),
    walletConnect({
      projectId: WC_PROJECT_ID!,
      showQrModal: true, // ← always show WalletConnect’s own modal (reliable)
      metadata: {
        name: 'HearMeOwT',
        description: 'Post, vote, and earn $MEOWT.',
        url: typeof window !== 'undefined' ? window.location.origin : 'https://hearmeowt.xyz',
        icons: [
          typeof window !== 'undefined'
            ? new URL('/brand/logo-meowt.png', window.location.origin).toString()
            : 'https://hearmeowt.xyz/brand/logo-meowt.png',
        ],
      },
    }),
    coinbaseWallet({
      appName: 'HearMeOwT',
      preference: 'all',
      chainId: TARGET_CHAIN.id,
    }),
  ],

  multiInjectedProviderDiscovery: true,
  // pollingInterval: 1500, // optional if you want faster block polling
})
