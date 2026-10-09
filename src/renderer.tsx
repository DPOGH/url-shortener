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
          <h1>
            <a href="/">URL Shortener</a>
          </h1>
        </header>
        <div>{children}</div>
      </body>
    </html>
  )
})
