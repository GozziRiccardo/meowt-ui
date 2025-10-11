import * as React from 'react'
import { useWeb3Modal as useWeb3ModalBase } from '@web3modal/wagmi/react'
import { ensureWeb3ModalLoaded } from '../web3modal'

let warnedMissing = false

export function useSafeWeb3Modal(): ReturnType<typeof useWeb3ModalBase> {
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    ensureWeb3ModalLoaded()
    setReady(true)
  }, [])

  void ready

  const fallback = React.useMemo(() => {
    const open: ReturnType<typeof useWeb3ModalBase>['open'] = async (options) => {
      console.log('[web3modal] Fallback open() called with options:', options)

      const modal = ensureWeb3ModalLoaded()
      if (modal) {
        console.log('[web3modal] Modal available after re-init, trying again')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      if (!warnedMissing) {
        warnedMissing = true
        const msg =
          'Could not open wallet selector. Please ensure you have a wallet app installed (like MetaMask or Coinbase Wallet).'
        console.warn('[web3modal]', msg)
        if (typeof window !== 'undefined') {
          alert(msg)
        }
      }
      throw new Error('Web3Modal unavailable')
    }

    const close: ReturnType<typeof useWeb3ModalBase>['close'] = async () => {
      console.log('[web3modal] Fallback close() called')
    }

    return { open, close }
  }, [])

  try {
    const modal = useWeb3ModalBase()
    return modal
  } catch (err) {
    if (!warnedMissing) {
      console.error('[web3modal] Hook failed, using fallback:', err)
    }
    return fallback
  }
}
