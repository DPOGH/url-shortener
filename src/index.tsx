import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { renderer } from './renderer'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import QRCode from 'qrcode'

type Bindings = {
  KV: KVNamespace
}

const app = new Hono<{
  Bindings: Bindings
}>()

app.all('*', renderer)

// Redirect per URL accorciato
app.get('/:key{[0-9a-z]{6}}', async (c) => {
  const key = c.req.param('key')
  const url = await c.env.KV.get(key)

  if (url === null) {
    return c.redirect('/')
  }

  return c.redirect(url)
})

// Home page con form
app.get('/', (c) => {
  return c.render(
    <div>
      <h2>Create shortened URL!</h2>
      <form action="/create" method="post">
        <input
          type="text"
          name="url"
          autoComplete="off"
          style={{ width: '80%' }}
        />
        &nbsp;
        <button type="submit">Create</button>
      </form>
    </div>
  )
})

const schema = z.object({
  url: z.string().url()
})

const validator = zValidator('form', schema, (result, c) => {
  if (!result.success) {
    return c.render(
      <div>
        <h2>Error!</h2>
        <a href="/">Back to top</a>
      </div>
    )
  }
})

// Funzione per creare chiave unica
const createKey = async (kv: KVNamespace, url: string): Promise<string> => {
  const uuid = crypto.randomUUID()
  const key = uuid.substring(0, 6)
  const result = await kv.get(key)
  if (!result) {
    await kv.put(key, url)
  } else {
    return await createKey(kv, url)
  }
  return key
}

// Handler per creare URL + QR (SVG)
app.post('/create', csrf(), validator, async (c) => {
  try {
    const { url } = c.req.valid('form')
    const key = await createKey(c.env.KV, url)

    const shortenUrl = new URL(`/${key}`, c.req.url)
    const shortUrlStr = shortenUrl.toString()

    // QR SVG con dimensione più piccola
    const qrSvgRaw = await QRCode.toString(shortUrlStr, {
      type: 'svg',
      margin: 0
    })

    // Wrappo lo SVG in un container con width/height controllate via CSS inline
    const qrSvg = qrSvgRaw.replace(
      '<svg',
      '<svg width="120" height="120"'
    )

    return c.render(
      <div>
        <h2>Created!</h2>

        <div style={{ marginBottom: '10px' }}>
          <input
            id="short-url"
            type="text"
            value={shortUrlStr}
            style={{ width: '80%' }}
            readOnly
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shortUrlStr)
                alert('URL copied!')
              } catch (e) {
                alert('Cannot copy, please copy manually.')
              }
            }}
          >
            Copy URL
          </button>
        </div>

        <div style={{ marginTop: '10px' }}>
          <h3>QR Code:</h3>
          <div
            style={{ width: '120px', height: '120px' }}
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        </div>

        <div style={{ marginTop: '10px' }}>
          <a href="/">Back to Home</a>
        </div>
      </div>
    )
  } catch (e) {
    console.error('Error in /create handler:', e)
    return c.text('Internal error while creating QR', 500)
  }
})


export default app
