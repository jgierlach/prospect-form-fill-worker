import { chromium } from 'playwright'
import { pickUserAgent, pickViewport } from './userAgents.js'

const DEFAULT_TIMEOUT_MS = 30000
const FORM_WAIT_MS = 5000

/**
 * Fetch a URL through a real headless Chromium so JS-rendered forms have a
 * chance to hydrate before we read the DOM. Used by discovery as a fallback
 * when the static-HTML fetch turns up no `<form>` and the page fingerprints
 * as a known SPA builder (Wix/Squarespace/Webflow/etc.).
 *
 * Datacenter IP — no Decodo proxy. Discovery against a prospect's homepage is
 * a single GET; residential IP cost is reserved for the submission flow,
 * where bot-detection and CAPTCHAs actually fire.
 *
 * @param {string} url
 * @param {{
 *   timeoutMs?: number,
 *   logger?: { debug?: Function, info?: Function, warn?: Function }
 * }} [options]
 * @returns {Promise<string | null>}
 */
export async function fetchHtmlBrowser(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const logger = options.logger ?? console

  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    })
    const context = await browser.newContext({
      userAgent: pickUserAgent(),
      viewport: pickViewport(),
      locale: 'en-US',
      timezoneId: 'America/New_York',
    })
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs })

    // Some builders (Wix especially) finish their primary network burst before
    // the form widget hydrates. Give the form a few extra seconds to appear,
    // but don't fail if it doesn't — the caller still inspects the snapshot.
    try {
      await page.waitForSelector('form, [role="form"]', { timeout: FORM_WAIT_MS })
    } catch {
      logger.debug?.({ url }, '[fetchHtmlBrowser] form selector did not appear within wait window')
    }

    return await page.content()
  } catch (err) {
    logger.warn?.(
      { url, err: err instanceof Error ? err.message : String(err) },
      '[fetchHtmlBrowser] error',
    )
    return null
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {
        /* swallow */
      }
    }
  }
}
