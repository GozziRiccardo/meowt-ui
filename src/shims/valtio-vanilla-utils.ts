import { proxyMap as createProxyMap, subscribe } from './valtio-vanilla'

export function subscribeKey<T extends object, K extends keyof T>(
  state: T,
  key: K,
  callback: (value: T[K]) => void
) {
  const isMap = state instanceof Map
  let current = (isMap ? (state as unknown as Map<K, T[K]>).get(key) : state[key]) as T[K]
  // Immediately notify with current value
  try {
    callback(current)
  } catch (err) {
    console.error('[valtio/vanilla utils stub] initial callback error', err)
  }
  return subscribe(
    state,
    () => {
      const next = (isMap
        ? (state as unknown as Map<K, T[K]>).get(key)
        : state[key]) as T[K]
      if (next !== current) {
        current = next
        try {
          callback(next)
        } catch (err) {
          console.error('[valtio/vanilla utils stub] callback error', err)
        }
      }
    },
    true
  )
}

export function proxyMap<K, V>(entries?: Iterable<readonly [K, V]>) {
  return createProxyMap(entries)
}
