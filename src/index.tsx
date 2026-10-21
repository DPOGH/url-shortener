import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { renderer } from './renderer'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import QRCode from 'qrcode'
import styles from './style.css?raw'
import iasLogo from './ias-logo.svg?raw'
import iasIcon from './ias-icon.svg?raw'
import { isHttpUrl, probeDestination } from './ssrf'
import { APP_VERSION_LABEL } from './version'

type Bindings = {
  KV: KVNamespace
  /** Optional Teams/Slack incoming webhook for unhandled error alerts. */
  ALERT_WEBHOOK_URL?: string
  /** Comma-separated Access emails allowed to manage any short link. */
  SUPERADMIN_EMAILS?: string
}

type AppEnv = {
  Bindings: Bindings
  Variables: {
    cspNonce: string
  }
}

const app = new Hono<AppEnv>()

// Security headers for every response. Inline scripts and the embedded local
// stylesheet require a per-request nonce; style attributes are not allowed.
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
      `style-src 'self' 'nonce-${nonce}'`,
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

const svgAsset = (svg: string) => (c: Context<AppEnv>) =>
  c.body(svg, 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400'
  })

app.get('/assets/ias-logo.svg', svgAsset(iasLogo))
app.get('/assets/ias-icon.svg', svgAsset(iasIcon))
app.get('/favicon.ico', svgAsset(iasIcon))

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
  const label =
    title ||
    (color === 'green' ? 'OK' : color === 'yellow' ? 'Check' : 'Error')
  return (
    <div
      class={`semaphore ${className || ''}`.trim()}
      role="img"
      aria-label={label}
      title={label}
    >
      <span class={`semaphore-light red ${color === 'red' ? 'active' : ''}`} />
      <span
        class={`semaphore-light yellow ${color === 'yellow' ? 'active' : ''}`}
      />
      <span
        class={`semaphore-light green ${color === 'green' ? 'active' : ''}`}
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
        <div class="status-layout">
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
  const home = opts.homeHref ?? 'https://www.iasociety.org'
  const redirectHref = opts.redirectHref ?? home
  const detail = opts.detail
    ? `<p class="muted">${opts.detail}</p>`
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
    <link rel="icon" href="/assets/ias-icon.svg" type="image/svg+xml" />
    <style nonce="${opts.nonce}">${styles}</style>
  </head>
  <body>
    <div class="standalone-status">
      <a class="standalone-brand" href="/admin/" aria-label="IAS URL Shortener home">
        <span class="brand-logo">
          <img src="/assets/ias-logo.svg" alt="International AIDS Society" width="155" height="57" />
        </span>
        <span class="brand-title">URL Shortener</span>
      </a>
      <div class="semaphore semaphore-large" role="img" aria-label="${opts.color}" title="${opts.color}">
        <span class="semaphore-light red ${opts.color === 'red' ? 'active' : ''}"></span>
        <span class="semaphore-light yellow ${opts.color === 'yellow' ? 'active' : ''}"></span>
        <span class="semaphore-light green ${opts.color === 'green' ? 'active' : ''}"></span>
      </div>
      <h2>${opts.heading}</h2>
      <p>${opts.message}</p>
      ${detail}
      ${redirectNote}
      <p class="mt-24">
        <a href="${home}">Go to IAS</a>
        &nbsp;·&nbsp;
        <a href="/admin/">Admin</a>
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
        <div class="status-layout">
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
app.get('/admin/', async (c) => {
  const { actor, isSuperadmin } = await loadAuthz(c)
  return c.render(
    <div>
      <h2>Create shortened URL!</h2>
      <form action="/admin/create" method="post" id="create-form">
        <div class="form-row">
          <Semaphore color="yellow" />
          <input
            id="url-input"
            type="url"
            name="url"
            autoComplete="off"
            placeholder="https://example.com/..."
            value="https://"
            required
            class="url-input"
          />
          <button type="submit" id="create-submit">
            Create
          </button>
        </div>
        <p id="url-status" class="status-text">
          Enter an http(s) URL. On Create we check that the destination exists
          before saving.
        </p>
      </form>

      {isSuperadmin ? (
        <p class="mt-10">
          <a href="/admin/roles">Manage roles</a>
        </p>
      ) : null}

      {adminNav({ actor, isSuperadmin })}

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
              lights.forEach((el, i) => {
                el.classList.toggle('active', map[color] === i);
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
      <div class="status-layout">
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

// History support in KV
const HISTORY_MAX_ITEMS = 5000
const HISTORY_PAGE_SIZE = 100

type HistoryItem = {
  key: string
  url: string
  createdAt: string
  createdBy?: string
}

const HISTORY_KEY = '__history__'
const AUDIT_KEY = '__audit__'
const TRASH_KEY = '__trash__'
const TRASH_MAX_ITEMS = 1000

type TrashItem = {
  key: string
  url: string
  createdAt: string | null
  createdBy: string | null
  deletedAt: string
  deletedBy: string
}

type AuditItem = {
  action: 'create' | 'delete' | 'restore' | 'purge' | 'role-set'
  key: string
  url: string | null
  actor: string
  timestamp: string
}

type Role = 'user' | 'superadmin'
/** Only superadmin grants are stored. Everyone else is user by default. */
type RolesMap = Record<string, 'superadmin'>

const ROLES_KEY = '__roles__'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const getActor = (header: (name: string) => string | undefined): string => {
  const forwardedEmail = header('cf-access-authenticated-user-email')
  if (forwardedEmail) return forwardedEmail

  // Access always signs this token at the edge. Decode only to read the
  // already-authenticated identity when the convenience email header is absent.
  const token = header('cf-access-jwt-assertion')
  const payload = token?.split('.')[1]
  if (payload) {
    try {
      const raw = payload.replace(/-/g, '+').replace(/_/g, '/')
      const normalized = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')
      const decoded = JSON.parse(atob(normalized)) as { email?: unknown }
      if (typeof decoded.email === 'string') return decoded.email
    } catch {
      // Fall through to an explicit unknown marker.
    }
  }
  return 'unknown'
}

const parseBootstrapSuperadmins = (raw: string | undefined): Set<string> =>
  new Set(
    (raw || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  )

const getRolesMap = async (kv: KVNamespace): Promise<RolesMap> => {
  const json = await kv.get(ROLES_KEY)
  if (!json) return {}
  try {
    const parsed = JSON.parse(json) as Record<string, string>
    const clean: RolesMap = {}
    for (const [email, role] of Object.entries(parsed || {})) {
      const key = email.trim().toLowerCase()
      if (!EMAIL_RE.test(key)) continue
      // Legacy `user` assignments are ignored: Access login = user by default.
      if (role === 'superadmin') clean[key] = 'superadmin'
    }
    return clean
  } catch {
    return {}
  }
}

const putRolesMap = async (kv: KVNamespace, roles: RolesMap) => {
  await kv.put(ROLES_KEY, JSON.stringify(roles))
}

/**
 * Anyone who signs in via Access is a user by default.
 * Superadmin only via SUPERADMIN_EMAILS bootstrap or an explicit KV grant.
 */
const resolveRole = (
  actor: string,
  roles: RolesMap,
  bootstrap: Set<string>
): Role => {
  if (actor === 'unknown') return 'user'
  const email = actor.toLowerCase()
  if (roles[email] === 'superadmin' || bootstrap.has(email)) return 'superadmin'
  return 'user'
}

const isActorSuperadmin = (
  actor: string,
  roles: RolesMap,
  bootstrap: Set<string>
): boolean => resolveRole(actor, roles, bootstrap) === 'superadmin'

const listEffectiveSuperadmins = (
  roles: RolesMap,
  bootstrap: Set<string>
): string[] => {
  const emails = new Set<string>(bootstrap)
  for (const email of Object.keys(roles)) emails.add(email)
  return [...emails].sort()
}

/** Delete/restore/purge: creator or superadmin. Legacy (no owner) = superadmin only. */
const canManageLink = (
  actor: string,
  createdBy: string | null | undefined,
  roles: RolesMap,
  bootstrap: Set<string>
): boolean => {
  if (isActorSuperadmin(actor, roles, bootstrap)) return true
  if (!createdBy) return false
  const owner = createdBy.trim().toLowerCase()
  if (!owner || owner === 'unknown' || owner === 'legacy / unknown') return false
  return actor.toLowerCase() === owner
}

const loadAuthz = async (c: Context<AppEnv>) => {
  const actor = getActor((name) => c.req.header(name))
  const bootstrap = parseBootstrapSuperadmins(c.env.SUPERADMIN_EMAILS)
  const roles = await getRolesMap(c.env.KV)
  const role = resolveRole(actor, roles, bootstrap)
  return {
    actor,
    bootstrap,
    roles,
    role,
    isSuperadmin: role === 'superadmin'
  }
}

/** Clears the Cloudflare Access CF_Authorization cookie for this app. */
const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout'

const adminNav = (opts: {
  actor: string
  isSuperadmin: boolean
}) => (
  <div class="mt-10">
    <p>
      Signed in as {opts.actor}
      {opts.isSuperadmin ? ' (superadmin)' : ''}
      <span> · </span>
      <a href={ACCESS_LOGOUT_PATH}>Logout</a>
      <span class="muted"> · {APP_VERSION_LABEL}</span>
    </p>
    <p>
      <a href="/admin/">Home</a>
      <span> | </span>
      <a href="/admin/history">History</a>
      <span> | </span>
      <a href="/admin/trash">Trash</a>
      <span> | </span>
      <a href="/admin/audit">Audit</a>
      {opts.isSuperadmin ? (
        <span>
          <span> | </span>
          <a href="/admin/roles">Roles</a>
        </span>
      ) : null}
    </p>
  </div>
)

const listShortLinkKeys = async (kv: KVNamespace): Promise<string[]> => {
  const keys: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await kv.list({ limit: 1000, cursor })
    for (const entry of page.keys) {
      if (SHORT_KEY_RE.test(entry.name)) keys.push(entry.name)
    }
    if (page.list_complete) break
    cursor = page.cursor
  }
  return keys
}

/** Re-add active KV short keys that are missing from History (no date/owner). */
const rebuildOrphanHistory = async (
  kv: KVNamespace
): Promise<{ added: number; total: number }> => {
  const history = await getHistory(kv)
  const known = new Set(history.map((item) => item.key))
  const trashKeys = new Set((await getTrash(kv)).map((item) => item.key))
  const orphans: HistoryItem[] = []

  for (const key of await listShortLinkKeys(kv)) {
    if (known.has(key) || trashKeys.has(key)) continue
    const url = await kv.get(key)
    if (!url || !isHttpUrl(url)) continue
    orphans.push({
      key,
      url,
      createdAt: '1970-01-01T00:00:00.000Z',
      createdBy: 'legacy / unknown'
    })
    known.add(key)
  }

  if (orphans.length === 0) {
    return { added: 0, total: history.length }
  }

  const merged = [...history, ...orphans].slice(0, HISTORY_MAX_ITEMS)
  await kv.put(HISTORY_KEY, JSON.stringify(merged))
  return { added: orphans.length, total: merged.length }
}

const addAuditEntry = async (kv: KVNamespace, item: AuditItem) => {
  const json = await kv.get(AUDIT_KEY)
  let list: AuditItem[] = []
  if (json) {
    try {
      list = JSON.parse(json) as AuditItem[]
    } catch {
      list = []
    }
  }
  list.unshift(item)
  await kv.put(AUDIT_KEY, JSON.stringify(list.slice(0, 1000)))
  console.log(
    JSON.stringify({
      event: 'short-link-audit',
      ...item
    })
  )
}

const getAuditEntries = async (kv: KVNamespace): Promise<AuditItem[]> => {
  const json = await kv.get(AUDIT_KEY)
  if (!json) return []
  try {
    return JSON.parse(json) as AuditItem[]
  } catch {
    return []
  }
}

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
  if (list.length > HISTORY_MAX_ITEMS) {
    list = list.slice(0, HISTORY_MAX_ITEMS)
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

// Remove single entry from history array; returns the removed item when found.
const removeFromHistory = async (
  kv: KVNamespace,
  keyToRemove: string
): Promise<HistoryItem | null> => {
  const json = await kv.get(HISTORY_KEY)
  if (!json) return null
  let list: HistoryItem[]
  try {
    list = JSON.parse(json) as HistoryItem[]
  } catch {
    return null
  }
  const removed = list.find((item) => item.key === keyToRemove) || null
  const filtered = list.filter((item) => item.key !== keyToRemove)
  await kv.put(HISTORY_KEY, JSON.stringify(filtered))
  return removed
}

const getTrash = async (kv: KVNamespace): Promise<TrashItem[]> => {
  const json = await kv.get(TRASH_KEY)
  if (!json) return []
  try {
    return JSON.parse(json) as TrashItem[]
  } catch {
    return []
  }
}

const putTrash = async (kv: KVNamespace, list: TrashItem[]) => {
  await kv.put(TRASH_KEY, JSON.stringify(list.slice(0, TRASH_MAX_ITEMS)))
}

const addToTrash = async (kv: KVNamespace, item: TrashItem) => {
  const list = await getTrash(kv)
  const withoutKey = list.filter((entry) => entry.key !== item.key)
  withoutKey.unshift(item)
  await putTrash(kv, withoutKey)
}

const removeFromTrash = async (
  kv: KVNamespace,
  keyToRemove: string
): Promise<TrashItem | null> => {
  const list = await getTrash(kv)
  const removed = list.find((item) => item.key === keyToRemove) || null
  if (!removed) return null
  await putTrash(
    kv,
    list.filter((item) => item.key !== keyToRemove)
  )
  return removed
}

const notifyErrorAlert = async (
  webhookUrl: string | undefined,
  detail: { path: string; message: string; stack?: string }
) => {
  if (!webhookUrl) return
  try {
    const text = [
      'toias.link unhandled error',
      `Path: ${detail.path}`,
      `Message: ${detail.message}`,
      detail.stack ? `Stack: ${detail.stack.slice(0, 500)}` : null
    ]
      .filter(Boolean)
      .join('\n')
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    })
  } catch (error) {
    console.error('Alert webhook failed:', error)
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
  const { actor, roles, bootstrap, isSuperadmin } = await loadAuthz(c)

  return c.render(
    <div>
      <h2>History ({items.length} links)</h2>
      <p>
        The dot next to the original URL is green when the destination is
        reachable and red when it is not. Search and date filters cover the
        whole history. Only the creator or a superadmin can move a link to
        Trash.
      </p>

      {/* Filters: text + date range */}
      <div class="history-filters">
        <div class="mb-6">
          <label>
            Search (URL / short URL):{' '}
            <input
              id="history-search"
              type="text"
              placeholder="Filter by URL..."
              class="history-search"
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
                class="date-input"
              />
            </label>
          </span>
          <span class="ml-10">
            <label>
              To:{' '}
              <input
                id="history-to"
                type="date"
                class="date-input"
              />
            </label>
          </span>
          <button id="history-clear-filters" type="button" class="ml-10">
            Clear filters
          </button>
          <button id="history-rebuild-orphans" type="button" class="ml-10">
            Find missing links
          </button>
        </div>
      </div>

      <table id="history-table" class="history-table">
        <thead>
          <tr>
            <th>Created at</th>
            <th>Created by</th>
            <th>Original URL</th>
            <th>Short URL</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const shortUrl = new URL(`/${item.key}`, c.req.url).toString()
            const allowDelete = canManageLink(
              actor,
              item.createdBy,
              roles,
              bootstrap
            )
            return (
              <tr key={item.key} hidden={index >= HISTORY_PAGE_SIZE}>
                <td class="created-at-cell">
                  {item.createdAt}
                </td>
                <td>{item.createdBy || 'legacy / unknown'}</td>
                <td>
                  <span
                    class="dest-dot"
                    data-url={item.url}
                    title="Checking destination..."
                  />
                  <a href={item.url}>{item.url}</a>
                </td>
                <td>
                  <a href={shortUrl}>{shortUrl}</a>
                </td>
                <td class="actions-cell">
                  <button
                    type="button"
                    class="copy-short-btn"
                    data-url={shortUrl}
                  >
                    Copy URL
                  </button>
                  <button
                    type="button"
                    data-url={shortUrl}
                    data-key={item.key}
                    class="qr-copy-btn ml-6"
                  >
                    Copy QR
                  </button>
                  {allowDelete ? (
                    <button
                      type="button"
                      class="delete-btn ml-6"
                      data-key={item.key}
                    >
                      Delete
                    </button>
                  ) : (
                    <span class="muted ml-6" title="Only the creator or a superadmin can delete this link">
                      No delete
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div
        id="history-more"
        class="history-more"
        hidden={items.length <= HISTORY_PAGE_SIZE}
      >
        <span id="history-more-text">
          Showing {Math.min(HISTORY_PAGE_SIZE, items.length)} of{' '}
          {items.length} links. Extend the list?
        </span>
        <button id="history-show-more" type="button" class="ml-10">
          Show {HISTORY_PAGE_SIZE} more
        </button>
        <button id="history-show-all" type="button" class="ml-6">
          Show all
        </button>
      </div>

      {adminNav({ actor, isSuperadmin })}

      <p id="history-status" class="history-status" />

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
            const moreBox = document.getElementById('history-more');
            const moreText = document.getElementById('history-more-text');
            const showMoreBtn = document.getElementById('history-show-more');
            const showAllBtn = document.getElementById('history-show-all');
            const pageSize = ${HISTORY_PAGE_SIZE};
            let visibleLimit = pageSize;

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
              const filtersActive = !!(text || fromVal || toVal);
              let matched = 0;

              rows.forEach((tr) => {
                const tds = tr.getElementsByTagName('td');
                if (tds.length < 4) return;

                const createdAtText = tds[0].textContent || '';
                const originalText = (tds[2].textContent || '').toLowerCase();
                const shortText = (tds[3].textContent || '').toLowerCase();

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

                const matches = matchesText && matchesDate;
                tr.hidden = !matches || (!filtersActive && matched >= visibleLimit);
                if (matches) matched++;
              });

              if (moreBox) {
                const remaining = matched - visibleLimit;
                moreBox.hidden = filtersActive || remaining <= 0;
                if (moreText && remaining > 0) {
                  moreText.textContent =
                    'Showing ' + visibleLimit + ' of ' + matched + ' links. Extend the list?';
                }
                if (showMoreBtn && remaining > 0) {
                  showMoreBtn.textContent = 'Show ' + Math.min(pageSize, remaining) + ' more';
                }
              }

              queueVisibleChecks();
            }

            if (showMoreBtn) {
              showMoreBtn.addEventListener('click', () => {
                visibleLimit += pageSize;
                applyFilters();
              });
            }
            if (showAllBtn) {
              showAllBtn.addEventListener('click', () => {
                visibleLimit = Number.MAX_SAFE_INTEGER;
                applyFilters();
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

            const rebuildBtn = document.getElementById('history-rebuild-orphans');
            if (rebuildBtn) {
              rebuildBtn.addEventListener('click', async () => {
                if (!confirm('Scan KV for short links missing from History and add them? Date/owner will show as legacy.')) return;
                rebuildBtn.setAttribute('disabled', 'true');
                try {
                  const res = await fetch('/admin/history/rebuild-orphans', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    setStatus((data && data.message) || 'Rebuild failed');
                    return;
                  }
                  setStatus('Added ' + (data.added || 0) + ' missing link(s). Reloading…');
                  window.location.reload();
                } catch (e) {
                  setStatus('Rebuild error');
                } finally {
                  rebuildBtn.removeAttribute('disabled');
                }
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
                if (!confirm('Move this short URL to Trash? You can restore it later.')) return;

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
                  setStatus('Moved to Trash');
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
              dot.classList.toggle('reachable', reachable);
              dot.classList.toggle('unreachable', !reachable);
              dot.title = detail || (
                reachable ? 'Destination reachable' : 'Destination not reachable'
              );
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

            // Check only rows the user can see; newly revealed rows are queued later.
            const checkQueue = [];
            const queuedDots = new Set();
            let activeChecks = 0;

            function pumpChecks() {
              while (activeChecks < 4 && checkQueue.length > 0) {
                const dot = checkQueue.shift();
                activeChecks++;
                checkDestination(dot).finally(() => {
                  activeChecks--;
                  pumpChecks();
                });
              }
            }

            function queueVisibleChecks() {
              document.querySelectorAll('#history-table tbody tr:not([hidden]) .dest-dot')
                .forEach((dot) => {
                  if (queuedDots.has(dot)) return;
                  queuedDots.add(dot);
                  checkQueue.push(dot);
                });
              pumpChecks();
            }

            applyFilters();
          })();
        `
        }}
      />
    </div>
  )
})

app.get('/admin/audit', async (c) => {
  const items = await getAuditEntries(c.env.KV)
  const { actor, isSuperadmin } = await loadAuthz(c)
  return c.render(
    <div>
      <h2>Audit log</h2>
      <p>
        Latest {items.length} create/delete/restore/purge/role events (maximum
        1000).
      </p>
      <table class="history-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Action</th>
            <th>Target</th>
            <th>Detail</th>
            <th>User</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.timestamp}-${item.key}-${index}`}>
              <td>{item.timestamp}</td>
              <td>{item.action}</td>
              <td>{item.key}</td>
              <td>{item.url || 'not available'}</td>
              <td>{item.actor}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {adminNav({ actor, isSuperadmin })}
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
        <div class="status-layout">
          <Semaphore color="red" />
          <div>
            <h2>Destination not reachable</h2>
            <p>
              The original URL does not exist or did not respond. No short link
              was created.
            </p>
            <p class="muted word-break">
              {url}
            </p>
            {detail ? (
              <p class="muted">{detail}</p>
            ) : null}
            <p>
              <a href="/admin/">Back to admin</a>
            </p>
          </div>
        </div>
      )
    }

    const key = await createKey(c.env.KV, url)
    const { actor, isSuperadmin } = await loadAuthz(c)

    const shortenUrl = new URL(`/${key}`, c.req.url)
    const shortUrlStr = shortenUrl.toString()

    await addToHistory(c.env.KV, {
      key,
      url,
      createdAt: new Date().toISOString(),
      createdBy: actor
    })
    await addAuditEntry(c.env.KV, {
      action: 'create',
      key,
      url,
      actor,
      timestamp: new Date().toISOString()
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
        <div class="status-layout">
          <Semaphore color="green" />
          <div>
            <h2>Created!</h2>
            <p class="muted">Short link is active.</p>
          </div>
        </div>

        <div class="short-url-row">
          <input
            id="short-url"
            type="text"
            value={shortUrlStr}
            class="short-url-input"
            readOnly
          />
        </div>

        <div class="mb-20">
          <button id="copy-url-btn" type="button">
            Copy URL
          </button>
          <button
            id="copy-qr-btn"
            type="button"
            class="ml-10"
          >
            Copy QR (PNG)
          </button>
          <span id="copy-status" class="copy-status" />
        </div>

        <div class="mt-10">
          <h3>QR Code:</h3>
          <div
            id="qr-container"
            class="qr-container"
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        </div>

        {adminNav({ actor, isSuperadmin })}

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

app.post(
  '/admin/history/rebuild-orphans',
  rateLimit('rebuild-orphans', 10, 600, 'json'),
  csrfProtect('json'),
  async (c) => {
    try {
      const result = await rebuildOrphanHistory(c.env.KV)
      return c.json({ ok: true, ...result })
    } catch (e) {
      console.error('Error rebuilding orphan history:', e)
      return c.json(
        { ok: false, error: 'rebuild-failed', message: 'Rebuild failed' },
        500
      )
    }
  }
)

// Soft-delete: stop the redirect, remove from History, keep a Trash copy.
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
      const url = await c.env.KV.get(key)
      if (url === null) {
        return c.json(
          { ok: false, error: 'not-found', message: 'Short link not found' },
          404
        )
      }
      const { actor, roles, bootstrap } = await loadAuthz(c)
      const history = await getHistory(c.env.KV)
      const historyItem = history.find((item) => item.key === key) || null
      if (!canManageLink(actor, historyItem?.createdBy, roles, bootstrap)) {
        return c.json(
          {
            ok: false,
            error: 'forbidden',
            message:
              'Only the creator or a superadmin can move this short link to Trash.'
          },
          403
        )
      }
      await removeFromHistory(c.env.KV, key)
      await c.env.KV.delete(key)
      await addToTrash(c.env.KV, {
        key,
        url,
        createdAt: historyItem?.createdAt || null,
        createdBy: historyItem?.createdBy || null,
        deletedAt: new Date().toISOString(),
        deletedBy: actor
      })
      await addAuditEntry(c.env.KV, {
        action: 'delete',
        key,
        url,
        actor,
        timestamp: new Date().toISOString()
      })
      return c.json({ ok: true, trashed: true })
    } catch (e) {
      console.error('Error deleting key from history:', e)
      return c.json(
        { ok: false, error: 'delete-failed', message: 'Delete failed' },
        500
      )
    }
  }
)

app.get('/admin/trash', async (c) => {
  const items = await getTrash(c.env.KV)
  const { actor, roles, bootstrap, isSuperadmin } = await loadAuthz(c)
  return c.render(
    <div>
      <h2>Trash ({items.length})</h2>
      <p>
        Deleted short links stay here until restored or permanently purged.
        Restored links keep the same six-character key when still available.
        Only the original creator or a superadmin can restore or purge.
      </p>
      <table id="trash-table" class="history-table">
        <thead>
          <tr>
            <th>Deleted at</th>
            <th>Deleted by</th>
            <th>Created by</th>
            <th>Original URL</th>
            <th>Short key</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const allowManage = canManageLink(
              actor,
              item.createdBy,
              roles,
              bootstrap
            )
            return (
              <tr key={item.key}>
                <td>{item.deletedAt}</td>
                <td>{item.deletedBy}</td>
                <td>{item.createdBy || 'legacy / unknown'}</td>
                <td class="word-break">{item.url}</td>
                <td>{item.key}</td>
                <td class="actions-cell">
                  {allowManage ? (
                    <span>
                      <button
                        type="button"
                        class="restore-btn"
                        data-key={item.key}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        class="purge-btn ml-6"
                        data-key={item.key}
                      >
                        Delete forever
                      </button>
                    </span>
                  ) : (
                    <span class="muted">No actions</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {adminNav({ actor, isSuperadmin })}
      <p id="trash-status" class="history-status" />
      <script
        nonce={c.get('cspNonce')}
        dangerouslySetInnerHTML={{
          __html: `
          (function () {
            const statusEl = document.getElementById('trash-status');
            function setStatus(msg) {
              if (!statusEl) return;
              statusEl.textContent = msg;
              if (msg) setTimeout(() => { statusEl.textContent = ''; }, 2500);
            }
            async function postAction(path, key) {
              const res = await fetch(path + encodeURIComponent(key), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) {
                setStatus((data && data.message) || 'Action failed');
                return false;
              }
              return true;
            }
            document.querySelectorAll('.restore-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const key = btn.getAttribute('data-key');
                if (!key) return;
                if (!confirm('Restore this short URL?')) return;
                if (!(await postAction('/admin/trash/restore/', key))) return;
                const tr = btn.closest('tr');
                if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
                setStatus('Restored');
              });
            });
            document.querySelectorAll('.purge-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const key = btn.getAttribute('data-key');
                if (!key) return;
                if (!confirm('Permanently delete this short URL? This cannot be undone.')) return;
                if (!(await postAction('/admin/trash/purge/', key))) return;
                const tr = btn.closest('tr');
                if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
                setStatus('Permanently deleted');
              });
            });
          })();
        `
        }}
      />
    </div>
  )
})

app.post(
  '/admin/trash/restore/:key{[0-9a-z]{6}}',
  rateLimit('restore', 100, 600, 'json'),
  csrfProtect('json'),
  async (c) => {
    const key = c.req.param('key')
    try {
      const existing = await c.env.KV.get(key)
      if (existing !== null) {
        return c.json(
          {
            ok: false,
            error: 'key-in-use',
            message: 'That short key is already in use. Purge the trash entry instead.'
          },
          409
        )
      }
      const pending = (await getTrash(c.env.KV)).find((item) => item.key === key)
      if (!pending) {
        return c.json(
          { ok: false, error: 'not-found', message: 'Trash entry not found' },
          404
        )
      }
      const { actor, roles, bootstrap } = await loadAuthz(c)
      if (!canManageLink(actor, pending.createdBy, roles, bootstrap)) {
        return c.json(
          {
            ok: false,
            error: 'forbidden',
            message:
              'Only the creator or a superadmin can restore this short link.'
          },
          403
        )
      }
      const item = await removeFromTrash(c.env.KV, key)
      if (!item) {
        return c.json(
          { ok: false, error: 'not-found', message: 'Trash entry not found' },
          404
        )
      }
      await c.env.KV.put(key, item.url)
      await addToHistory(c.env.KV, {
        key,
        url: item.url,
        createdAt: item.createdAt || new Date().toISOString(),
        createdBy: item.createdBy || actor
      })
      await addAuditEntry(c.env.KV, {
        action: 'restore',
        key,
        url: item.url,
        actor,
        timestamp: new Date().toISOString()
      })
      return c.json({ ok: true })
    } catch (e) {
      console.error('Error restoring key from trash:', e)
      return c.json(
        { ok: false, error: 'restore-failed', message: 'Restore failed' },
        500
      )
    }
  }
)

app.post(
  '/admin/trash/purge/:key{[0-9a-z]{6}}',
  rateLimit('purge', 100, 600, 'json'),
  csrfProtect('json'),
  async (c) => {
    const key = c.req.param('key')
    try {
      const pending = (await getTrash(c.env.KV)).find((item) => item.key === key)
      if (!pending) {
        return c.json(
          { ok: false, error: 'not-found', message: 'Trash entry not found' },
          404
        )
      }
      const { actor, roles, bootstrap } = await loadAuthz(c)
      if (!canManageLink(actor, pending.createdBy, roles, bootstrap)) {
        return c.json(
          {
            ok: false,
            error: 'forbidden',
            message:
              'Only the creator or a superadmin can permanently delete this short link.'
          },
          403
        )
      }
      const item = await removeFromTrash(c.env.KV, key)
      if (!item) {
        return c.json(
          { ok: false, error: 'not-found', message: 'Trash entry not found' },
          404
        )
      }
      await addAuditEntry(c.env.KV, {
        action: 'purge',
        key,
        url: item.url,
        actor,
        timestamp: new Date().toISOString()
      })
      return c.json({ ok: true })
    } catch (e) {
      console.error('Error purging key from trash:', e)
      return c.json(
        { ok: false, error: 'purge-failed', message: 'Permanent delete failed' },
        500
      )
    }
  }
)

app.get('/admin/roles', async (c) => {
  const authz = await loadAuthz(c)
  if (!authz.isSuperadmin) {
    c.status(403)
    return c.render(
      <div class="status-layout">
        <Semaphore color="red" />
        <div>
          <h2>Forbidden</h2>
          <p>Only superadmins can manage superadmin grants.</p>
          {adminNav({ actor: authz.actor, isSuperadmin: false })}
        </div>
      </div>
    )
  }

  const rows = new Map<
    string,
    { email: string; source: 'kv' | 'bootstrap' }
  >()
  for (const email of authz.bootstrap) {
    rows.set(email, { email, source: 'bootstrap' })
  }
  for (const email of Object.keys(authz.roles)) {
    rows.set(email, { email, source: 'kv' })
  }
  const list = [...rows.values()].sort((a, b) => a.email.localeCompare(b.email))

  return c.render(
    <div>
      <h2>Roles</h2>
      <p>
        Everyone who signs in via Cloudflare Access is a <code>user</code> by
        default (including the first visit). Use this page only to grant or
        revoke <code>superadmin</code>. Bootstrap superadmins come from{' '}
        <code>SUPERADMIN_EMAILS</code>.
      </p>

      <form id="role-form" class="history-filters">
        <div class="form-row">
          <input
            id="role-email"
            type="email"
            required
            placeholder="name@iasociety.org"
            class="history-search"
          />
          <button type="submit">Make superadmin</button>
        </div>
      </form>

      <table class="history-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Source</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {list.map((item) => (
            <tr key={item.email}>
              <td>{item.email}</td>
              <td>{item.source === 'kv' ? 'assigned' : 'bootstrap env'}</td>
              <td class="actions-cell">
                {item.source === 'kv' ? (
                  <button
                    type="button"
                    class="role-remove-btn"
                    data-email={item.email}
                  >
                    Remove superadmin
                  </button>
                ) : (
                  <span class="muted">Set via SUPERADMIN_EMAILS</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {adminNav({ actor: authz.actor, isSuperadmin: true })}
      <p id="roles-status" class="history-status" />
      <script
        nonce={c.get('cspNonce')}
        dangerouslySetInnerHTML={{
          __html: `
          (function () {
            const statusEl = document.getElementById('roles-status');
            const form = document.getElementById('role-form');
            const emailInput = document.getElementById('role-email');
            function setStatus(msg) {
              if (!statusEl) return;
              statusEl.textContent = msg;
            }
            if (form && emailInput) {
              form.addEventListener('submit', async function (e) {
                e.preventDefault();
                const email = (emailInput.value || '').trim();
                try {
                  const res = await fetch('/admin/roles', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    setStatus((data && data.message) || 'Save failed');
                    return;
                  }
                  window.location.reload();
                } catch (err) {
                  setStatus('Save error');
                }
              });
            }
            document.querySelectorAll('.role-remove-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const email = btn.getAttribute('data-email');
                if (!email) return;
                if (!confirm('Remove superadmin for ' + email + '? They stay a normal user.')) return;
                try {
                  const res = await fetch('/admin/roles/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    setStatus((data && data.message) || 'Remove failed');
                    return;
                  }
                  window.location.reload();
                } catch (err) {
                  setStatus('Remove error');
                }
              });
            });
          })();
        `
        }}
      />
    </div>
  )
})

app.post(
  '/admin/roles',
  rateLimit('roles', 60, 600, 'json'),
  csrfProtect('json'),
  async (c) => {
    const authz = await loadAuthz(c)
    if (!authz.isSuperadmin) {
      return c.json(
        {
          ok: false,
          error: 'forbidden',
          message: 'Only superadmins can grant superadmin.'
        },
        403
      )
    }
    let body: { email?: unknown; role?: unknown }
    try {
      body = (await c.req.json()) as { email?: unknown; role?: unknown }
    } catch {
      return c.json(
        { ok: false, error: 'invalid-json', message: 'Invalid JSON body' },
        400
      )
    }
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    // Accept legacy { role: 'superadmin' }; reject assigning user (default).
    if (body.role != null && body.role !== 'superadmin') {
      return c.json(
        {
          ok: false,
          error: 'invalid-input',
          message:
            'Users are assigned automatically on Access login. Only superadmin grants are stored.'
        },
        400
      )
    }
    if (!EMAIL_RE.test(email)) {
      return c.json(
        {
          ok: false,
          error: 'invalid-input',
          message: 'Provide a valid email to grant superadmin.'
        },
        400
      )
    }

    const next: RolesMap = { ...authz.roles, [email]: 'superadmin' }
    await putRolesMap(c.env.KV, next)
    await addAuditEntry(c.env.KV, {
      action: 'role-set',
      key: email,
      url: 'superadmin',
      actor: authz.actor,
      timestamp: new Date().toISOString()
    })
    return c.json({ ok: true, email, role: 'superadmin' })
  }
)

app.post(
  '/admin/roles/remove',
  rateLimit('roles-remove', 60, 600, 'json'),
  csrfProtect('json'),
  async (c) => {
    const authz = await loadAuthz(c)
    if (!authz.isSuperadmin) {
      return c.json(
        {
          ok: false,
          error: 'forbidden',
          message: 'Only superadmins can revoke superadmin.'
        },
        403
      )
    }
    let body: { email?: unknown }
    try {
      body = (await c.req.json()) as { email?: unknown }
    } catch {
      return c.json(
        { ok: false, error: 'invalid-json', message: 'Invalid JSON body' },
        400
      )
    }
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(email) || !authz.roles[email]) {
      return c.json(
        {
          ok: false,
          error: 'not-found',
          message: 'No superadmin grant found for that email.'
        },
        404
      )
    }

    const next: RolesMap = { ...authz.roles }
    delete next[email]
    const remaining = listEffectiveSuperadmins(next, authz.bootstrap)
    if (remaining.length === 0) {
      return c.json(
        {
          ok: false,
          error: 'last-superadmin',
          message: 'Cannot remove the last superadmin.'
        },
        400
      )
    }

    await putRolesMap(c.env.KV, next)
    await addAuditEntry(c.env.KV, {
      action: 'role-set',
      key: email,
      url: 'user',
      actor: authz.actor,
      timestamp: new Date().toISOString()
    })
    return c.json({ ok: true, email, role: 'user' })
  }
)

// A catch-all route instead of app.notFound(): the Pages build entry registers
// `app.notFoundHandler`, which Hono 4 no longer exposes, so unmatched paths
// would otherwise crash with a 500.
app.all('*', (c) => {
  if (new URL(c.req.url).pathname.startsWith('/admin')) {
    c.status(404)
    return c.render(
      <div class="status-layout">
        <Semaphore color="red" />
        <div>
          <h2>Page not found</h2>
          <p>This admin page does not exist.</p>
          <p>
            <a href="/admin/">Back to admin</a>
          </p>
        </div>
      </div>
    )
  }
  return standaloneStatusPage({
    title: 'Page not found',
    heading: 'Page not found',
    message: 'This page does not exist.',
    color: 'red',
    status: 404,
    nonce: c.get('cspNonce')
  })
})

// Clearer global errors (no silent redirect to iasociety.org)
app.onError(async (err, c) => {
  console.error('Unhandled error:', err)
  const path = new URL(c.req.url).pathname
  const isAdmin = path.startsWith('/admin')
  const message = err instanceof Error ? err.message : 'Unknown error'
  const alertPromise = notifyErrorAlert(c.env.ALERT_WEBHOOK_URL, {
    path,
    message,
    stack: err instanceof Error ? err.stack : undefined
  })
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(alertPromise)
  } else {
    void alertPromise
  }

  if (isAdmin) {
    return c.render(
      <div class="status-layout">
        <Semaphore color="red" />
        <div>
          <h2>Something went wrong</h2>
          <p>An unexpected error occurred while processing your request.</p>
          <p class="muted">{message}</p>
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
