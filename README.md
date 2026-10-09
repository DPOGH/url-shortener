# IAS URL Shortener

Internal URL-shortening service for IAS, deployed on Cloudflare at
[toias.link](https://toias.link).

The administration area is protected by Cloudflare Access and Microsoft Entra
ID. Short URLs remain public so recipients can open them without signing in.

## Features

- Six-character short URLs stored in Cloudflare KV
- Destination validation before link creation
- SSRF-safe reachability checks
- Local QR code generation with no third-party service
- Searchable History with destination status indicators
- Create/delete audit log with authenticated user identity
- Strict security headers, CSRF protection, and rate limiting
- No automatic expiration for links or History

## Stack

| Component | Purpose |
| --- | --- |
| Hono | Routing and server-rendered JSX |
| Zod | Input validation |
| Vite | Development and production builds |
| Cloudflare Workers | Application runtime |
| Cloudflare KV | Links, History, audit events, and rate limits |
| Cloudflare Access | Entra ID authentication for `/admin/*` |

The main application is in `src/index.tsx`, the shared renderer in
`src/renderer.tsx`, and local styles in `src/style.css`.

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/admin/` | Authenticated | Create a short link |
| `/admin/history` | Authenticated | Review and delete links |
| `/admin/audit` | Authenticated | Review create/delete events |
| `/<six-character-key>` | Public | Redirect to the destination |

Missing links display an error page and redirect to
`https://www.iasociety.org` after ten seconds.

Cloudflare Access policies are managed outside this repository. The intended
policy is authenticated access to `/admin/*` and public bypass for short-link
routes.

## Local development

Requirements:

- Node.js 22.12 or newer
- npm

Install and start:

```bash
git clone https://github.com/DPOGH/url-shortener.git
cd url-shortener
npm ci
npm run dev
```

For a Worker-compatible preview with local KV:

```bash
npm run build
npm run preview
```

Local KV data is separate from production data.

Before submitting changes:

```bash
npm ci
npm run build
npm audit --audit-level=low
npx wrangler deploy --dry-run
```

## Configuration

Cloudflare configuration is stored in `wrangler.toml`. The application requires
a KV namespace bound as `KV`.

```toml
workers_dev = false
preview_urls = false
```

These settings prevent alternate Cloudflare hostnames from bypassing the Access
policy on `toias.link`.

Never commit API tokens, Access credentials, or `.dev.vars`.

## Deployment

Production is connected to GitHub through Cloudflare Workers Builds:

1. Open a pull request into `main`.
2. Wait for `Workers Builds: url-shortener` to pass.
3. Review and merge the pull request.
4. Cloudflare automatically builds and deploys `main`.
5. Verify the result on `toias.link`.

An authenticated operator can deploy manually with:

```bash
npm run deploy
```

The GitHub-connected workflow is preferred.

## Storage

| KV key | Content |
| --- | --- |
| `<six-character-key>` | Destination URL |
| `__history__` | Latest 5000 History records (page shows 100 at a time) |
| `__audit__` | Latest 1000 create/delete events |
| `__rate__:*` | Temporary rate-limit counters |

History and audit lists have count limits but no time-based expiration.
Cloudflare KV is eventually consistent.

## Security

- Cloudflare Access protects all administration routes.
- Only HTTP and HTTPS destinations are accepted.
- DNS and every redirect target are checked before probing.
- Private, loopback, link-local, reserved, and non-public IPs are blocked.
- Destination checks have a five-second timeout and five-redirect limit.
- Create, check, and delete actions are rate limited through KV.
- Unsafe requests require same-site Origin and Fetch Metadata headers.
- CSP uses per-request nonces without `unsafe-inline`.
- HSTS, anti-clickjacking, MIME, referrer, permission, and cross-origin headers
  are enabled.
- UI assets and QR generation do not depend on third-party CDNs.
- `workers.dev` and version-preview hostnames are disabled.

Do not disclose sensitive URLs or exploit details in public issues. Report
security concerns through the IAS internal IT/security channel.

## Maintenance

Dependabot checks npm dependencies weekly, requests review from `DPOGH`, and
does not merge updates automatically.

Use:

- `/admin/history` to inspect destinations and remove links;
- `/admin/audit` to identify who created or deleted a link;
- Cloudflare Worker logs for runtime errors and structured audit events.

## License

Licensed under the [MIT License](LICENSE).

Originally based on Yusuke Wada's
[Hono URL Shortener tutorial](https://github.com/yusukebe/url-shortener).
