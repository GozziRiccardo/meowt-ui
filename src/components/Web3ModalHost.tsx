import { createElement } from 'react'
import { createPortal } from 'react-dom'

/**
 * Ensures the Web3Modal custom element is present in the DOM so that
 * imperative `useWeb3Modal().open()` calls actually display the modal.
 */
export default function Web3ModalHost() {
  if (typeof document === 'undefined') return null

  return createPortal(createElement('w3m-modal'), document.body)
}
