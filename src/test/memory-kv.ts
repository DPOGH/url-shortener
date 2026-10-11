type PutOptions = {
  expirationTtl?: number
  expiration?: number
  metadata?: unknown
}

/** Minimal in-memory KVNamespace for route tests. */
export const createMemoryKv = (): KVNamespace => {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, _options?: PutOptions) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null
    }),
    getWithMetadata: async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
      cacheStatus: null
    })
  } as unknown as KVNamespace
}
