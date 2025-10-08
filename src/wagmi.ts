// src/wagmi.ts
import { createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';
import { fallback } from 'viem'; // NEW

// --- Env helpers -------------------------------------------------------------
const VITE = import.meta.env as any;

// WalletConnect (env preferred, fallback OK)
export const WC_PROJECT_ID =
  VITE?.VITE_WALLETCONNECT_PROJECT_ID || '7188dae135975f14cfd0b636ad5d8679';

// Target network: "base" | "baseSepolia"
const TARGET_NAME = (VITE?.VITE_NETWORK || 'base') as 'base' | 'baseSepolia';
export const TARGET_CHAIN = TARGET_NAME === 'base' ? base : baseSepolia;

// Optional Alchemy key for more reliable RPC (+ optional WebSocket)
const ALCHEMY_KEY = VITE?.VITE_ALCHEMY_KEY;
const ALCHEMY_BASE_HTTP    = ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`   : undefined;
const ALCHEMY_SEPOLIA_HTTP = ALCHEMY_KEY ? `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`   : undefined;

// Small helper to build a resilient HTTP transport
function resilientHttp(url: string) {
  return http(url, {
    // coalesce JSON-RPC calls; helps with rate limits
    batch: { wait: 20 },
    // retry transient transport hiccups
    retryCount: 5,
    retryDelay: 250,
    // avoid hanging forever on slow RPCs
    timeout: 12_000,
  });
}

// Helper: build a fallback transport list (env → Alchemy → public(s))
function buildBaseHttpFallback(kind: 'mainnet' | 'sepolia') {
  const envUrl       = kind === 'mainnet' ? VITE?.VITE_BASE_RPC        : VITE?.VITE_BASE_SEPOLIA_RPC;
  const alchemyUrl   = kind === 'mainnet' ? ALCHEMY_BASE_HTTP          : ALCHEMY_SEPOLIA_HTTP;
  const officialUrl  = kind === 'mainnet' ? 'https://mainnet.base.org' : 'https://sepolia.base.org';

  // You can add another public as a 4th rung if you want (e.g. PublicNode/BlockPi/Ankr)
  const candidates = [envUrl, alchemyUrl, officialUrl].filter(Boolean) as string[];

  return fallback(
    candidates.map((u) => resilientHttp(u)),
    // If one node gets slow or flaky, viem will swap in the next
    { retryCount: 2 }
  );
}

// Prefer multi-endpoint fallbacks
const transports = {
  [base.id]: buildBaseHttpFallback('mainnet'),
  [baseSepolia.id]: buildBaseHttpFallback('sepolia'),
} as const;

// Optional WebSocket transport (greatly speeds up confirmations if available)
// --- Config ------------------------------------------------------------------
export const wagmiConfig = createConfig({
  chains: [TARGET_CHAIN],
  transports,

  connectors: [
    // Injected covers MetaMask, Rabby, Frame, etc.
    injected({ shimDisconnect: true }),

    walletConnect({
      projectId: WC_PROJECT_ID,
      showQrModal: false, // Web3Modal provides the modal
      metadata: {
        name: 'HearMeOwT',
        description: 'MEOWT dApp',
        url:
          typeof window !== 'undefined'
            ? window.location.origin
            : 'https://meowt.app',
        icons: [
          typeof window !== 'undefined'
            ? new URL('/brand/logo-meowt.png', window.location.origin).toString()
            : '',
        ],
      },
    }),

    // Allow Smart Wallet, extension, and mobile app
    coinbaseWallet({
      appName: 'HearMeOwT',
      preference: 'all',
      chainId: TARGET_CHAIN.id,
    }),
  ],

  // These two help UX without being aggressive
  multiInjectedProviderDiscovery: true,
  // (Optional) uncomment to tighten polling if you’re not on websockets:
  // pollingInterval: 1500,
});
