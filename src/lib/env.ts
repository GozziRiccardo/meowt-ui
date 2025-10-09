export const WC_PROJECT_ID = (import.meta as any)?.env?.VITE_WC_PROJECT_ID as string | undefined

export function assertEnv() {
  if (!WC_PROJECT_ID || typeof WC_PROJECT_ID !== 'string' || WC_PROJECT_ID.trim().length < 8) {
    const msg = '[ENV] Missing or invalid VITE_WC_PROJECT_ID (Web3Modal project id).'
    console.error(msg, { present: !!WC_PROJECT_ID, len: WC_PROJECT_ID?.length })
    if (typeof window !== 'undefined' && import.meta.env.PROD) {
      const el = document.createElement('div')
      el.textContent = msg
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;padding:8px 12px;background:#fee;border-bottom:1px solid #f99;color:#900;font:12px/1.4 ui-sans-serif,system-ui;z-index:2147483647'
      document.body.appendChild(el)
    }
  } else if (typeof window !== 'undefined') {
    const masked = `${WC_PROJECT_ID.slice(0, 4)}…${WC_PROJECT_ID.slice(-4)}`
    console.log('[ENV] VITE_WC_PROJECT_ID present:', masked)
    ;(window as any).__W3M_PROJECT_ID = masked
  }
}
