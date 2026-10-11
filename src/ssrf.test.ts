import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isBlockedProbeHost,
  isHttpUrl,
  isPublicIpv4,
  isPublicIpv6,
  probeDestination,
  validateProbeUrl
} from './ssrf'

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
  })

  it('rejects other schemes and junk', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('ftp://example.com')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('isPublicIpv4', () => {
  it('accepts public addresses', () => {
    expect(isPublicIpv4('1.1.1.1')).toBe(true)
    expect(isPublicIpv4('8.8.8.8')).toBe(true)
  })

  it('rejects private and reserved ranges', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1'
    ]) {
      expect(isPublicIpv4(ip), ip).toBe(false)
    }
  })
})

describe('isPublicIpv6', () => {
  it('accepts global unicast', () => {
    expect(isPublicIpv6('2606:4700:4700::1111')).toBe(true)
  })

  it('rejects loopback, ULA and link-local', () => {
    expect(isPublicIpv6('::1')).toBe(false)
    expect(isPublicIpv6('fc00::1')).toBe(false)
    expect(isPublicIpv6('fe80::1')).toBe(false)
  })
})

describe('isBlockedProbeHost', () => {
  it('blocks localhost-style and metadata hosts', () => {
    expect(isBlockedProbeHost('localhost')).toBe(true)
    expect(isBlockedProbeHost('foo.localhost')).toBe(true)
    expect(isBlockedProbeHost('printer.local')).toBe(true)
    expect(isBlockedProbeHost('metadata')).toBe(true)
    expect(isBlockedProbeHost('127.0.0.1')).toBe(true)
    expect(isBlockedProbeHost('[::1]')).toBe(true)
  })

  it('allows public hostnames and IPs', () => {
    expect(isBlockedProbeHost('example.com')).toBe(false)
    expect(isBlockedProbeHost('1.1.1.1')).toBe(false)
  })
})

describe('validateProbeUrl / probeDestination', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects URLs with credentials', async () => {
    const result = await validateProbeUrl(
      'https://user:pass@example.com/',
      new AbortController().signal
    )
    expect(result).toBeNull()
  })

  it('rejects private IP destinations without DNS', async () => {
    const probe = await probeDestination('http://127.0.0.1/')
    expect(probe.reachable).toBe(false)
    expect(probe.error).toBe('blocked-or-invalid-url')
  })

  it('fails closed when DNS returns a private address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('cloudflare-dns.com')) {
          return Response.json({
            Status: 0,
            Answer: [{ type: 1, data: '10.0.0.5' }]
          })
        }
        return new Response('should not probe', { status: 200 })
      })
    )

    const probe = await probeDestination('https://evil.example/')
    expect(probe.reachable).toBe(false)
    expect(probe.error).toBe('blocked-or-invalid-url')
  })

  it('accepts a public destination that answers HEAD 200', async () => {
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
        expect(init?.method).toBe('HEAD')
        return new Response(null, { status: 200 })
      })
    )

    const probe = await probeDestination('https://example.com/page')
    expect(probe).toEqual({ reachable: true, status: 200 })
  })

  it('blocks redirects to private targets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('cloudflare-dns.com')) {
          return Response.json({
            Status: 0,
            Answer: [{ type: 1, data: '93.184.216.34' }]
          })
        }
        if (init?.method === 'HEAD' && url === 'https://example.com/start') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'http://127.0.0.1/secret' }
          })
        }
        return new Response(null, { status: 200 })
      })
    )

    const probe = await probeDestination('https://example.com/start')
    expect(probe.reachable).toBe(false)
    expect(probe.error).toBe('blocked-redirect')
  })
})
