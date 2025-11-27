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

// Apply JSX renderer to all routes
app.all('*', renderer)

// Redirect for shortened URL
app.get('/:key{[0-9a-z]{6}}', async (c) => {
  const key = c.req.param('key')
  const url = await c.env.KV.get(key)

  if (url === null) {
    return c.redirect('/')
  }

  return c.redirect(url)
})

// Home page with form
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

      <p style={{ marginTop: '10px' }}>
        <a href="/history">View history</a>
      </p>
    </div>
  )
})

const schema = z.object({
  url: z.string().url()
})

// Zod validator with simple error page
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

// History support in KV (max 500 items)
type HistoryItem = {
  key: string
  url: string
  createdAt: string
}

const HISTORY_KEY = '__history__'

const addToHistory = async (kv: KVNamespace, item: HistoryItem) => {
  const json = await kv.get(HISTORY_KEY)
  let list: HistoryItem[] = []
  if (json) {
    try {
      list = JSON.parse(json) as HistoryItem[]
    } catch {
      list = []
    }
  }
  list.unshift(item)
  if (list.length > 500) {
    list = list.slice(0, 500)
  }
  await kv.put(HISTORY_KEY, JSON.stringify(list))
}

const getHistory = async (kv: KVNamespace): Promise<HistoryItem[]> => {
  const json = await kv.get(HISTORY_KEY)
  if (!json) return []
  try {
    return JSON.parse(json) as HistoryItem[]
  } catch {
    return []
  }
}

// History page
app.get('/history', async (c) => {
  const items = await getHistory(c.env.KV)

  return c.render(
    <div>
      <h2>History (latest {items.length} entries)</h2>
      <p>Showing up to 500 latest shortened URLs.</p>
      <table>
        <thead>
          <tr>
            <th>Created at</th>
            <th>Original URL</th>
            <th>Short URL</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const shortUrl = new URL(`/${item.key}`, c.req.url).toString()
            return (
              <tr>
                <td>{item.createdAt}</td>
                <td>
                  <a href={item.url}>{item.url}</a>
                </td>
                <td>
                  <a href={shortUrl}>{shortUrl}</a>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p style={{ marginTop: '10px' }}>
        <a href="/">Back to Home</a>
      </p>
    </div>
  )
})

// Generate unique key and store URL in KV
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

// Create shortened URL + QR (SVG 200px) + copy & PNG buttons
app.post('/create', csrf(), validator, async (c) => {
  try {
    const { url } = c.req.valid('form')
    const key = await createKey(c.env.KV, url)

    const shortenUrl = new URL(`/${key}`, c.req.url)
    const shortUrlStr = shortenUrl.toString()

    await addToHistory(c.env.KV, {
      key,
      url,
      createdAt: new Date().toISOString()
    })

    // Generate QR code as SVG
    const qrSvgRaw = await QRCode.toString(shortUrlStr, {
      type: 'svg',
      margin: 0
    })

    // Force 200x200 size on <svg>
    const qrSvg = qrSvgRaw.replace(
      '<svg',
