import { chromium } from 'playwright'
import { pickUserAgent, pickViewport } from '../lib/userAgents.js'

/**
 * @typedef {{
 *   browser: import('playwright').Browser,
 *   context: import('playwright').BrowserContext,
 *   page: import('playwright').Page,
 *   userAgent: string,
 *   viewport: { width: number, height: number }
 * }} BrowserSession
 */

/**
 * Launch a fresh Chromium with randomized UA + viewport. No proxy yet —
 * Decodo wires in at step 7. Caller MUST call closeSession to release the
 * browser; otherwise pids accumulate.
 *
 * @param {{
 *   headless?: boolean,
 *   logger?: { debug: Function }
 * }} [options]
 * @returns {Promise<BrowserSession>}
 */
export async function launchSession(options = {}) {
  const headless = options.headless ?? true
  const logger = options.logger ?? console

  const userAgent = pickUserAgent()
  const viewport = pickViewport()

  const browser = await chromium.launch({
    headless,
    // --no-sandbox needed when running as root in a container/VPS without
    // user-namespace setup. Hetzner box runs as root by default.
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  })

  const context = await browser.newContext({
    userAgent,
    viewport,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })

  // Strip navigator.webdriver, the most obvious bot tell, before any page
  // script runs. Real users don't have this property set.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  const page = await context.newPage()
  logger.debug({ userAgent, viewport }, '[browser] session launched')

  return { browser, context, page, userAgent, viewport }
}

/**
 * @param {BrowserSession} session
 */
export async function closeSession(session) {
  try {
    await session.context.close()
  } catch {
    /* swallow — best-effort cleanup */
  }
  try {
    await session.browser.close()
  } catch {
    /* swallow */
  }
}
