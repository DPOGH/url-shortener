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

// Pagina iniziale con form corretto
app.get('/', (c) => {
  return c.render(
    <div>
      <h2>Create shorten URL!</h2>
      <form action="/create" method="post">
        <input
          type="text"
          name="url"
          autoComplete="off"
          placeholder="https://example.com"
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
        <p>Invalid URL format</p>
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
    return key
  } else {
    return await createKey(kv, url)
  }
}

// Handler per creare URL + QR code
app.post('/create', csrf(), validator, async (c) => {
  try {
    const { url } = c.req.valid('form')
    console.log('URL input:', url)

    const key = await createKey(c.env.KV, url)
    console.log('Generated key:', key)

    const shortenUrl = new URL(`/${key}`, c.req.url)
    console.log('Shorten URL:', shortenUrl.toString())

    const qrCodeDataUrl = await QRCode.toDataURL(shortenUrl.toString())
    console.log('QR generated, length:', qrCodeDataUrl.length)

    return c.render(
      <div>
        <h2>Created!</h2>
        <input
          type="text"
          value={shortenUrl.toString()}
          style={{ width: '80%' }}
          readOnly
        />
        <div style={{ marginTop: '20px' }}>
          <h3>QR Code:</h3>
          <img src={qrCodeDataUrl} alt="QR Code" />
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
