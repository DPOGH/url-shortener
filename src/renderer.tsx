import { jsxRenderer } from 'hono/jsx-renderer'
import styles from './style.css?raw'
import { BUILD_VERSION } from './version'

type RendererEnv = {
  Variables: {
    cspNonce: string
  }
}

export const renderer = jsxRenderer<RendererEnv>(({ children, title }, c) => {
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
          <a class="brand" href="/admin/" aria-label="URL Shortener home">
            <span class="brand-logo" aria-hidden="true">
              LOGO
            </span>
            <span class="brand-title">URL Shortener</span>
          </a>
        </header>
        <div>{children}</div>
        {new URL(c.req.url).pathname.startsWith('/admin') ? (
          <footer class="build-version">{BUILD_VERSION}</footer>
        ) : null}
      </body>
    </html>
  )
})
