// Web3Modal removed due to persistent 403 errors from WalletConnect Cloud
// Using native WalletConnect QR modal instead

export function ensureWeb3ModalLoaded() {
  console.log('[web3modal] Skipped - using native WalletConnect modal')
  return undefined
}
