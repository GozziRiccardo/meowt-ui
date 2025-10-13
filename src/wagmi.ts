// src/wagmi.ts
import { createConfig } from 'wagmi'
import type { CreateConnectorFn } from 'wagmi'
import { base, baseSepolia } from 'wagmi/chains'
import { coinbaseWallet, injected, metaMask, walletConnect } from 'wagmi/connectors'
import { http, fallback } from 'viem'

// --- Env helpers -------------------------------------------------------------
const VITE = import.meta.env as any

// WalletConnect - make it optional, app should work without it
const _pid = VITE?.VITE_WALLETCONNECT_PROJECT_ID?.trim()
export const WC_PROJECT_ID = _pid || undefined

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
    batch: { wait: 20 },
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
  const extraMainnet =
    kind === 'mainnet'
      ? ['https://base-rpc.publicnode.com', 'https://rpc.ankr.com/base']
      : []
  const candidates = [envUrl, alchemyUrl, ...extraMainnet, officialUrl].filter(Boolean) as string[]
  return fallback(candidates.map((u) => resilientHttp(u)), { retryCount: 2 })
}

const transports = {
  [base.id]: buildBaseHttpFallback('mainnet'),
  [baseSepolia.id]: buildBaseHttpFallback('sepolia'),
} as const

// Build connectors list
const APP_URL =
  typeof window !== 'undefined' ? window.location.origin : 'https://hearmeowt.app'
const APP_ICON =
  typeof window !== 'undefined'
    ? new URL('/brand/logo-meowt.png', window.location.origin).toString()
    : 'https://hearmeowt.app/brand/logo-meowt.png'

const APP_METADATA = {
  name: 'HearMeOwT',
  description: 'Post, vote, and earn $MEOWT.',
  url: APP_URL,
  icons: [APP_ICON],
}

const connectorsList: CreateConnectorFn[] = [
  metaMask({
    dappMetadata: {
      name: APP_METADATA.name,
      url: APP_METADATA.url,
    },
    useDeeplink: true,
  }),
  injected({
    shimDisconnect: true,
  }),
  coinbaseWallet({
    appName: 'HearMeOwT',
    preference: 'all',
    chainId: TARGET_CHAIN.id,
  }),
]

// Only add WalletConnect if we have a project ID
if (WC_PROJECT_ID && WC_PROJECT_ID.length > 8) {
  console.log(
    '[wagmi] WalletConnect enabled with project ID:',
    `${WC_PROJECT_ID.slice(0, 4)}...${WC_PROJECT_ID.slice(-4)}`
  )
  connectorsList.push(
    walletConnect({
      projectId: WC_PROJECT_ID,
      showQrModal: true,
      qrModalOptions: {
        themeMode: 'dark',
        themeVariables: {
          '--wcm-z-index': '9999',
        },
      },
      metadata: APP_METADATA,
    })
  )
} else {
  console.warn('[wagmi] WalletConnect disabled: no valid project ID')
}

// --- wagmi config ------------------------------------------------------------
export const wagmiConfig = createConfig({
  chains: [TARGET_CHAIN],
  transports,
  connectors: connectorsList,
  multiInjectedProviderDiscovery: true,
})
