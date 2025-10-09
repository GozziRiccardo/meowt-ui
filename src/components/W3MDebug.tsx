import { useEffect } from 'react'
import { useWeb3Modal } from '@web3modal/wagmi/react'

export default function W3MDebug() {
  const { open } = useWeb3Modal()
  useEffect(() => {
    ;(window as any).openW3M = () => open().catch(console.error)
    console.log('[W3MDebug] window.openW3M available')
  }, [open])
  return null
}
