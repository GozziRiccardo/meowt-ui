import { useEffect } from 'react'

/**
 * Web3Modal has been removed in favour of native WalletConnect and custom pickers.
 * Keep this component as a harmless stub so existing imports do not break.
 */
export default function Web3ModalHost() {
  useEffect(() => {
    console.log('[Web3ModalHost] Stub mounted - no Web3Modal element required')
  }, [])
  return null
}
