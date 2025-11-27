
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { renderer } from './renderer'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import QRCode from 'qrcode' // ✅ Import libreria QR

type Bindings = {
  KV: KVNamespace
}

const app = new Hono<{
  Bindings: Bindings
}>()

app.all('*', renderer)

// ✅ Redirect per URL accorciato
app.get('/:key{[0-9a-z]{6}}', async (c) => {
  const key = c.req.param('key')
  const url = await c.env.KV.get(key)

  if (url === null) {
    return c.redirect('/')
  }

  return c.redirect(url)
})

// ✅ Pagina iniziale con form corretto
app.get('/', (c) => {
  return c.render(
    <div>
      <h2>Create shorten URL!</h2>
      /create
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
        /Back to top</a>
      </div>
    )
  }
})

// ✅ Funzione per creare chiave unica
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

// ✅ Handler per creare URL + QR code
app.post('/create', csrf(), validator, async (c) => {
  const { url } = c.req.valid('form')
  const key = await createKey(c.env.KV, url)

  const shortenUrl = new URL(`/${key}`, c.req.url)

  // Genera QR code come Data URL
  const qrCodeDataUrl = await QRCode.toDataURL(shortenUrl.toString())

  return c.render(
    <div>
      <h2>Created!</h2>
      <input
        type="text"
        value={shortenUrl.toString()}
        style={{ width: '80%' }}
        autoFocus
      />
      <div style={{ marginTop: '20px' }}>
        <h3>QR Code:</h3>
        <img src={qrCodeDataUrl} alt="QR Code" />
      </div>
      <div style={{ marginTop: '10px' }}>
        /Back to Home</a>
      </div>
    </div>
  )
})

export default app
