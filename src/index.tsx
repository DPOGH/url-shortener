import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { renderer } from './renderer'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import QRCode from 'qrcode'

type Bindings = {
  KV: KVNamespace
}

type AppEnv = {
  Bindings: Bindings
  Variables: {
    cspNonce: string
  }
}

const app = new Hono<AppEnv>()

// Security headers for every response. Inline scripts require a per-request
// nonce; inline styles remain allowed until the UI is moved to a stylesheet.
app.use('*', async (c, next) => {
  const nonce = crypto.randomUUID().replace(/-/g, '')
  c.set('cspNonce', nonce)
  await next()

  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "worker-src 'none'",
      "manifest-src 'self'",
      'upgrade-insecure-requests'
    ].join('; ')
  )
  c.header('Strict-Transport-Security', 'max-age=31536000')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header(
    'Permissions-Policy',
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()'
  )
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
})

// Apply JSX renderer to all routes
app.all('*', renderer)

const SHORT_KEY_RE = /^[0-9a-z]{6}$/

/** Traffic-light indicator for status feedback */
const Semaphore = ({
  color,
  className,
  title
}: {
  color: 'green' | 'yellow' | 'red'
  className?: string
  title?: string
}) => {
  const dim = '#333'
  const colors = {
    red: color === 'red' ? '#e63946' : dim,
    yellow: color === 'yellow' ? '#f4a261' : dim,
    green: color === 'green' ? '#2a9d8f' : dim
  }
  const label =
    title ||
    (color === 'green' ? 'OK' : color === 'yellow' ? 'Check' : 'Error')
  return (
    <div
      class={className}
      role="img"
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 6px',
        background: '#111',
        border: '1px solid #444',
        borderRadius: '10px',
        verticalAlign: 'middle'
      }}
    >
      <span
        style={{
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: colors.red,
          boxShadow: color === 'red' ? '0 0 6px #e63946' : 'none'
        }}
      />
      <span
        style={{
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: colors.yellow,
          boxShadow: color === 'yellow' ? '0 0 6px #f4a261' : 'none'
        }}
      />
      <span
        style={{
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: colors.green,
          boxShadow: color === 'green' ? '0 0 6px #2a9d8f' : 'none'
        }}
      />
    </div>
  )
}

/**
 * Best-effort fixed-window rate limiting backed by Cloudflare KV.
 * Access identity is preferred; Cloudflare's connecting IP is the fallback.
 */
const rateLimit = (
  scope: string,
  limit: number,
  windowSeconds: number,
  mode: 'html' | 'json'
): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const identity =
      c.req.header('cf-access-authenticated-user-email') ||
      c.req.header('cf-connecting-ip') ||
      'unknown'
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(identity.toLowerCase())
    )
    const identityHash = Array.from(new Uint8Array(digest))
      .slice(0, 16)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    const now = Math.floor(Date.now() / 1000)
    const windowStart = Math.floor(now / windowSeconds) * windowSeconds
    const resetAt = windowStart + windowSeconds
    const key = `__rate__:${scope}:${windowStart}:${identityHash}`
    const current = Number.parseInt((await c.env.KV.get(key)) || '0', 10) || 0

    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - current - 1)))
    c.header('X-RateLimit-Reset', String(resetAt))

    if (current >= limit) {
      const retryAfter = Math.max(1, resetAt - now)
      c.header('Retry-After', String(retryAfter))
      c.header('X-RateLimit-Remaining', '0')
      if (mode === 'json') {
        return c.json(
          {
            ok: false,
            error: 'rate-limit',
            message: `Too many requests. Try again in ${retryAfter} seconds.`,
            retryAfter
          },
          429
        )
      }
      c.status(429)
      return c.render(
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          <Semaphore color="red" />
          <div>
            <h2>Too many requests</h2>
            <p>
              Please wait {retryAfter} seconds before trying this action again.
            </p>
            <p>
              <a href="/admin/">Back to admin</a>
            </p>
          </div>
        </div>
      )
    }

    await c.env.KV.put(key, String(current + 1), {
      expirationTtl: windowSeconds + 60
    })
    await next()
  }
}

const focusStyles = (
  <style>
    {`
      input[type="text"],
      input[type="date"],
      input[type="url"] {
        outline: none;
      }
      input[type="text"]:focus,
      input[type="date"]:focus,
      input[type="url"]:focus {
        border-color: #00b4d8;
        box-shadow: 0 0 3px #00b4d8;
      }
    `}
  </style>
)

/** Standalone HTML error page (no site chrome) with traffic light */
const standaloneStatusPage = (opts: {
  title: string
  heading: string
  message: string
  detail?: string
  color: 'green' | 'yellow' | 'red'
  status: number
  homeHref?: string
  /** Auto-redirect after N ms (e.g. 10000) */
  redirectAfterMs?: number
  redirectHref?: string
  nonce: string
}) => {
  const lit =
    opts.color === 'red'
      ? { r: '#e63946', y: '#333', g: '#333', glow: '#e63946' }
      : opts.color === 'yellow'
        ? { r: '#333', y: '#f4a261', g: '#333', glow: '#f4a261' }
        : { r: '#333', y: '#333', g: '#2a9d8f', glow: '#2a9d8f' }
  const home = opts.homeHref ?? 'https://www.iasociety.org'
  const redirectHref = opts.redirectHref ?? home
  const detail = opts.detail
    ? `<p style="color:#aaa;font-size:0.9em;">${opts.detail}</p>`
    : ''
  const seconds =
    opts.redirectAfterMs && opts.redirectAfterMs > 0
      ? Math.round(opts.redirectAfterMs / 1000)
      : 0
  const redirectNote =
    seconds > 0
      ? `<p id="redirect-note">You will be redirected in <span id="redirect-count">${seconds}</span> seconds to iasociety.org.</p>`
      : ''
  const redirectScript =
    seconds > 0
      ? `<script nonce="${opts.nonce}">
            (function () {
              var left = ${seconds};
              var el = document.getElementById('redirect-count');
              var timer = setInterval(function () {
                left -= 1;
                if (el) el.textContent = String(Math.max(left, 0));
                if (left <= 0) {
                  clearInterval(timer);
                  window.location.href = ${JSON.stringify(redirectHref)};
                }
              }, 1000);
            })();
          </script>`
      : ''
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>${opts.title}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="background:#000;color:#fff;font-family:system-ui,sans-serif;">
    <div style="max-width:600px;margin:60px auto;text-align:center;">
      <div role="img" aria-label="${opts.color}" title="${opts.color}"
        style="display:inline-flex;flex-direction:column;gap:6px;padding:12px 10px;background:#111;border:1px solid #444;border-radius:14px;margin-bottom:20px;">
        <span style="width:18px;height:18px;border-radius:50%;background:${lit.r};box-shadow:${opts.color === 'red' ? `0 0 8px ${lit.glow}` : 'none'};"></span>
        <span style="width:18px;height:18px;border-radius:50%;background:${lit.y};box-shadow:${opts.color === 'yellow' ? `0 0 8px ${lit.glow}` : 'none'};"></span>
        <span style="width:18px;height:18px;border-radius:50%;background:${lit.g};box-shadow:${opts.color === 'green' ? `0 0 8px ${lit.glow}` : 'none'};"></span>
      </div>
      <h2>${opts.heading}</h2>
      <p>${opts.message}</p>
      ${detail}
      ${redirectNote}
      <p style="margin-top:24px;">
        <a href="${home}" style="color:#00b4d8;">Go to IAS</a>
        &nbsp;·&nbsp;
        <a href="/admin/" style="color:#00b4d8;">Admin</a>
      </p>
    </div>
    ${redirectScript}
  </body>
</html>`,
    {
      status: opts.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }
  )
}
/**
 * CSRF for all unsafe methods (not only form content-types).
 * On failure: HTML page or JSON depending on mode.
 */
const csrfProtect = (
  mode: 'html' | 'json' = 'html'
): MiddlewareHandler => {
  return async (c, next) => {
    if (/^(GET|HEAD|OPTIONS)$/i.test(c.req.method)) {
      await next()
      return
    }
    const secFetchSite = c.req.header('sec-fetch-site')
    const origin = c.req.header('origin')
    const reqOrigin = new URL(c.req.url).origin
    const allowedBySecFetch = secFetchSite === 'same-origin'
    const allowedByOrigin = !!origin && origin === reqOrigin

    if (!allowedBySecFetch && !allowedByOrigin) {
      if (mode === 'json') {
        return c.json(
          {
            ok: false,
            error: 'csrf',
            message:
              'Request blocked by CSRF check. Reload the page and try again from this site.'
          },
          403
        )
      }
      return c.render(
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          <Semaphore color="red" />
          <div>
            <h2>Request blocked (CSRF)</h2>
            <p>
              This action was rejected because it did not come from this site.
              Open the form again and resubmit.
            </p>
            <p>
              <a href="/admin/">Back to admin</a>
            </p>
          </div>
        </div>
      )
    }
    await next()
  }
}

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

// Redirect for shortened URL (valid 6-char key)
app.get('/:key{[0-9a-z]{6}}', async (c) => {
  const key = c.req.param('key')
  const url = await c.env.KV.get(key)

  if (url === null) {
    return standaloneStatusPage({
      title: 'Link not found',
      heading: 'Link not found',
      message: 'This short link does not exist or was deleted.',
      detail: `Checked key: ${key}`,
      color: 'red',
      status: 404,
      homeHref: 'https://www.iasociety.org',
      redirectAfterMs: 10000,
      redirectHref: 'https://www.iasociety.org',
      nonce: c.get('cspNonce')
    })
  }

  if (!isHttpUrl(url)) {
    return standaloneStatusPage({
      title: 'Invalid link',
      heading: 'Invalid destination',
      message:
        'This short link points to a non-http(s) URL and will not be opened.',
      color: 'red',
      status: 400,
      nonce: c.get('cspNonce')
    })
  }

  return c.redirect(url)
})

// Redirect root / to /admin/
app.get('/', (c) => {
  return c.redirect('/admin/')
})

// Redirect /admin to /admin/
app.get('/admin', (c) => {
  return c.redirect('/admin/')
})

// Home page with form — destination reachability checked on submit (not while typing)
app.get('/admin/', (c) => {
  return c.render(
    <div>
      <h2>Create shortened URL!</h2>
      <form action="/admin/create" method="post" id="create-form">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap'
          }}
        >
          <Semaphore color="yellow" />
          <input
            id="url-input"
            type="url"
            name="url"
            autoComplete="off"
            placeholder="https://example.com/..."
            required
            style={{
              width: '70%',
              minWidth: '220px',
              padding: '6px 8px',
              backgroundColor: '#222',
              color: '#f5f5f5',
              border: '1px solid #555',
              borderRadius: '4px'
            }}
          />
          <button type="submit" id="create-submit">
            Create
          </button>
        </div>
        <p
          id="url-status"
          style={{ marginTop: '8px', fontSize: '0.85em', color: '#ccc' }}
        >
          Enter an http(s) URL. On Create we check that the destination exists
          before saving.
        </p>
      </form>

      <p style={{ marginTop: '10px' }}>
        <a href="/admin/history">View history</a>
      </p>

      {focusStyles}

      <script
        nonce={c.get('cspNonce')}
        dangerouslySetInnerHTML={{
          __html: `
          (function () {
            const input = document.getElementById('url-input');
            const status = document.getElementById('url-status');
            const form = document.getElementById('create-form');
            const submitBtn = document.getElementById('create-submit');
            const lights = form ? form.querySelectorAll('[role="img"] span') : [];
            if (!input || !form || lights.length < 3) return;

            let allowSubmit = false;

            function setLight(color) {
              const map = { red: 0, yellow: 1, green: 2 };
              const on = ['#e63946', '#f4a261', '#2a9d8f'];
              lights.forEach((el, i) => {
                const active = map[color] === i;
                el.style.background = active ? on[i] : '#333';
                el.style.boxShadow = active ? '0 0 6px ' + on[i] : 'none';
              });
            }

            function isHttpUrl(value) {
              try {
                const u = new URL(value);
                return u.protocol === 'http:' || u.protocol === 'https:';
              } catch (e) {
                return false;
              }
            }

            // While typing: only reset to yellow (no live destination probe)
            input.addEventListener('input', function () {
              allowSubmit = false;
              setLight('yellow');
              if (status) {
                status.textContent =
                  'Enter an http(s) URL. On Create we check that the destination exists before saving.';
              }
            });

            form.addEventListener('submit', async function (e) {
              if (allowSubmit) {
                allowSubmit = false;
                return;
              }
              e.preventDefault();

              const value = (input.value || '').trim();
              if (!isHttpUrl(value)) {
                setLight('red');
                if (status) status.textContent = 'Invalid URL. Use http:// or https:// only.';
                return;
              }

              setLight('yellow');
              if (status) status.textContent = 'Checking destination…';
              if (submitBtn) submitBtn.disabled = true;

              try {
                const res = await fetch(
                  '/admin/check-destination?url=' + encodeURIComponent(value)
                );
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.reachable) {
                  setLight('red');
                  const extra =
                    data && data.status
                      ? ' (HTTP ' + data.status + ')'
                      : data && data.error
                        ? ' (' + data.error + ')'
                        : '';
                  if (status) {
                    status.textContent =
                      'Destination does not exist or is unreachable' +
                      extra +
                      '. Short link was not created.';
                  }
                  return;
                }

                setLight('green');
                if (status) status.textContent = 'Destination OK — creating short link…';
                allowSubmit = true;
                if (typeof form.requestSubmit === 'function') {
                  form.requestSubmit();
                } else {
                  form.submit();
                }
              } catch (err) {
                setLight('red');
                if (status) status.textContent = 'Destination check failed. Try again.';
              } finally {
                if (submitBtn) submitBtn.disabled = false;
              }
            });
          })();
        `
        }}
      />
    </div>
  )
})

const schema = z.object({
  url: z
    .string()
    .trim()
    .url({ message: 'Invalid URL format' })
    .refine(isHttpUrl, { message: 'Only http and https URLs are allowed' })
})

// Zod validator with clear error page + red semaphore
const validator = zValidator('form', schema, (result, c) => {
  if (!result.success) {
    const issue = result.error.issues[0]?.message || 'Invalid URL'
    return c.render(
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
        <Semaphore color="red" />
        <div>
          <h2>Invalid URL</h2>
          <p>{issue}</p>
          <p>Use a full address starting with <code>http://</code> or <code>https://</code>.</p>
          <p>
            <a href="/admin/">Back to admin</a>
          </p>
        </div>
      </div>
    )
  }
})

// History support in KV (max 500 items)
type HistoryItem = {
  key: string
  url: string
  createdAt: string
}

const HISTORY_KEY = '__history__'

const addToHistory = async (kv: KVNamespace, item: HistoryItem) => {
  const json = await kv.get(HISTORY_KEY)
  let list: HistoryItem[] = []
  if (json) {
    try {
      list = JSON.parse(json) as HistoryItem[]
    } catch {
      list = []
    }
  }
  list.unshift(item)
  if (list.length > 500) {
    list = list.slice(0, 500)
  }
  await kv.put(HISTORY_KEY, JSON.stringify(list))
}

const getHistory = async (kv: KVNamespace): Promise<HistoryItem[]> => {
  const json = await kv.get(HISTORY_KEY)
  if (!json) return []
  try {
    return JSON.parse(json) as HistoryItem[]
  } catch {
    return []
  }
}

// Remove single entry from history array
const removeFromHistory = async (kv: KVNamespace, keyToRemove: string) => {
  const json = await kv.get(HISTORY_KEY)
  if (!json) return
  let list: HistoryItem[]
  try {
    list = JSON.parse(json) as HistoryItem[]
  } catch {
    return
  }
  const filtered = list.filter((item) => item.key !== keyToRemove)
  await kv.put(HISTORY_KEY, JSON.stringify(filtered))
}

const normalizeHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')

const parseIpv4 = (value: string): number[] | null => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null
  const parts = value.split('.').map(Number)
  if (parts.some((part) => part < 0 || part > 255)) return null
  return parts
}

const isPublicIpv4 = (value: string): boolean => {
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

const parseIpv6 = (value: string): number[] | null => {
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

const isPublicIpv6 = (value: string): boolean => {
  const parts = parseIpv6(value)
  if (!parts) return false
  // Public unicast IPv6 is currently allocated from 2000::/3. This rejects
  // loopback, link-local, unique-local, multicast, documentation and mapped
  // IPv4/NAT64 forms that can otherwise hide private IPv4 destinations.
  return parts[0] >= 0x2000 && parts[0] <= 0x3fff
}

const isIpAddress = (hostname: string): boolean =>
  parseIpv4(hostname) !== null || parseIpv6(hostname) !== null

const isPublicIp = (hostname: string): boolean =>
  parseIpv4(hostname) !== null
    ? isPublicIpv4(hostname)
    : isPublicIpv6(hostname)

const isBlockedProbeHost = (hostname: string): boolean => {
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
const resolvePublicAddresses = async (
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
        redirect: 'error',
        signal
      }
    )
    if (!response.ok) throw new Error('dns-check-failed')
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

const validateProbeUrl = async (
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
const probeDestination = async (
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

// Check destination URL reachability (used by history page)
app.get(
  '/admin/check-destination',
  rateLimit('destination-check', 300, 60, 'json'),
  async (c) => {
    const url = c.req.query('url') || ''
    const result = await probeDestination(url)
    return c.json({
      ok: true,
      url,
      reachable: result.reachable,
      status: result.status ?? null,
      error: result.error ?? null
    })
  }
)

// Local QR SVG for a short key (Workers-safe; no third-party API / no canvas)
app.get('/admin/qr/:key{[0-9a-z]{6}}', async (c) => {
  const key = c.req.param('key')
  const dest = await c.env.KV.get(key)
  if (dest === null) {
    return c.json({ ok: false, error: 'not-found', message: 'Short link not found' }, 404)
  }
  const shortUrl = new URL(`/${key}`, c.req.url).toString()
  const qrSvgRaw = await QRCode.toString(shortUrl, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M'
  })
  const qrSvg = qrSvgRaw.replace('<svg', '<svg width="200" height="200"')
  return c.body(qrSvg, 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'private, max-age=3600'
  })
})

// History page with filters
app.get('/admin/history', async (c) => {
  const items = await getHistory(c.env.KV)

  // Existence check for semaphore (green = KV key present)
  const existence = await Promise.all(
    items.map(async (item) => {
      const v = await c.env.KV.get(item.key)
      return { key: item.key, exists: v !== null }
    })
  )
  const existsMap = new Map(existence.map((e) => [e.key, e.exists]))

  return c.render(
    <div>
      <h2>History (latest {items.length} entries)</h2>
      <p>
        Showing up to 500 latest shortened URLs. The dot next to the original
        URL is green when the destination is reachable and red when it is not.
      </p>

      {/* Filters: text + date range */}
      <div style={{ marginBottom: '10px', fontSize: '0.85em' }}>
        <div style={{ marginBottom: '6px' }}>
          <label>
            Search (URL / short URL):{' '}
            <input
              id="history-search"
              type="text"
              placeholder="Filter by URL..."
              style={{
                width: '60%',
                padding: '4px 6px',
                backgroundColor: '#222',
                color: '#f5f5f5',
                border: '1px solid #555',
                borderRadius: '4px'
              }}
            />
          </label>
        </div>

        <div>
          <span>
            <label>
              From:{' '}
              <input
                id="history-from"
                type="date"
                style={{
                  padding: '3px 4px',
                  backgroundColor: '#222',
                  color: '#f5f5f5',
                  border: '1px solid #555',
                  borderRadius: '4px'
                }}
              />
            </label>
          </span>
          <span style={{ marginLeft: '10px' }}>
            <label>
              To:{' '}
              <input
                id="history-to"
                type="date"
                style={{
                  padding: '3px 4px',
                  backgroundColor: '#222',
                  color: '#f5f5f5',
                  border: '1px solid #555',
                  borderRadius: '4px'
                }}
              />
            </label>
          </span>
          <button
            id="history-clear-filters"
            type="button"
            style={{ marginLeft: '10px' }}
          >
            Clear filters
          </button>
        </div>
      </div>

      <table
        id="history-table"
        style={{
          fontSize: '0.8em',
          borderCollapse: 'collapse',
          width: '100%',
          border: '1px solid #555',
          backgroundColor: '#111'
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                borderBottom: '1px solid #555',
                padding: '4px',
                textAlign: 'left'
              }}
            >
              Created at
            </th>
            <th
              style={{
                borderBottom: '1px solid #555',
                padding: '4px',
                textAlign: 'left'
              }}
            >
              Original URL
            </th>
            <th
              style={{
                borderBottom: '1px solid #555',
                padding: '4px',
                textAlign: 'left'
              }}
            >
              Short URL
            </th>
            <th
              style={{
                borderBottom: '1px solid #555',
                padding: '4px',
                textAlign: 'left'
              }}
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const shortUrl = new URL(`/${item.key}`, c.req.url).toString()
            const exists = existsMap.get(item.key) ?? false
            return (
              <tr key={item.key} data-exists={exists ? '1' : '0'}>
                <td
                  class="created-at-cell"
                  style={{
                    padding: '4px',
                    verticalAlign: 'top',
                    borderTop: '1px solid #333'
                  }}
                >
                  {item.createdAt}
                </td>
                <td
                  style={{
                    padding: '4px',
                    verticalAlign: 'top',
                    borderTop: '1px solid #333'
                  }}
                >
                  <span
                    class="dest-dot"
                    data-url={item.url}
                    title="Checking destination..."
                    style={{
                      display: 'inline-block',
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: '#f4a261',
                      marginRight: '6px',
                      verticalAlign: 'middle',
                      boxShadow: '0 0 4px #f4a261'
                    }}
                  />
                  <a href={item.url}>{item.url}</a>
                </td>
                <td
                  style={{
                    padding: '4px',
                    verticalAlign: 'top',
                    borderTop: '1px solid #333'
                  }}
                >
                  <a href={shortUrl}>{shortUrl}</a>
                </td>
                <td
                  style={{
                    padding: '4px',
                    verticalAlign: 'top',
                    whiteSpace: 'nowrap',
                    borderTop: '1px solid #333'
                  }}
                >
                  <button
                    type="button"
                    class="copy-short-btn"
                    data-url={shortUrl}
                  >
                    Copy URL
                  </button>
                  <button
                    type="button"
                    class="qr-copy-btn"
                    data-url={shortUrl}
                    data-key={item.key}
                    style={{ marginLeft: '6px' }}
                    disabled={!exists}
                  >
                    Copy QR
                  </button>
                  <button
                    type="button"
                    class="delete-btn"
                    data-key={item.key}
                    style={{ marginLeft: '6px' }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <p style={{ marginTop: '10px' }}>
        <a href="/admin/">Back to Home</a>
      </p>

      <p
        id="history-status"
        style={{ marginTop: '8px', fontSize: '0.8em', color: '#ccc' }}
      />

      {focusStyles}

      {/* Client-side script: filters, copy, delete, local QR */}
      <script
        nonce={c.get('cspNonce')}
        dangerouslySetInnerHTML={{
          __html: `
          (function () {
            const statusEl = document.getElementById('history-status');
            const searchInput = document.getElementById('history-search');
            const fromInput = document.getElementById('history-from');
            const toInput = document.getElementById('history-to');
            const clearBtn = document.getElementById('history-clear-filters');
            const table = document.getElementById('history-table');

            function setStatus(msg) {
              if (!statusEl) return;
              statusEl.textContent = msg;
              if (msg) {
                setTimeout(() => { statusEl.textContent = ''; }, 2500);
              }
            }

            function applyFilters() {
              if (!table) return;
              const text = (searchInput && searchInput.value || '').toLowerCase().trim();
              const fromVal = fromInput && fromInput.value ? new Date(fromInput.value) : null;
              const toVal = toInput && toInput.value ? new Date(toInput.value) : null;

              const tbody = table.querySelector('tbody');
              if (!tbody) return;
              const rows = Array.from(tbody.querySelectorAll('tr'));

              rows.forEach((tr) => {
                const tds = tr.getElementsByTagName('td');
                if (tds.length < 3) return;

                const createdAtText = tds[0].textContent || '';
                const originalText = (tds[1].textContent || '').toLowerCase();
                const shortText = (tds[2].textContent || '').toLowerCase();

                const matchesText =
                  !text ||
                  originalText.includes(text) ||
                  shortText.includes(text);

                let matchesDate = true;
                if (fromVal || toVal) {
                  const createdDate = new Date(createdAtText);
                  if (fromVal && createdDate < fromVal) {
                    matchesDate = false;
                  }
                  if (toVal) {
                    const toEnd = new Date(toVal);
                    toEnd.setDate(toEnd.getDate() + 1);
                    if (createdDate >= toEnd) {
                      matchesDate = false;
                    }
                  }
                }

                tr.style.display = matchesText && matchesDate ? '' : 'none';
              });
            }

            if (searchInput) searchInput.addEventListener('input', applyFilters);
            if (fromInput) fromInput.addEventListener('change', applyFilters);
            if (toInput) toInput.addEventListener('change', applyFilters);
            if (clearBtn) {
              clearBtn.addEventListener('click', () => {
                if (searchInput) searchInput.value = '';
                if (fromInput) fromInput.value = '';
                if (toInput) toInput.value = '';
                applyFilters();
              });
            }

            document.querySelectorAll('.copy-short-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const url = btn.getAttribute('data-url');
                if (!url) return;
                try {
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(url);
                  } else {
                    const textArea = document.createElement('textarea');
                    textArea.value = url;
                    document.body.appendChild(textArea);
                    textArea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textArea);
                  }
                  setStatus('Short URL copied!');
                } catch (e) {
                  setStatus('Copy failed');
                }
              });
            });

            document.querySelectorAll('.delete-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const key = btn.getAttribute('data-key');
                if (!key) return;
                if (!confirm('Delete this short URL?')) return;

                try {
                  const res = await fetch('/admin/history/delete/' + encodeURIComponent(key), {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    }
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    setStatus((data && data.message) || 'Delete failed');
                    return;
                  }
                  const tr = btn.closest('tr');
                  if (tr && tr.parentNode) {
                    tr.parentNode.removeChild(tr);
                  }
                  setStatus('Deleted');
                  applyFilters();
                } catch (e) {
                  setStatus('Delete error');
                }
              });
            });

            // Local QR endpoint (SVG) → PNG in browser — no third-party API
            async function generateQrPngBlob(key) {
              const resp = await fetch('/admin/qr/' + encodeURIComponent(key));
              if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error((data && data.message) || 'QR fetch failed');
              }
              const svgText = await resp.text();
              const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
              const url = URL.createObjectURL(svgBlob);
              try {
                const img = new Image();
                const imgLoad = new Promise((resolve, reject) => {
                  img.onload = resolve;
                  img.onerror = reject;
                });
                img.src = url;
                await imgLoad;
                const canvas = document.createElement('canvas');
                canvas.width = 200;
                canvas.height = 200;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('No canvas context');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, 200, 200);
                ctx.drawImage(img, 0, 0, 200, 200);
                return await new Promise((resolve, reject) => {
                  canvas.toBlob((blob) => {
                    if (!blob) reject(new Error('PNG blob failed'));
                    else resolve(blob);
                  }, 'image/png');
                });
              } finally {
                URL.revokeObjectURL(url);
              }
            }

            function downloadBlob(blob, filename) {
              const blobUrl = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = blobUrl;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(blobUrl);
            }

            document.querySelectorAll('.qr-copy-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const key = btn.getAttribute('data-key');
                if (!key) return;
                try {
                  const blob = await generateQrPngBlob(key);
                  if (
                    navigator.clipboard &&
                    window.ClipboardItem &&
                    navigator.clipboard.write
                  ) {
                    const item = new ClipboardItem({ 'image/png': blob });
                    await navigator.clipboard.write([item]);
                    setStatus('QR copied!');
                  } else {
                    downloadBlob(blob, 'qr-code.png');
                    setStatus('Clipboard not supported, downloaded PNG');
                  }
                } catch (e) {
                  setStatus((e && e.message) || 'QR copy failed');
                }
              });
            });

            // Destination reachability — update the dot next to the original URL
            function setDestDot(dot, reachable, detail) {
              if (!dot) return;
              if (reachable) {
                dot.style.background = '#2a9d8f';
                dot.style.boxShadow = '0 0 4px #2a9d8f';
                dot.title = detail || 'Destination reachable';
              } else {
                dot.style.background = '#e63946';
                dot.style.boxShadow = '0 0 4px #e63946';
                dot.title = detail || 'Destination not reachable';
              }
            }

            async function checkDestination(dot) {
              const url = dot.getAttribute('data-url');
              if (!url) {
                setDestDot(dot, false, 'Missing URL');
                return;
              }
              try {
                const res = await fetch(
                  '/admin/check-destination?url=' + encodeURIComponent(url)
                );
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  setDestDot(dot, false, 'Check failed');
                  return;
                }
                const detail = data.reachable
                  ? ('Destination OK' + (data.status ? ' (' + data.status + ')' : ''))
                  : ('Destination missing/unreachable' +
                      (data.status ? ' (' + data.status + ')' : '') +
                      (data.error ? ' — ' + data.error : ''));
                setDestDot(dot, !!data.reachable, detail);
              } catch (e) {
                setDestDot(dot, false, 'Check error');
              }
            }

            async function runPool(nodes, limit, worker) {
              let i = 0;
              async function run() {
                while (i < nodes.length) {
                  const idx = i++;
                  await worker(nodes[idx]);
                }
              }
              const n = Math.min(limit, nodes.length) || 0;
              await Promise.all(Array.from({ length: n }, () => run()));
            }

            const destDots = Array.from(document.querySelectorAll('.dest-dot'));
            runPool(destDots, 4, checkDestination);

            applyFilters();
          })();
        `
        }}
      />
    </div>
  )
})

// Generate unique key and store URL in KV
const createKey = async (kv: KVNamespace, url: string): Promise<string> => {
  const uuid = crypto.randomUUID()
  const key = uuid.substring(0, 6).toLowerCase()
  const result = await kv.get(key)
  if (!result) {
    await kv.put(key, url)
    return key
  } else {
    return await createKey(kv, url)
  }
}

// Create shortened URL + QR (SVG 200px) + copy & PNG buttons
app.post(
  '/admin/create',
  rateLimit('create', 30, 600, 'html'),
  csrfProtect('html'),
  validator,
  async (c) => {
  try {
    const { url } = c.req.valid('form')

    // Server-side destination check (authoritative — blocks unreachable URLs)
    const probe = await probeDestination(url)
    if (!probe.reachable) {
      const detail =
        probe.status != null
          ? `HTTP status: ${probe.status}`
          : probe.error
            ? `Reason: ${probe.error}`
            : undefined
      return c.render(
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          <Semaphore color="red" />
          <div>
            <h2>Destination not reachable</h2>
            <p>
              The original URL does not exist or did not respond. No short link
              was created.
            </p>
            <p style={{ fontSize: '0.85em', color: '#aaa', wordBreak: 'break-all' }}>
              {url}
            </p>
            {detail ? (
              <p style={{ fontSize: '0.85em', color: '#aaa' }}>{detail}</p>
            ) : null}
            <p>
              <a href="/admin/">Back to admin</a>
            </p>
          </div>
        </div>
      )
    }

    const key = await createKey(c.env.KV, url)

    const shortenUrl = new URL(`/${key}`, c.req.url)
    const shortUrlStr = shortenUrl.toString()

    await addToHistory(c.env.KV, {
      key,
      url,
      createdAt: new Date().toISOString()
    })

    const qrSvgRaw = await QRCode.toString(shortUrlStr, {
      type: 'svg',
      margin: 0
    })

    const qrSvg = qrSvgRaw.replace(
      '<svg',
      '<svg width="200" height="200"'
    )

    return c.render(
      <div>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          <Semaphore color="green" />
          <div>
            <h2>Created!</h2>
            <p style={{ fontSize: '0.9em', color: '#aaa' }}>Short link is active.</p>
          </div>
        </div>

        <div style={{ marginBottom: '10px', marginTop: '12px' }}>
          <input
            id="short-url"
            type="text"
            value={shortUrlStr}
            style={{
              width: '80%',
              padding: '6px 8px',
              backgroundColor: '#222',
              color: '#f5f5f5',
              border: '1px solid #555',
              borderRadius: '4px'
            }}
            readOnly
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <button id="copy-url-btn" type="button">
            Copy URL
          </button>
          <button
            id="copy-qr-btn"
            type="button"
            style={{ marginLeft: '10px' }}
          >
            Copy QR (PNG)
          </button>
          <span
            id="copy-status"
            style={{ marginLeft: '10px', fontSize: '0.9em' }}
          />
        </div>

        <div style={{ marginTop: '10px' }}>
          <h3>QR Code:</h3>
          <div
            id="qr-container"
            style={{ width: '200px', height: '200px' }}
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        </div>

        <div style={{ marginTop: '10px' }}>
          <a href="/admin/">Back to Home</a>
          <span> | </span>
          <a href="/admin/history">View history</a>
        </div>

        <script
          nonce={c.get('cspNonce')}
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                const copyUrlBtn = document.getElementById('copy-url-btn');
                const copyQrBtn = document.getElementById('copy-qr-btn');
                const input = document.getElementById('short-url');
                const status = document.getElementById('copy-status');
                const qrContainer = document.getElementById('qr-container');
                if (!input || !qrContainer) return;

                if (copyUrlBtn) {
                  copyUrlBtn.addEventListener('click', async () => {
                    const text = input.value;
                    try {
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(text);
                      } else {
                        input.select();
                        document.execCommand('copy');
                      }
                      if (status) {
                        status.textContent = 'URL copied!';
                        setTimeout(() => (status.textContent = ''), 2000);
                      }
                    } catch (e) {
                      if (status) status.textContent = 'URL copy failed';
                    }
                  });
                }

                async function svgToPngBlob() {
                  const svgEl = qrContainer.querySelector('svg');
                  if (!svgEl) throw new Error('SVG not found');

                  const svgData = new XMLSerializer().serializeToString(svgEl);
                  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
                  const url = URL.createObjectURL(svgBlob);

                  try {
                    const img = new Image();
                    const imgLoad = new Promise((resolve, reject) => {
                      img.onload = resolve;
                      img.onerror = reject;
                    });
                    img.src = url;
                    await imgLoad;

                    const canvas = document.createElement('canvas');
                    canvas.width = 200;
                    canvas.height = 200;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) throw new Error('No canvas context');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, 200, 200);

                    return await new Promise((resolve, reject) => {
                      canvas.toBlob((blob) => {
                        if (!blob) reject(new Error('PNG blob failed'));
                        else resolve(blob);
                      }, 'image/png');
                    });
                  } finally {
                    URL.revokeObjectURL(url);
                  }
                }

                function downloadPng(blob) {
                  const pngUrl = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = pngUrl;
                  a.download = 'qr-code.png';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(pngUrl);
                }

                if (copyQrBtn) {
                  copyQrBtn.addEventListener('click', async () => {
                    try {
                      const blob = await svgToPngBlob();

                      if (
                        navigator.clipboard &&
                        window.ClipboardItem &&
                        navigator.clipboard.write
                      ) {
                        const item = new ClipboardItem({ 'image/png': blob });
                        await navigator.clipboard.write([item]);
                        if (status) {
                          status.textContent = 'QR copied to clipboard!';
                          setTimeout(() => (status.textContent = ''), 2000);
                        }
                      } else {
                        downloadPng(blob);
                        if (status) {
                          status.textContent = 'Clipboard not supported, downloaded PNG';
                          setTimeout(() => (status.textContent = ''), 2000);
                        }
                      }
                    } catch (e) {
                      if (status) status.textContent = 'QR copy failed';
                    }
                  });
                }
              })();
            `
          }}
        />
      </div>
    )
  } catch (e) {
    console.error('Error in /admin/create handler:', e)
    throw e
  }
  }
)

// Delete single entry (KV key + history) — key format constrained
app.post(
  '/admin/history/delete/:key{[0-9a-z]{6}}',
  rateLimit('delete', 100, 600, 'json'),
  csrfProtect('json'),
  async (c) => {
    const key = c.req.param('key')
    if (!SHORT_KEY_RE.test(key)) {
      return c.json(
        { ok: false, error: 'invalid-key', message: 'Invalid short key' },
        400
      )
    }
    try {
      await c.env.KV.delete(key)
      await removeFromHistory(c.env.KV, key)
      return c.json({ ok: true })
    } catch (e) {
      console.error('Error deleting key from history:', e)
      return c.json(
        { ok: false, error: 'delete-failed', message: 'Delete failed' },
        500
      )
    }
  }
)

// Clearer global errors (no silent redirect to iasociety.org)
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  const path = new URL(c.req.url).pathname
  const isAdmin = path.startsWith('/admin')

  if (isAdmin) {
    return c.render(
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
        <Semaphore color="red" />
        <div>
          <h2>Something went wrong</h2>
          <p>An unexpected error occurred while processing your request.</p>
          <p style={{ fontSize: '0.85em', color: '#aaa' }}>
            {err instanceof Error ? err.message : 'Unknown error'}
          </p>
          <p>
            <a href="/admin/">Back to admin</a>
          </p>
        </div>
      </div>
    )
  }

  return standaloneStatusPage({
    title: 'Error',
    heading: 'Page not available',
    message: 'An unexpected error occurred or the page is not available.',
    color: 'red',
    status: 500,
    nonce: c.get('cspNonce')
  })
})

export default app
