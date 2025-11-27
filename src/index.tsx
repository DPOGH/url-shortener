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

// Create shortened URL + QR (SVG 200px) + copy & download buttons
app.post('/create', csrf(), validator, async (c) => {
  try {
    const { url } = c.req.valid('form')
    const key = await createKey(c.env.KV, url)

    const shortenUrl = new URL(`/${key}`, c.req.url)
    const shortUrlStr = shortenUrl.toString()

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

        {/* Copy & Download buttons */}
        <div style={{ marginBottom: '20px' }}>
          <button id="copy-btn" type="button">
            Copy URL
          </button>
          <button id="download-btn" type="button" style={{ marginLeft: '10px' }}>
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

        {/* Client-side script: copy-to-clipboard + SVG->PNG download */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                const copyBtn = document.getElementById('copy-btn');
                const downloadBtn = document.getElementById('download-btn');
                const input = document.getElementById('short-url');
                const status = document.getElementById('copy-status');
                const qrContainer = document.getElementById('qr-container');
                if (!input || !qrContainer) return;

                // Copy URL button
                if (copyBtn) {
                  copyBtn.addEventListener('click', async () => {
                    const text = input.value;
                    try {
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(text);
                      } else {
                        input.select();
                        document.execCommand('copy');
                      }
                      if (status) {
                        status.textContent = 'Copied!';
                        setTimeout(() => (status.textContent = ''), 2000);
                      }
                    } catch (e) {
                      if (status) status.textContent = 'Copy failed';
                    }
                  });
                }

                // Download PNG button (200x200 from SVG)
                if (downloadBtn) {
                  downloadBtn.addEventListener('click', () => {
                    const svgEl = qrContainer.querySelector('svg');
                    if (!svgEl) return;

                    const svgData = new XMLSerializer().serializeToString(svgEl);
                    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
                    const url = URL.createObjectURL(svgBlob);

                    const img = new Image();
                    img.onload = function () {
                      const canvas = document.createElement('canvas');
                      canvas.width = 200;
                      canvas.height = 200;
                      const ctx = canvas.getContext('2d');
                      if (!ctx) return;
                      ctx.fillStyle = '#ffffff';
                      ctx.fillRect(0, 0, canvas.width, canvas.height);
                      ctx.drawImage(img, 0, 0, 200, 200);
                      URL.revokeObjectURL(url);

                      canvas.toBlob(function (blob) {
                        if (!blob) return;
                        const pngUrl = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = pngUrl;
                        a.download = 'qr-code.png';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(pngUrl);
                      }, 'image/png');
                    };
                    img.src = url;
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

export default app
