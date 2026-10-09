import { jsxRenderer } from 'hono/jsx-renderer'
import styles from './style.css?raw'

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
        <style nonce={c.get('cspNonce')}>{styles}</style>
        <title>{title}</title>
      </head>
      <body>
        <header>
          <a class="brand" href="/admin/" aria-label="IAS URL Shortener home">
            <span class="brand-logo">
              <img
                src="/assets/ias-logo.svg"
                alt="International AIDS Society"
                width="155"
                height="57"
              />
            </span>
            <span class="brand-title">URL Shortener</span>
          </a>
        </header>
        <div>{children}</div>
      </body>
    </html>
  )
})
