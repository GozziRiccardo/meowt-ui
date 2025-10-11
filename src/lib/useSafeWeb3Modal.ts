import * as React from 'react'
import { useWeb3Modal as useWeb3ModalBase } from '@web3modal/wagmi/react'
import { ensureWeb3ModalLoaded } from '../web3modal'

export function useSafeWeb3Modal(): ReturnType<typeof useWeb3ModalBase> {
  // Base hook should not throw when used under WagmiProvider
  const base = useWeb3ModalBase()

  // Proactively init once on mount (idempotent)
  React.useEffect(() => {
    ensureWeb3ModalLoaded()
  }, [])

  // Wrap open: ensure init, retry once if needed, then push wallet list view
  const open: ReturnType<typeof useWeb3ModalBase>['open'] = React.useCallback(
    async (options) => {
      const opts = (options ?? { view: 'Connect' }) as Parameters<
        ReturnType<typeof useWeb3ModalBase>['open']
      >[0]

      // Ensure modal init
      let initialized = ensureWeb3ModalLoaded()
      try {
        await base.open(opts)
      } catch (e1) {
        console.warn('[web3modal] open() failed, retrying after re-init', e1)
        if (typeof window !== 'undefined') {
          window.__w3mInit = false
        }
        initialized = ensureWeb3ModalLoaded()
        if (!initialized) throw e1
        await base.open(opts)
      }

      // Force wallet list view to show options on mobile (no injected wallet)
      try {
        const { RouterController } = await import('@web3modal/core')
        RouterController.push('ConnectWallets')
      } catch {
        /* non-fatal */
      }
    },
    [base]
  )

  const close: ReturnType<typeof useWeb3ModalBase>['close'] = base.close

  return React.useMemo(
    () => ({ ...base, open, close }),
    [base, open, close]
  )
}
