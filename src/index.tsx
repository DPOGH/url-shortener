
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { renderer } from './renderer'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import QRCode from 'qrcode'

type Bindings = {
  KV: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

// Applica renderer JSX
app.all('*', renderer)

// Redirect per URL accorciato
app.get('/:key{[0-9a-z]{6}}', async (c) => {
  const key = c.req.param('key')
  const url = await c.env.KV.get(key)
  if (!url) return c.redirect('/')
  return c.redirect(url)
})

// Home page con form

app.get('/', (c) => {
  return c.render(
    <div>
      <h2>Create shortened URL!</h2>
      <form action="/create"
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

const schema = z.object({ url: z.string().url() })

const validator = zValidator('form', schema, (result, c) => {
  if (!result.success) {
    return c.render(
      <div>
        <h2>Error!</h2>
        /Back to top</a>
      </div>
    )
  }
})

// Funzione per creare chiave unica
const createKey = async (kv: KVNamespace, url: string): Promise<string> => {
  const uuid = crypto.randomUUID()
  const key = uuid.substring(0, 6)
  const exists = await kv.get(key)
  if (!exists) {
    await kv.put(key, url)
    return key
  }
  return createKey(kv, url)
}

// Handler per creare URL + QR PNG + bottoni
app.post('/create', csrf(), validator, async (c) => {
  try {
    const { url } = c.req.valid('form')
    const key = await createKey(c.env.KV, url)
    const shortenUrl = new URL(`/${key}`, c.req.url)
    const shortUrlStr = shortenUrl.toString()

    // Genera QR code come PNG (base64)
    const qrPngDataUrl = await QRCode.toDataURL(shortUrlStr, {
      type: 'image/png',
      margin: 1,
      scale: 6 // alta risoluzione
    })

    return c.render(
      <div>
        <h2>Created!</h2>

        {/* Campo URL */}
        <div style={{ marginBottom: '10px' }}>
          <input
            id="short-url"
            type="text"
            value={shortUrlStr}
            style={{ width: '80%' }}
            readOnly
          />
        </div>

        {/* Bottoni */}
        <div style={{ marginBottom: '20px' }}>
          <button id="copy-btn" type="button">Copy URL</button>
          <button
            id="download-btn"
