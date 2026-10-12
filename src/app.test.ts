import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { createMemoryKv } from './test/memory-kv'

const ORIGIN = 'https://toias.link'

type TestEnv = {
  KV: KVNamespace
  SUPERADMIN_EMAILS?: string
}

const request = (path: string, init: RequestInit = {}, env: TestEnv) =>
  app.request(path.startsWith('http') ? path : `${ORIGIN}${path}`, init, env)

describe('URL shortener routes', () => {
  let kv: KVNamespace
  let env: TestEnv

  beforeEach(() => {
    kv = createMemoryKv()
    env = {
      KV: kv,
      SUPERADMIN_EMAILS: 'super@iasociety.org'
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('redirects / to /admin/', async () => {
    const res = await request('/', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/admin/')
  })

  it('serves the IAS favicon and logo', async () => {
    const favicon = await request('/favicon.ico', {}, env)
    expect(favicon.status).toBe(200)
    expect(favicon.headers.get('Content-Type')).toContain('image/svg+xml')
    const body = await favicon.text()
    expect(body).toContain('<svg')

    const logo = await request('/assets/ias-logo.svg', {}, env)
    expect(logo.status).toBe(200)
    expect(await logo.text()).toContain('International AIDS Society')
  })

  it('returns a branded 404 for missing short links and unknown pages', async () => {
    const missing = await request('/zzzzzz', {}, env)
    expect(missing.status).toBe(404)
    const missingHtml = await missing.text()
    expect(missingHtml).toContain('Link not found')
    expect(missingHtml).toContain('ias-logo.svg')

    const unknown = await request('/does/not/exist', {}, env)
    expect(unknown.status).toBe(404)
    expect(await unknown.text()).toContain('Page not found')
  })

  it('renders the create form with https:// prefilled', async () => {
    const res = await request('/admin/', {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('value="https://"')
    const csp = res.headers.get('Content-Security-Policy') || ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
  })

  it('rejects create without CSRF origin', async () => {
    const res = await request(
      '/admin/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'url=https://example.com'
      },
      env
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('CSRF')
  })

  it('creates a short link when destination is reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('cloudflare-dns.com')) {
          const type = new URL(url).searchParams.get('type')
          if (type === 'A') {
            return Response.json({
              Status: 0,
              Answer: [{ type: 1, data: '93.184.216.34' }]
            })
          }
          return Response.json({ Status: 0, Answer: [] })
        }
        if (init?.method === 'HEAD' || init?.method === 'GET') {
          return new Response(null, { status: 200 })
        }
        return new Response('unexpected', { status: 500 })
      })
    )

    const res = await request(
      '/admin/create',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: ORIGIN,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Access-Authenticated-User-Email': 'tester@iasociety.org'
        },
        body: 'url=' + encodeURIComponent('https://example.com/docs')
      },
      env
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Created!')

    const history = JSON.parse((await kv.get('__history__')) || '[]') as Array<{
      key: string
      url: string
      createdBy?: string
    }>
    expect(history).toHaveLength(1)
    expect(history[0].url).toBe('https://example.com/docs')
    expect(history[0].createdBy).toBe('tester@iasociety.org')
    expect(await kv.get(history[0].key)).toBe('https://example.com/docs')

    const audit = JSON.parse((await kv.get('__audit__')) || '[]') as Array<{
      action: string
      actor: string
    }>
    expect(audit[0]).toMatchObject({
      action: 'create',
      actor: 'tester@iasociety.org'
    })

    const redirect = await request(`/${history[0].key}`, {}, env)
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('Location')).toBe('https://example.com/docs')
  })

  it('does not create a short link for blocked destinations', async () => {
    const res = await request(
      '/admin/create',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: ORIGIN,
          'Sec-Fetch-Site': 'same-origin'
        },
        body: 'url=' + encodeURIComponent('http://127.0.0.1/')
      },
      env
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Destination not reachable')
    expect(await kv.get('__history__')).toBeNull()
  })

  it('blocks destination checks for private hosts', async () => {
    const res = await request(
      '/admin/check-destination?url=' + encodeURIComponent('http://192.168.0.1/'),
      {},
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reachable: boolean; error?: string }
    expect(body.reachable).toBe(false)
  })

  it('blocks delete from non-owners and allows creator or superadmin', async () => {
    await kv.put('abc123', 'https://example.com/x')
    await kv.put(
      '__history__',
      JSON.stringify([
        {
          key: 'abc123',
          url: 'https://example.com/x',
          createdAt: new Date().toISOString(),
          createdBy: 'owner@iasociety.org'
        }
      ])
    )

    const forbidden = await request(
      '/admin/history/delete/abc123',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Access-Authenticated-User-Email': 'other@iasociety.org',
          'Content-Type': 'application/json'
        }
      },
      env
    )
    expect(forbidden.status).toBe(403)
    expect(await kv.get('abc123')).toBe('https://example.com/x')

    const byOwner = await request(
      '/admin/history/delete/abc123',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Access-Authenticated-User-Email': 'owner@iasociety.org',
          'Content-Type': 'application/json'
        }
      },
      env
    )
    expect(byOwner.status).toBe(200)
    expect(await byOwner.json()).toEqual({ ok: true, trashed: true })
    expect(await kv.get('abc123')).toBeNull()

    const restoreForbidden = await request(
      '/admin/trash/restore/abc123',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Access-Authenticated-User-Email': 'other@iasociety.org',
          'Content-Type': 'application/json'
        }
      },
      env
    )
    expect(restoreForbidden.status).toBe(403)

    const restore = await request(
      '/admin/trash/restore/abc123',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Access-Authenticated-User-Email': 'super@iasociety.org',
          'Content-Type': 'application/json'
        }
      },
      env
    )
    expect(restore.status).toBe(200)
    expect(await kv.get('abc123')).toBe('https://example.com/x')
  })

  it('rebuilds orphan short links into History', async () => {
    await kv.put('orphan', 'https://example.com/orphan')
    await kv.put('listed', 'https://example.com/listed')
    await kv.put(
      '__history__',
      JSON.stringify([
        {
          key: 'listed',
          url: 'https://example.com/listed',
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'owner@iasociety.org'
        }
      ])
    )

    const res = await request(
      '/admin/history/rebuild-orphans',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Access-Authenticated-User-Email': 'owner@iasociety.org',
          'Content-Type': 'application/json'
        }
      },
      env
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, added: 1, total: 2 })

    const history = JSON.parse((await kv.get('__history__')) || '[]') as Array<{
      key: string
      createdBy?: string
    }>
    expect(history.map((item) => item.key)).toEqual(['listed', 'orphan'])
    expect(history[1].createdBy).toBe('legacy / unknown')
  })

  it('rate-limits destination checks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('cloudflare-dns.com')) {
          return Response.json({
            Status: 0,
            Answer: [{ type: 1, data: '93.184.216.34' }]
          })
        }
        return new Response(null, { status: 200 })
      })
    )

    const path =
      '/admin/check-destination?url=' +
      encodeURIComponent('https://example.com/')
    const headers = {
      'CF-Access-Authenticated-User-Email': 'ratelimit@iasociety.org'
    }

    for (let i = 0; i < 300; i++) {
      const res = await request(path, { headers }, env)
      expect(res.status).toBe(200)
    }

    const limited = await request(path, { headers }, env)
    expect(limited.status).toBe(429)
    const body = (await limited.json()) as { error: string }
    expect(body.error).toBe('rate-limit')
    expect(limited.headers.get('Retry-After')).toBeTruthy()
  })
})
