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

// Remove single entry from history array
const removeFromHistory = async (kv: KVNamespace, keyToRemove: string) => {
  const json = await kv.get(HISTORY_KEY)
  if (!json) return
  let list: HistoryItem[]
  try {
    list = JSON.parse(json) as HistoryItem[]
  } catch {
    return
  }
  const filtered = list.filter((item) => item.key !== keyToRemove)
  await kv.put(HISTORY_KEY, JSON.stringify(filtered))
}

// History page with filters
app.get('/history', async (c) => {
  const items = await getHistory(c.env.KV)

  return c.render(
    <div>
      <h2>History (latest {items.length} entries)</h2>
      <p>Showing up to 500 latest shortened URLs.</p>

      {/* Filters: text + date range */}
      <div style={{ marginBottom: '10px', fontSize: '0.85em' }}>
        <label>
          Search (URL / short URL):{' '}
          <input
            id="history-search"
            type="text"
            placeholder="Filter by URL..."
            style={{ width: '40%' }}
          />
        </label>
        <span style={{ marginLeft: '15px' }}>
          <label>
            From:{' '}
            <input
              id="history-from"
              type="date"
            />
          </label>
        </span>
        <span style={{ marginLeft: '10px' }}>
          <label>
            To:{' '}
            <input
              id="history-to"
              type="date"
            />
          </label>
        </span>
        <button
          id="history-clear-filters"
          type="button"
          style={{ marginLeft: '10px' }}
        >
          Clear filters
        </button>
      </div>

      <table
        id="history-table"
        style={{
          fontSize: '0.8em',
          borderCollapse: 'collapse',
          width: '100%'
        }}
      >
        <thead>
          <tr>
            <th style={{ borderBottom: '1px solid #ccc', padding: '4px' }}>
              Created at
            </th>
            <th style={{ borderBottom: '1px solid #ccc', padding: '4px' }}>
              Original URL
            </th>
            <th style={{ borderBottom: '1px solid #ccc', padding: '4px' }}>
              Short URL
            </th>
            <th style={{ borderBottom: '1px solid #ccc', padding: '4px' }}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const shortUrl = new URL(`/${item.key}`, c.req.url).toString()
            return (
              <tr key={item.key}>
                <td
                  class="created-at-cell"
                  style={{ padding: '4px', verticalAlign: 'top' }}
                >
