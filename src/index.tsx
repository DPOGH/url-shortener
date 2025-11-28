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

// History page
app.get('/history', async (c) => {
  const items = await getHistory(c.env.KV)

  return c.render(
    <div>
      <h2>History (latest {items.length} entries)</h2>
      <p>Showing up to 500 latest shortened URLs.</p>

      <table
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
                <td style={{ padding: '4px', verticalAlign: 'top' }}>
                  {item.createdAt}
                </td>
                <td style={{ padding: '4px', verticalAlign: 'top' }}>
                  <a href={item.url}>{item.url}</a>
                </td>
                <td style={{ padding: '4px', verticalAlign: 'top' }}>
                  <a href={shortUrl}>{shortUrl}</a>
                </td>
                <td
                  style={{
                    padding: '4px',
                    verticalAlign: 'top',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <button
                    type="button"
                    class="delete-btn"
                    data-key={item.key}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    class="qr-open-btn"
                    data-url={shortUrl}
                    style={{ marginLeft: '6px' }}
                  >
                    QR → new tab
                  </button>
                  <button
                    type="button"
                    class="qr-copy-btn"
                    data-url={shortUrl}
                    style={{ marginLeft: '6px' }}
                  >
                    Copy QR
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <p style={{ marginTop: '10px' }}>
        <a href="/">Back to Home</a>
      </p>

      <p
        id="history-status"
        style={{ marginTop: '8px', fontSize: '0.8em', color: '#333' }}
      />

      {/* Client-side script for delete and QR actions in history */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
          (function () {
            const statusEl = document.getElementById('history-status');

            function setStatus(msg) {
              if (!statusEl) return;
              statusEl.textContent = msg;
              if (msg) {
                setTimeout(() => { statusEl.textContent = ''; }, 2000);
              }
            }

            // Delete single row (KV key + history)
            document.querySelectorAll('.delete-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const key = btn.getAttribute('data-key');
                if (!key) return;
                if (!confirm('Delete this short URL?')) return;

                try {
                  const res = await fetch('/history/delete/' + encodeURIComponent(key), {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    }
                  });
                  if (!res.ok) {
                    setStatus('Delete failed');
                    return;
                  }
                  const tr = btn.closest('tr');
                  if (tr && tr.parentNode) {
                    tr.parentNode.removeChild(tr);
                  }
                  setStatus('Deleted');
                } catch (e) {
                  setStatus('Delete error');
                }
              });
            });

            // Generate QR PNG blob for a given URL using external QR API
            async function generateQrPngBlob(url) {
              const apiUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(url);
              const resp = await fetch(apiUrl);
              if (!resp.ok) throw new Error('QR fetch failed');
              return await resp.blob();
            }

            function downloadBlob(blob, filename) {
              const blobUrl = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = blobUrl;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(blobUrl);
            }

            // Open QR in a new tab
            document.querySelectorAll('.qr-open-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const url = btn.getAttribute('data-url');
                if (!url) return;
                try {
                  const blob = await generateQrPngBlob(url);
                  const blobUrl = URL.createObjectURL(blob);
                  window.open(blobUrl, '_blank');
                  setStatus('QR opened');
                } catch (e) {
                  setStatus('QR open failed');
                }
              });
            });

            // Copy QR to clipboard as PNG (fallback: download)
            document.querySelectorAll('.qr-copy-btn').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const url = btn.getAttribute('data-url');
                if (!url) return;
                try {
                  const blob = await generateQrPngBlob(url);
                  if (
                    navigator.clipboard &&
                    window.ClipboardItem &&
                    navigator.clipboard.write
                  ) {
                    const item = new ClipboardItem({ 'image/png': blob });
                    await navigator.clipboard.write([item]);
                    setStatus('QR copied!');
                  } else {
                    downloadBlob(blob, 'qr-code.png');
                    setStatus('Clipboard not supported, downloaded PNG');
                  }
                } catch (e) {
                  setStatus('QR copy failed');
                }
              });
            });
          })();
        `
        }}
      />
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
      '<svg width="200" height="200"'
    )

    return c.render(
      <div>
        <h2>Created!</h2>

        {/* Short URL field */}
        <div style={{ marginBottom: '10px' }}>
          <input
            id="short-url"
            type="text"
            value={shortUrlStr}
            style={{ width: '80%' }}
            readOnly
          />
        </div>

        {/* Buttons for URL and QR */}
        <div style={{ marginBottom: '20px' }}>
          <button id="copy-url-btn" type="button">
            Copy URL
          </button>
          <button
            id="copy-qr-btn"
            type="button"
            style={{ marginLeft: '10px' }}
          >
            Copy QR (PNG)
          </button>
          <button
            id="download-qr-btn"
            type="button"
            style={{ marginLeft: '10px' }}
          >
            Download QR (PNG)
          </button>
          <span
            id="copy-status"
            style={{ marginLeft: '10px', fontSize: '0.9em' }}
          />
        </div>

        {/* QR code (SVG) */}
        <div style={{ marginTop: '10px' }}>
          <h3>QR Code:</h3>
          <div
            id="qr-container"
            style={{ width: '200px', height: '200px' }}
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        </div>

        {/* Back link */}
        <div style={{ marginTop: '10px' }}>
          <a href="/">Back to Home</a>
        </div>

        {/* Client-side script: copy URL, copy QR PNG, download QR PNG */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                const copyUrlBtn = document.getElementById('copy-url-btn');
                const copyQrBtn = document.getElementById('copy-qr-btn');
                const downloadQrBtn = document.getElementById('download-qr-btn');
                const input = document.getElementById('short-url');
                const status = document.getElementById('copy-status');
                const qrContainer = document.getElementById('qr-container');
                if (!input || !qrContainer) return;

                // Copy URL button
                if (copyUrlBtn) {
                  copyUrlBtn.addEventListener('click', async () => {
                    const text = input.value;
                    try {
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(text);
                      } else {
                        input.select();
                        document.execCommand('copy');
                      }
                      if (status) {
                        status.textContent = 'URL copied!';
                        setTimeout(() => (status.textContent = ''), 2000);
                      }
                    } catch (e) {
                      if (status) status.textContent = 'URL copy failed';
                    }
                  });
                }

                // Convert SVG → PNG (200x200) and return a Blob
                async function svgToPngBlob() {
                  const svgEl = qrContainer.querySelector('svg');
                  if (!svgEl) throw new Error('SVG not found');

                  const svgData = new XMLSerializer().serializeToString(svgEl);
                  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
                  const url = URL.createObjectURL(svgBlob);

                  try {
                    const img = new Image();
                    const imgLoad = new Promise((resolve, reject) => {
                      img.onload = resolve;
                      img.onerror = reject;
                    });
                    img.src = url;
                    await imgLoad;

                    const canvas = document.createElement('canvas');
                    canvas.width = 200;
                    canvas.height = 200;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) throw new Error('No canvas context');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, 200, 200);

                    return await new Promise((resolve, reject) => {
                      canvas.toBlob((blob) => {
                        if (!blob) reject(new Error('PNG blob failed'));
                        else resolve(blob);
                      }, 'image/png');
                    });
                  } finally {
                    URL.revokeObjectURL(url);
                  }
                }

                // Download PNG helper
                function downloadPng(blob) {
                  const pngUrl = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = pngUrl;
                  a.download = 'qr-code.png';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(pngUrl);
                }

                // Download QR (PNG)
                if (downloadQrBtn) {
                  downloadQrBtn.addEventListener('click', async () => {
                    try {
                      const blob = await svgToPngBlob();
                      downloadPng(blob);
                    } catch (e) {
                      if (status) status.textContent = 'Download failed';
                    }
                  });
                }

                // Copy QR (PNG) to clipboard (with fallback to download)
                if (copyQrBtn) {
                  copyQrBtn.addEventListener('click', async () => {
                    try {
                      const blob = await svgToPngBlob();

                      if (
                        navigator.clipboard &&
                        window.ClipboardItem &&
                        navigator.clipboard.write
                      ) {
                        const item = new ClipboardItem({ 'image/png': blob });
                        await navigator.clipboard.write([item]);
                        if (status) {
                          status.textContent = 'QR copied to clipboard!';
                          setTimeout(() => (status.textContent = ''), 2000);
                        }
                      } else {
                        // Fallback: download if image clipboard is not supported
                        downloadPng(blob);
                        if (status) {
                          status.textContent = 'Clipboard not supported, downloaded PNG';
                          setTimeout(() => (status.textContent = ''), 2000);
                        }
                      }
                    } catch (e) {
                      if (status) status.textContent = 'QR copy failed';
                    }
                  });
                }
              })();
            `,
          }}
        />
      </div>
    )
  } catch (e) {
    console.error('Error in /create handler:', e)
    return c.text('Internal error while creating QR', 500)
  }
})

// Delete single entry (KV key + history)
app.post('/history/delete/:key', csrf(), async (c) => {
  const key = c.req.param('key')
  try {
    // Delete from KV store (no error if key is missing)
    await c.env.KV.delete(key) // delete() is the standard way to remove a key-value pair from KV. [web:8][web:14]
    await removeFromHistory(c.env.KV, key)
    return c.json({ ok: true })
  } catch (e) {
    console.error('Error deleting key from history:', e)
    return c.json({ ok: false, error: 'delete-failed' }, 500)
  }
})

export default app
