export const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export const normalizeHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')

export const parseIpv4 = (value: string): number[] | null => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null
  const parts = value.split('.').map(Number)
  if (parts.some((part) => part < 0 || part > 255)) return null
  return parts
}

export const isPublicIpv4 = (value: string): boolean => {
  const parts = parseIpv4(value)
  if (!parts) return false
  const [a, b, c] = parts

  // Reject all non-global ranges: unspecified, private, loopback, link-local,
  // carrier NAT, documentation/benchmark networks and multicast/reserved.
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && c === 0) return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

export const parseIpv6 = (value: string): number[] | null => {
  const normalized = value.split('%')[0].toLowerCase()
  if (!normalized.includes(':')) return null

  let address = normalized
  const ipv4Tail = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail)
    if (!ipv4) return null
    const replacement = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${(
      (ipv4[2] << 8) |
      ipv4[3]
    ).toString(16)}`
    address = address.slice(0, -ipv4Tail.length) + replacement
  }

  if ((address.match(/::/g) || []).length > 1) return null
  const halves = address.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (
    missing < 0 ||
    (halves.length === 1 && missing !== 0) ||
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))
  ) {
    return null
  }
  const parts = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...right
  ].map((part) => Number.parseInt(part, 16))
  return parts.length === 8 ? parts : null
}

export const isPublicIpv6 = (value: string): boolean => {
  const parts = parseIpv6(value)
  if (!parts) return false
  // Public unicast IPv6 is currently allocated from 2000::/3. This rejects
  // loopback, link-local, unique-local, multicast, documentation and mapped
  // IPv4/NAT64 forms that can otherwise hide private IPv4 destinations.
  return parts[0] >= 0x2000 && parts[0] <= 0x3fff
}

export const isIpAddress = (hostname: string): boolean =>
  parseIpv4(hostname) !== null || parseIpv6(hostname) !== null

export const isPublicIp = (hostname: string): boolean =>
  parseIpv4(hostname) !== null
    ? isPublicIpv4(hostname)
    : isPublicIpv6(hostname)

export const isBlockedProbeHost = (hostname: string): boolean => {
  const host = normalizeHostname(hostname)
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'home.arpa' ||
    host.endsWith('.home.arpa') ||
    host === 'metadata' ||
    host === 'instance-data' ||
    host.endsWith('.invalid')
  ) {
    return true
  }
  return isIpAddress(host) && !isPublicIp(host)
}

type DnsJsonResponse = {
  Status?: number
  Answer?: Array<{ type?: number; data?: string }>
}

/** Resolve both address families through a fixed trusted DoH endpoint. */
export const resolvePublicAddresses = async (
  hostname: string,
  signal: AbortSignal
): Promise<boolean> => {
  const host = normalizeHostname(hostname)
  if (isIpAddress(host)) return isPublicIp(host)

  const resolve = async (type: 'A' | 'AAAA'): Promise<string[]> => {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      {
        headers: { Accept: 'application/dns-json' },
        redirect: 'manual',
        signal
      }
    )
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      throw new Error('dns-check-failed')
    }
    const body = (await response.json()) as DnsJsonResponse
    if (body.Status !== 0) return []
    const expectedType = type === 'A' ? 1 : 28
    return (body.Answer || [])
      .filter((answer) => answer.type === expectedType && answer.data)
      .map((answer) => normalizeHostname(answer.data!))
  }

  const [ipv4, ipv6] = await Promise.all([resolve('A'), resolve('AAAA')])
  const addresses = [...ipv4, ...ipv6]
  return addresses.length > 0 && addresses.every(isPublicIp)
}

export const validateProbeUrl = async (
  value: string,
  signal: AbortSignal
): Promise<URL | null> => {
  if (!isHttpUrl(value)) return null
  const parsed = new URL(value)
  if (
    parsed.username ||
    parsed.password ||
    isBlockedProbeHost(parsed.hostname) ||
    !(await resolvePublicAddresses(parsed.hostname, signal))
  ) {
    return null
  }
  return parsed
}

/** Probe whether a destination URL looks reachable (admin-only helper). */
export const probeDestination = async (
  rawUrl: string
): Promise<{ reachable: boolean; status?: number; error?: string }> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    let currentUrl = rawUrl
    const maxRedirects = 5

    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const parsed = await validateProbeUrl(currentUrl, controller.signal)
      if (!parsed) {
        return {
          reachable: false,
          error: redirects === 0 ? 'blocked-or-invalid-url' : 'blocked-redirect'
        }
      }

      let res = await fetch(parsed.toString(), {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'toias.link-linkcheck/1.0' }
      })

      // Some hosts reject HEAD — retry with a light GET. The body is never read.
      if (res.status === 405 || res.status === 501) {
        await res.body?.cancel()
        res = await fetch(parsed.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'toias.link-linkcheck/1.0',
            Range: 'bytes=0-0'
          }
        })
      }

      const status = res.status
      if (status >= 300 && status < 400) {
        const location = res.headers.get('location')
        await res.body?.cancel()
        if (!location || redirects === maxRedirects) {
          return { reachable: false, status, error: 'redirect-limit' }
        }
        currentUrl = new URL(location, parsed).toString()
        continue
      }

      await res.body?.cancel()
      // 401/403 prove that the host exists but access is gated.
      const reachable =
        (status >= 200 && status < 300) || status === 401 || status === 403
      return { reachable, status }
    }
    return { reachable: false, error: 'redirect-limit' }
  } catch (error) {
    console.error('Destination probe failed:', error)
    return { reachable: false, error: 'fetch-failed' }
  } finally {
    clearTimeout(timer)
  }
}
