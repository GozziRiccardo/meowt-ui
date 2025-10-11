import * as React from 'react'

// Dummy implementation since we're not using Web3Modal
export function useSafeWeb3Modal() {
  return React.useMemo(
    () => ({
      open: async () => {
        console.log('[web3modal] No-op: using wagmi connectors directly')
      },
      close: async () => {
        console.log('[web3modal] No-op: using wagmi connectors directly')
      },
    }),
    []
  )
}
