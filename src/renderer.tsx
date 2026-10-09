import { jsxRenderer } from 'hono/jsx-renderer'
import styles from './style.css?raw'

export const renderer = jsxRenderer(({ children, title }) => {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{styles}</style>
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
