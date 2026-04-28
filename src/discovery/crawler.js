import * as cheerio from 'cheerio'
import { fetchHtml } from '../lib/fetchHtml.js'
import { fetchHtmlBrowser } from '../lib/fetchHtmlBrowser.js'
import { detectSpaBuilder } from '../lib/spaDetector.js'

/**
 * URL-path scoring for contact-likely pages. Mirrors the email-verification
 * service's scraper.js scoring (deliberately — the scraper piggyback already
 * writes high-confidence matches to sourced_websites.contact_page_url, so when
 * we fall back to crawling here, we want the same definition of "contact-y").
 */
const CONTACT_PATH_PATTERNS = [
  { pattern: /^\/contact\/?$/i, score: 100 },
  { pattern: /\/contact[-_]?us\/?$/i, score: 95 },
  { pattern: /\/contact\/?/i, score: 80 },
  { pattern: /\/get[-_]?in[-_]?touch\/?/i, score: 80 },
  { pattern: /\/reach[-_]?out\/?/i, score: 70 },
  { pattern: /\/about[-_]?contact\/?/i, score: 70 },
  { pattern: /\/connect\/?$/i, score: 60 },
  { pattern: /\/about[-_]?us\/?$/i, score: 50 },
  { pattern: /\/about\/?$/i, score: 45 },
]

const CONTACT_LINK_TEXT = /\b(contact|get in touch|reach out|connect with us)\b/i

/**
 * @typedef {{
 *   sourcedWebsiteId?: string | null,
 *   supabase?: import('@supabase/supabase-js').SupabaseClient | null,
 *   logger?: { info: (...args: unknown[]) => void, debug: (...args: unknown[]) => void, warn: (...args: unknown[]) => void },
 *   forceBrowser?: boolean
 * }} ResolveOptions
 */

/**
 * Static-HTML fetch with a one-shot Playwright fallback when the page
 * fingerprints as a JS-rendered builder. `forceBrowser` skips the static
 * attempt entirely — the operator override.
 *
 * @param {string} url
 * @param {ResolveOptions} options
 * @returns {Promise<string | null>}
 */
async function fetchHtmlSmart(url, options) {
  const logger = options.logger ?? console
  if (options.forceBrowser) {
    logger.debug?.({ url }, '[crawler] forceBrowser=true — fetching via Playwright')
    return await fetchHtmlBrowser(url, { logger })
  }
  const html = await fetchHtml(url, { logger })
  if (!html) return null
  if (looksLikeFormPage(html)) return html
  const builder = detectSpaBuilder(html)
  if (!builder) return html
  logger.info?.({ url, builder }, '[crawler] SPA builder detected without static form — escalating to Playwright')
  const rendered = await fetchHtmlBrowser(url, { logger })
  return rendered ?? html
}

/**
 * @param {string} href
 * @param {URL} baseUrl
 * @returns {{ score: number, absoluteUrl: string | null }}
 */
function scoreLink(href, baseUrl) {
  if (!href) return { score: 0, absoluteUrl: null }
  let abs
  try {
    abs = new URL(href, baseUrl)
  } catch {
    return { score: 0, absoluteUrl: null }
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') {
    return { score: 0, absoluteUrl: null }
  }
  // Same-host only — third-party "contact" links go to scammers / partner brand
  // sites, not the prospect's form.
  if (abs.hostname.replace(/^www\./, '') !== baseUrl.hostname.replace(/^www\./, '')) {
    return { score: 0, absoluteUrl: null }
  }

  const path = abs.pathname || '/'
  let best = 0
  for (const { pattern, score } of CONTACT_PATH_PATTERNS) {
    if (pattern.test(path)) best = Math.max(best, score)
  }
  return { score: best, absoluteUrl: abs.toString() }
}

/**
 * Pull contact-likely candidate URLs from a homepage's anchors, scored desc.
 *
 * @param {string} html
 * @param {URL} baseUrl
 * @returns {string[]}
 */
function pickContactCandidates(html, baseUrl) {
  const $ = cheerio.load(html)
  /** @type {Map<string, number>} */
  const candidates = new Map()
  $('a[href]').each((_, el) => {
    const $a = $(el)
    const href = $a.attr('href') || ''
    const text = $a.text().trim()
    const { score, absoluteUrl } = scoreLink(href, baseUrl)
    if (!absoluteUrl) return

    let total = score
    // Anchor text bonus — even a weak path like `/contact/something` is a real
    // contact link if the visible text says so.
    if (CONTACT_LINK_TEXT.test(text)) total += 25

    if (total <= 0) return
    const prev = candidates.get(absoluteUrl) || 0
    if (total > prev) candidates.set(absoluteUrl, total)
  })
  return Array.from(candidates.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
}

/**
 * Quick "does this page look like it has a fillable form?" check. Used to
 * confirm a candidate URL before we commit to it. Avoids the cost of running
 * the full extractor at this stage.
 *
 * @param {string} html
 */
function looksLikeFormPage(html) {
  // Cheap regex check — running cheerio twice in the resolve loop is wasteful.
  return /<form\b/i.test(html) && /<(input|textarea)\b/i.test(html)
}

/**
 * Resolve the contact URL for a domain. Order:
 *   1. Cached value on `sourced_websites.contact_page_url`, if reachable.
 *   2. Homepage crawl: score links, fetch top candidates, pick the first that
 *      hosts a form-shaped page.
 *   3. Homepage itself if it has a form.
 *
 * Returns null when nothing plausible turns up.
 *
 * @param {string} domain
 * @param {ResolveOptions} [options]
 * @returns {Promise<string | null>}
 */
export async function resolveContactUrl(domain, options = {}) {
  const logger = options.logger ?? console
  const supabase = options.supabase ?? null
  const sourcedWebsiteId = options.sourcedWebsiteId ?? null

  // 1. Cached value
  if (sourcedWebsiteId && supabase) {
    const { data, error } = await supabase
      .from('sourced_websites')
      .select('contact_page_url')
      .eq('id', sourcedWebsiteId)
      .maybeSingle()
    if (error) {
      logger.warn({ sourcedWebsiteId, err: error.message }, '[crawler] sourced_websites lookup failed')
    } else if (data?.contact_page_url) {
      const html = await fetchHtmlSmart(data.contact_page_url, options)
      if (html && looksLikeFormPage(html)) {
        logger.debug({ domain, url: data.contact_page_url }, '[crawler] using cached contact_page_url')
        return data.contact_page_url
      }
      logger.debug({ domain, url: data.contact_page_url }, '[crawler] cached contact_page_url unreachable or formless — falling back to crawl')
    }
  }

  // 2. Homepage crawl
  const homepageUrl = `https://${domain}`
  let baseUrl
  try {
    baseUrl = new URL(homepageUrl)
  } catch {
    return null
  }

  const homepageHtml = await fetchHtmlSmart(homepageUrl, options)
  if (!homepageHtml) return null

  const candidates = pickContactCandidates(homepageHtml, baseUrl).slice(0, 4)
  for (const candidate of candidates) {
    const html = await fetchHtmlSmart(candidate, options)
    if (html && looksLikeFormPage(html)) return candidate
  }

  // 3. Direct-path probe. Modern SaaS often renders nav/footer via JS, so the
  // homepage's static HTML has no /contact link to extract. Try the obvious
  // paths anyway — cheap, and recovers a meaningful slice of SPAs.
  const probedPaths = [
    '/contact/',
    '/contact',
    '/contact-us/',
    '/contact-us',
    '/get-in-touch/',
    '/about/contact/',
  ]
  for (const path of probedPaths) {
    const url = new URL(path, baseUrl).toString()
    const html = await fetchHtmlSmart(url, options)
    if (html && looksLikeFormPage(html)) {
      logger.debug({ domain, url }, '[crawler] direct-path probe hit')
      return url
    }
  }

  // 4. Homepage itself as last resort. The smart-fetch above may have already
  // upgraded homepageHtml to the rendered Wix/Squarespace DOM, so this catch
  // recovers homepage-form sites the candidate loop missed.
  if (looksLikeFormPage(homepageHtml)) return homepageUrl

  return null
}
