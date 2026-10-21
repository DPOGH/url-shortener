import { BUILD_VERSION } from './version'

/**
 * Runtime brand overlay.
 * Missing vars keep the public template anonymous: LOGO badge, home /admin/.
 * A private deploy sets the same names as Worker runtime vars.
 */
export type BrandBindings = {
  /** "image" serves the SVG logo. Anything else is the text badge. */
  BRAND_MARK?: string
  BRAND_ALT?: string
  BRAND_ARIA_LABEL?: string
  BRAND_HOME_URL?: string
  BRAND_HOME_LABEL?: string
  /** Text inserted before the final period, for example " to example.org". */
  BRAND_REDIRECT_HINT?: string
  BRAND_EMAIL_PLACEHOLDER?: string
  LINKCHECK_USER_AGENT?: string
  ERROR_LABEL?: string
  BUILD_VERSION?: string
}

export type BrandConfig = {
  mark: 'badge' | 'image'
  alt: string
  ariaLabel: string
  homeUrl: string
  homeLabel: string
  redirectHint: string
  emailPlaceholder: string
  linkcheckUserAgent: string
  errorLabel: string
  buildVersion: string
}

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const safeHref = (value: string | undefined, fallback: string) => {
  if (!value) return fallback
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return url.toString()
    }
  } catch {
    return fallback
  }
  return fallback
}

export const brandConfig = (
  env: Partial<BrandBindings> | undefined
): BrandConfig => ({
  mark: env?.BRAND_MARK === 'image' ? 'image' : 'badge',
  alt: env?.BRAND_ALT || 'LOGO',
  ariaLabel: env?.BRAND_ARIA_LABEL || 'URL Shortener home',
  homeUrl: safeHref(env?.BRAND_HOME_URL, '/admin/'),
  homeLabel: env?.BRAND_HOME_LABEL || 'Home',
  redirectHint: env?.BRAND_REDIRECT_HINT || '',
  emailPlaceholder: env?.BRAND_EMAIL_PLACEHOLDER || 'name@example.com',
  linkcheckUserAgent:
    env?.LINKCHECK_USER_AGENT || 'url-shortener-linkcheck/1.0',
  errorLabel: env?.ERROR_LABEL || 'url-shortener unhandled error',
  buildVersion: env?.BUILD_VERSION || BUILD_VERSION
})

export const brandLogoHtml = (brand: BrandConfig) => {
  if (brand.mark === 'image') {
    return `<span class="brand-logo brand-logo-image"><img src="/assets/brand-logo.svg" alt="${escapeHtml(brand.alt)}" width="155" height="57" /></span>`
  }
  return `<span class="brand-logo brand-logo-badge" aria-hidden="true">LOGO</span>`
}
