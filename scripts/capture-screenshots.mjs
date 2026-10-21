import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8788'
const OUT = new URL('../docs/screenshots/', import.meta.url)
const headers = {
  'CF-Access-Authenticated-User-Email': 'admin@example.com'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function anonymizeDom(page) {
  await page.evaluate(() => {
    const host = 'https://short.example'
    const rewrite = (value) =>
      String(value || '')
        .replace(/https?:\/\/127\.0\.0\.1:\d+/g, host)
        .replace(/https?:\/\/localhost:\d+/g, host)
    document.querySelectorAll('a, input, [data-url]').forEach((el) => {
      if (el instanceof HTMLAnchorElement && el.href) {
        el.href = rewrite(el.href)
        el.textContent = rewrite(el.textContent || '')
      }
      if (el instanceof HTMLInputElement && el.value) {
        el.value = rewrite(el.value)
      }
      const dataUrl = el.getAttribute('data-url')
      if (dataUrl) el.setAttribute('data-url', rewrite(dataUrl))
    })
    document.body.querySelectorAll('*').forEach((el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && /127\.0\.0\.1|localhost/.test(node.textContent || '')) {
          node.textContent = rewrite(node.textContent)
        }
      }
    })
  })
}

async function waitForBrand(page) {
  await page.waitForSelector('img[src*="brand-logo"], img[src*="brand-icon"]', {
    timeout: 10000
  })
  await page.waitForFunction(() => {
    const img = document.querySelector('img[src*="brand-logo"], img[src*="brand-icon"]')
    return !!img && img.complete && img.naturalWidth > 20
  }, { timeout: 10000 })
}

async function shot(page, name) {
  await waitForBrand(page)
  await anonymizeDom(page)
  const path = new URL(`${name}.png`, OUT).pathname
  await page.screenshot({ path, fullPage: true })
  console.log('wrote', path)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
    headless: true
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: headers
  })
  const page = await context.newPage()

  // Create page with fake URL prefilled in the field for the screenshot
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' })
  await page.fill('#url-input', 'https://example.com/docs/getting-started')
  await shot(page, 'create')

  // Create a real short link for history (destination check against example.com)
  await page.fill('#url-input', 'https://example.com/')
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => null),
    page.click('#create-submit')
  ])
  await sleep(1500)
  // If still on create (client-side check then submit), wait for navigation
  if (page.url().includes('/admin/create') || page.url().endsWith('/admin/')) {
    // form may do fetch then requestSubmit — wait a bit more
    await sleep(3000)
  }
  // Ensure we have history entries even if create UI path differed
  await page.goto(`${BASE}/admin/history`, { waitUntil: 'networkidle' })
  await sleep(800)
  await shot(page, 'history')

  // Soft-delete first deletable row if present
  const deleteBtn = page.locator('.delete-btn').first()
  if (await deleteBtn.count()) {
    page.once('dialog', (d) => d.accept())
    await deleteBtn.click()
    await sleep(1000)
  }
  await page.goto(`${BASE}/admin/trash`, { waitUntil: 'networkidle' })
  await sleep(500)
  await shot(page, 'trash')

  await page.goto(`${BASE}/admin/audit`, { waitUntil: 'networkidle' })
  await sleep(400)
  await shot(page, 'audit')

  await page.goto(`${BASE}/admin/roles`, { waitUntil: 'networkidle' })
  await sleep(400)
  await shot(page, 'roles')

  // Missing short link (public 404 page with brand)
  await page.goto(`${BASE}/zzdemo`, { waitUntil: 'networkidle' })
  await sleep(400)
  await shot(page, 'missing-link')

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
