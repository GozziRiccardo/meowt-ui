export const WC_PROJECT_ID = (import.meta as any)?.env?.VITE_WC_PROJECT_ID as string | undefined

export function assertEnv() {
  if (!WC_PROJECT_ID || typeof WC_PROJECT_ID !== 'string' || WC_PROJECT_ID.trim().length < 8) {
    if (typeof window !== 'undefined') {
      delete (window as any).__W3M_PROJECT_ID
    }
  } else if (typeof window !== 'undefined') {
    const masked = `${WC_PROJECT_ID.slice(0, 4)}…${WC_PROJECT_ID.slice(-4)}`
    console.log('[ENV] VITE_WC_PROJECT_ID present:', masked)
    ;(window as any).__W3M_PROJECT_ID = masked
  }
}
