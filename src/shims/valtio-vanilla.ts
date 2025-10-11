// Minimal stub of `valtio/vanilla` implementing the subset required by `derive-valtio`.
// Provides reactive-ish behaviour sufficient for connectors that rely on derived stores.

type Listener = (ops: [propertyKey: PropertyKey, value: unknown, previous: unknown][]) => void

type StoreMeta = {
  listeners: Set<Listener>
  version: number
  target?: Record<PropertyKey, unknown>
}

const storeMap = new WeakMap<object, StoreMeta>()

function notifyListeners(target: object, ops: [PropertyKey, unknown, unknown][]) {
  const meta = ensureMeta(target)
  meta.version += 1
  meta.listeners.forEach((listener) => {
    try {
      listener(ops)
    } catch (err) {
      console.error('[valtio/vanilla stub] listener error', err)
    }
  })
}

function ensureMeta(target: object): StoreMeta {
  let meta = storeMap.get(target)
  if (!meta) {
    meta = { listeners: new Set(), version: 0 }
    storeMap.set(target, meta)
  }
  return meta
}

function cloneInitial<T extends object>(value: T): T {
  if (Array.isArray(value)) {
    return [...value] as unknown as T
  }
  return { ...value } as T
}

export function proxy<T extends object>(initial?: T): T {
  const base = initial ? cloneInitial(initial) : ({} as T)
  const target = base as Record<PropertyKey, unknown>
  const proxyObject = new Proxy(target, {
    set(obj, prop, value) {
      const prev = obj[prop]
      if (prev === value) return true
      obj[prop] = value
      const ops: [PropertyKey, unknown, unknown][] = [[prop, value, prev]]
      notifyListeners(proxyObject, ops)
      return true
    },
  }) as T

  const meta = ensureMeta(proxyObject)
  meta.target = target
  return proxyObject
}

export function proxyMap<K, V>(entries?: Iterable<readonly [K, V]>) {
  const map = new Map<K, V>(entries)
  const meta = ensureMeta(map as unknown as object)
  meta.target = map as unknown as Record<PropertyKey, unknown>

  const notify = (key: PropertyKey, value: unknown, prev: unknown) => {
    notifyListeners(map as unknown as object, [[key, value, prev]])
  }

  const originalSet = map.set.bind(map)
  map.set = ((key: K, value: V) => {
    const prev = map.get(key)
    originalSet(key, value)
    if (prev !== value) notify(key as PropertyKey, value, prev)
    return map
  }) as any

  const originalDelete = map.delete.bind(map)
  map.delete = ((key: K) => {
    const prev = map.get(key)
    const result = originalDelete(key)
    if (result) notify(key as PropertyKey, undefined, prev)
    return result
  }) as any

  const originalClear = map.clear.bind(map)
  map.clear = (() => {
    if (map.size > 0) {
      originalClear()
      notify('clear', undefined, undefined)
    }
  }) as any

  return map
}

export function subscribe<T extends object>(state: T, listener: Listener, notifyInSync = false) {
  const meta = ensureMeta(state as object)
  meta.listeners.add(listener)
  if (notifyInSync) {
    try {
      listener([])
    } catch (err) {
      console.error('[valtio/vanilla stub] sync listener error', err)
    }
  }
  return () => {
    const current = storeMap.get(state as object)
    current?.listeners.delete(listener)
  }
}

export function getVersion(state: object): number {
  return ensureMeta(state).version
}

export function snapshot<T extends object>(state: T): T {
  const meta = storeMap.get(state as object)
  const target = meta?.target ?? (state as unknown as Record<PropertyKey, unknown>)
  const source = target as unknown as T
  if (source instanceof Map) {
    return new Map(source) as unknown as T
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(source)
  }
  return JSON.parse(JSON.stringify(source))
}

export function ref<T>(value: T): T {
  return value
}
