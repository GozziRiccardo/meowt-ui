import { useEffect } from 'react'
import { useSafeWeb3Modal } from '../lib/useSafeWeb3Modal'

export default function W3MDebug() {
  const { open } = useSafeWeb3Modal()
  useEffect(() => {
    ;(window as any).openW3M = () => open().catch(console.error)
    console.log('[W3MDebug] window.openW3M available')
  }, [open])
  return null
}
