import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8788'
const OUT = new URL('../docs/screenshots/', import.meta.url)
const headers = {
  'CF-Access-Authenticated-User-Email': 'demo@example.com'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function anonymizeDom(page) {
  await page.evaluate(() => {
    const host = 'https://short.example'
    const rewrite = (value) =>
      String(value || '')
        .replace(/https?:\/\/127\.0\.0\.1:\d+/g, host)
        .replace(/https?:\/\/localhost:\d+/g, host)
        .replace(/admin@example\.com/g, 'demo@example.com')
    document.querySelectorAll('a, input, [data-url]').forEach((el) => {
      if (el instanceof HTMLAnchorElement && el.href) {
        el.href = rewrite(el.href)
        // Never assign textContent on anchors with children — that flattens
        // the brand-logo badge into plain "LOGOURL Shortener" text.
        if (!el.querySelector('*') && el.textContent) {
          el.textContent = rewrite(el.textContent)
        }
      }
      if (el instanceof HTMLInputElement && el.value) {
        el.value = rewrite(el.value)
      }
      const dataUrl = el.getAttribute('data-url')
      if (dataUrl) el.setAttribute('data-url', rewrite(dataUrl))
    })
    document.body.querySelectorAll('*').forEach((el) => {
      for (const node of el.childNodes) {
        if (
          node.nodeType === Node.TEXT_NODE &&
          /127\.0\.0\.1|localhost|admin@example\.com/.test(node.textContent || '')
        ) {
          node.textContent = rewrite(node.textContent)
        }
      }
    })
  })
}

async function waitForBrand(page) {
  await page.waitForSelector('.brand-logo', { timeout: 15000 })
  await page.waitForFunction(() => {
    const el = document.querySelector('.brand-logo')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 40 && r.height > 20 && /LOGO/i.test(el.textContent || '')
  }, { timeout: 15000 })
  await sleep(200)
}

async function shot(page, name) {
  await waitForBrand(page)
  await anonymizeDom(page)
  const brandOk = await page.evaluate(() => {
    const el = document.querySelector('.brand-logo')
    if (!el) return false
    const bg = getComputedStyle(el).backgroundColor
    return bg === 'rgb(255, 255, 255)' && /LOGO/i.test(el.textContent || '')
  })
  if (!brandOk) {
    throw new Error(`brand-logo badge missing/flattened before shot: ${name}`)
  }
  const path = new URL(`${name}.png`, OUT).pathname
  await page.screenshot({ path, fullPage: true })
  console.log('wrote', path, new Date().toISOString())
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
    headless: true
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: headers
  })
  const page = await context.newPage()

  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' })
  await page.fill('#url-input', 'https://example.com/docs/getting-started')
  await page.waitForFunction(
    () => document.querySelector('#url-input')?.value?.includes('example.com')
  )
  await shot(page, 'create')

  // Create a link to example.com for history rows
  await page.fill('#url-input', 'https://example.com/')
  await page.click('#create-submit')
  await sleep(4000)

  await page.goto(`${BASE}/admin/history`, { waitUntil: 'networkidle' })
  await sleep(1000)
  await shot(page, 'history')

  const deleteBtn = page.locator('.delete-btn').first()
  if (await deleteBtn.count()) {
    page.once('dialog', (d) => d.accept())
    await deleteBtn.click()
    await sleep(1200)
  }

  await page.goto(`${BASE}/admin/trash`, { waitUntil: 'networkidle' })
  await sleep(600)
  await shot(page, 'trash')

  await page.goto(`${BASE}/admin/audit`, { waitUntil: 'networkidle' })
  await sleep(500)
  await shot(page, 'audit')

  await page.goto(`${BASE}/admin/roles`, { waitUntil: 'networkidle' })
  await sleep(500)
  await shot(page, 'roles')

  await page.goto(`${BASE}/zzdemo`, { waitUntil: 'networkidle' })
  await sleep(500)
  await shot(page, 'missing-link')

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
