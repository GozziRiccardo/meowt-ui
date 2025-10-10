import * as React from 'react'
import { useWeb3Modal as useWeb3ModalBase } from '@web3modal/wagmi/react'

let warnedMissing = false

const missingMessage =
  'Wallet connect modal is unavailable. Please ensure VITE_WALLETCONNECT_PROJECT_ID is configured or try again later.'

export function useSafeWeb3Modal(): ReturnType<typeof useWeb3ModalBase> {
  const fallback = React.useMemo(() => {
    const open: ReturnType<typeof useWeb3ModalBase>['open'] = async (options) => {
      if (!warnedMissing) {
        console.warn('[web3modal] open() fallback invoked', { options })
        if (typeof window !== 'undefined') {
          alert(missingMessage)
        }
      }
      warnedMissing = true
      throw new Error('Web3Modal has not been initialised')
    }

    const close: ReturnType<typeof useWeb3ModalBase>['close'] = async () => {
      warnedMissing = true
    }

    return { open, close }
  }, [])

  try {
    return useWeb3ModalBase()
  } catch (err) {
    if (!warnedMissing) {
      console.error('[web3modal] Falling back to inert modal controls because createWeb3Modal has not been called.', err)
    }
    warnedMissing = true
    return fallback
  }
}
