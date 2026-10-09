# IAS URL Shortener

Internal URL-shortening service for IAS, deployed on Cloudflare and available at
[toias.link](https://toias.link).

The administration interface is protected by Cloudflare Access with Microsoft
Entra ID. Short URLs are intentionally public so recipients can follow them
without authenticating.

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Architecture](#architecture)
- [Access model](#access-model)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Data model](#data-model)
- [Security](#security)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [License and attribution](#license-and-attribution)

## How it works

1. An authorized user opens `https://toias.link/admin/`.
2. Cloudflare Access authenticates the user through Microsoft Entra ID.
3. The user submits an HTTP or HTTPS destination.
4. The Worker verifies that the destination is reachable and safe to probe.
5. A random six-character key is stored in Cloudflare KV.
6. `https://toias.link/<key>` redirects publicly to the stored destination.

Example:

```text
https://toias.link/002b15
```

Existing six-character links remain valid indefinitely unless an administrator
deletes them. The application does not apply a TTL or automatic expiration to
links or History.

## Features

- Six-character short URLs
- Cloudflare KV persistence
- Destination reachability validation before creation
- QR generation without third-party QR services
- History with search and date filters
- Destination health indicator in History
- Persistent create/delete audit log
- Copy URL and QR actions
- Explicit error states and missing-link countdown redirect
- Weekly Dependabot update checks

## Architecture

```text
Browser
  |
  +-- /admin/* ----------------> Cloudflare Access (Entra ID)
  |                                  |
  |                                  v
  |                            Hono application
  |                                  |
  |                                  v
  |                            Cloudflare KV
  |
  +-- /<six-character-key> ----> Public Worker route ----> Destination
```

Main components:

| Component | Purpose |
| --- | --- |
| Hono | HTTP routing and JSX rendering |
| Zod / Hono Zod Validator | Form validation |
| QRCode | Local SVG/PNG QR generation |
| Vite | Production build and local development |
| Wrangler | Cloudflare local preview and manual deployment |
| Cloudflare KV | Links, History, audit events, and rate-limit counters |
| Cloudflare Access | Entra ID authentication for administration |

The application is implemented primarily in `src/index.tsx`. Shared page markup
is in `src/renderer.tsx`, and all styling is local in `src/style.css`.

## Access model

The Cloudflare Zero Trust configuration is external to this repository.

Expected policies:

| Path | Access |
| --- | --- |
| `/admin/*` | Entra ID authentication; IAS-authorized users only |
| `/<six-character-key>` | Public bypass |

The root path redirects to `/admin/`.

`workers.dev` and Cloudflare version-preview URLs are disabled in
`wrangler.toml`. This prevents alternate Worker hostnames from bypassing the
Access policy attached to `toias.link`.

When changing Cloudflare routes or Access applications, verify both:

```bash
curl -I https://toias.link/admin/
curl -I https://toias.link/zzzzzz
```

The first request should redirect to Cloudflare Access when unauthenticated.
The second should return the application's missing-link page.

## Local development

### Requirements

- Node.js 22.12 or newer
- npm
- A network connection for destination checks and Cloudflare tooling

### Install

```bash
git clone https://github.com/DPOGH/url-shortener.git
cd url-shortener
npm ci
```

`package-lock.json` is committed and should remain committed so local and
Cloudflare builds resolve the same dependency versions.

### Development server

For quick UI development:

```bash
npm run dev
```

Open `http://localhost:5173`.

For a Worker-compatible preview with a local KV emulator:

```bash
npm run build
npm run preview
```

Wrangler normally listens on `http://localhost:8788`.

Local KV data is separate from production KV data.

### Validation commands

Run these before opening a pull request:

```bash
npm ci
npm run build
npm audit --audit-level=low
```

There is currently no standalone automated test suite. Cloudflare Workers
Builds performs the required pull-request build check.

## Configuration

Cloudflare configuration lives in `wrangler.toml`.

Required binding:

| Binding | Type | Purpose |
| --- | --- | --- |
| `KV` | KV namespace | Link and application data |

Important settings:

```toml
workers_dev = false
preview_urls = false
```

Do not commit Cloudflare API tokens, Access credentials, local `.dev.vars`, or
other secrets. `.dev.vars` is ignored by Git.

Cloudflare Access policies, Entra ID configuration, the custom domain, and the
GitHub integration are managed in the Cloudflare dashboard.

## Deployment

Production deployment is connected to GitHub through Cloudflare Workers Builds.

Normal workflow:

1. Create a branch.
2. Open a pull request into `main`.
3. Wait for `Workers Builds: url-shortener` to pass.
4. Review and merge the pull request.
5. Cloudflare builds and deploys `main` automatically.
6. Verify `toias.link`.

Do not merge when the Cloudflare build check fails.

Manual deployment is available only for an authenticated operator:

```bash
npm run deploy
```

This requires a Cloudflare login or a suitable `CLOUDFLARE_API_TOKEN`. The
GitHub-connected deployment is the preferred production path.

## Data model

The service uses one KV namespace.

| Key | Value |
| --- | --- |
| `<six-character-key>` | Destination URL |
| `__history__` | Latest 500 active/history records |
| `__audit__` | Latest 1000 create/delete audit events |
| `__rate__:*` | Temporary rate-limit counters |

History records include:

- short key;
- destination URL;
- creation timestamp;
- authenticated creator, when available.

Records created before identity logging display `legacy / unknown`.

Audit records include:

- action (`create` or `delete`);
- short key;
- original URL, when available;
- authenticated user;
- timestamp.

Audit events are also written as structured Worker logs. Audit and History have
count limits but no time-based expiration.

Cloudflare KV is eventually consistent. The History and audit arrays use
read-modify-write operations, so exceptionally concurrent writes can overwrite
one another. The short-link records themselves are stored independently.

## Security

### Authentication and exposure

- Cloudflare Access protects `/admin/*`.
- Microsoft Entra ID is the identity provider.
- Public short-link redirects do not require authentication.
- Alternate `workers.dev` and preview hostnames are disabled.

### Input and redirect controls

- Only `http:` and `https:` destinations are accepted.
- New links are created only when the destination check succeeds.
- Stored non-HTTP(S) values are never redirected.
- Delete routes accept only six-character short keys.

### SSRF protection

Destination checks:

- reject URL credentials;
- reject private, loopback, link-local, reserved, mapped, and non-public IPs;
- validate both IPv4 and IPv6;
- resolve DNS through Cloudflare DNS-over-HTTPS;
- fail closed when DNS validation fails;
- validate every redirect target;
- follow at most five redirects;
- enforce a five-second total timeout;
- avoid consuming response bodies.

### Request controls

- Create: 30 requests per 10 minutes
- Destination check: 300 requests per minute
- Delete: 100 requests per 10 minutes

The limiter uses the Access identity when available, otherwise the
Cloudflare-provided connecting IP. Counters are stored temporarily in KV.
Public redirects are not rate limited.

### Browser controls

Responses include:

- nonce-based Content Security Policy;
- no `unsafe-inline` for scripts or styles;
- HSTS;
- anti-clickjacking controls;
- MIME sniffing protection;
- Referrer Policy;
- Permissions Policy;
- cross-origin isolation headers.

Scripts and styles are local. The application does not load UI or QR resources
from third-party CDNs.

### CSRF

Unsafe administration requests must originate from the same site. Rejected
HTML and JSON requests return explicit CSRF errors.

### Reporting security issues

Do not publish credentials, sensitive destinations, or exploit details in a
public issue. Report security concerns through the IAS internal IT/security
channel and include:

- affected URL or route;
- reproduction steps;
- expected and observed behavior;
- relevant timestamps;
- sanitized logs or screenshots.

## Operations

### History

Open:

```text
https://toias.link/admin/history
```

The indicator beside an original URL is:

- yellow while checking;
- green when the destination responds;
- red when it is missing, blocked, or unreachable.

Some destinations intentionally block automated requests and can therefore
produce a false red result.

### Audit log

Open:

```text
https://toias.link/admin/audit
```

Use the audit log to identify who created or deleted a link. Cloudflare Worker
logs contain the same events under `event: short-link-audit`.

### Dependency updates

Dependabot checks npm dependencies every Monday at 09:00 Europe/Rome.

- production minor/patch updates are grouped;
- development minor/patch updates are grouped;
- major updates are separate;
- `DPOGH` is requested as reviewer;
- updates are never merged automatically.

After reviewing an update, merge it only when the Cloudflare build succeeds.

## Troubleshooting

### Admin opens without a login prompt

Check the Cloudflare Access application and policy for `toias.link/admin*`.
Also confirm `workers_dev = false` and `preview_urls = false`.

### A valid destination is rejected

The site may reject `HEAD`, range requests, automated clients, or Cloudflare
egress. Check Worker logs for `Destination probe failed` and test the
destination independently.

### History shows a red destination

Open the destination directly. A red result means the server-side check failed;
it does not automatically delete an existing short link.

### Create or delete returns HTTP 429

The relevant rate limit was reached. Respect the `Retry-After` response header
before retrying.

### Local Create fails

Use `npm run preview`, not only the Vite development server, so the local KV
binding is available.

### Cloudflare deployment fails

Open the `Workers Builds: url-shortener` check from the pull request and inspect
the Cloudflare build log. Reproduce locally with:

```bash
npm ci
npm run build
npx wrangler deploy --dry-run
```

## License and attribution

Licensed under the [MIT License](LICENSE).

Originally based on Yusuke Wada's
[Hono URL Shortener tutorial](https://github.com/yusukebe/url-shortener).
