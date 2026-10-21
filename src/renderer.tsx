import { jsxRenderer } from 'hono/jsx-renderer'
import styles from './style.css?raw'
import { brandConfig, type BrandBindings } from './brand'

type RendererEnv = {
  Bindings: BrandBindings
  Variables: {
    cspNonce: string
  }
}

export const renderer = jsxRenderer<RendererEnv>(({ children, title }, c) => {
  const brand = brandConfig(c.env)
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/assets/brand-icon.svg" type="image/svg+xml" />
        <style nonce={c.get('cspNonce')}>{styles}</style>
        <title>{title}</title>
      </head>
      <body>
        <header>
          <a class="brand" href="/admin/" aria-label={brand.ariaLabel}>
            {brand.mark === 'image' ? (
              <span class="brand-logo brand-logo-image">
                <img
                  src="/assets/brand-logo.svg"
                  alt={brand.alt}
                  width="155"
                  height="57"
                />
              </span>
            ) : (
              <span class="brand-logo brand-logo-badge" aria-hidden="true">
                LOGO
              </span>
            )}
            <span class="brand-title">URL Shortener</span>
          </a>
        </header>
        <div>{children}</div>
        {new URL(c.req.url).pathname.startsWith('/admin') ? (
          <footer class="build-version">{brand.buildVersion}</footer>
        ) : null}
      </body>
    </html>
  )
})
