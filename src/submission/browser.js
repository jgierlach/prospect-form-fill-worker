import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { pickUserAgent, pickViewport } from '../lib/userAgents.js'

/**
 * @typedef {{
 *   browser: import('playwright').Browser,
 *   context: import('playwright').BrowserContext,
 *   page: import('playwright').Page,
 *   userAgent: string,
 *   viewport: { width: number, height: number },
 *   proxyEnabled: boolean,
 *   sessionId: string | null,
 *   getBytesUsed: () => number
 * }} BrowserSession
 */

/**
 * Hex string used in the Decodo username's `-session-XXXX` suffix. A fresh ID
 * per launch means each submission gets a different residential IP.
 */
function generateSessionId() {
  return crypto.randomBytes(8).toString('hex')
}

/**
 * Build the Playwright proxy config from env, or null when Decodo isn't
 * configured. Returning null lets local dev work without a Decodo account —
 * traffic just goes out the box's IP, which is fine for smoke testing on
 * unprotected forms (httpbin etc.) but useless against most real prospect
 * sites because their WAFs block datacenter IPs.
 *
 * @param {{ debug?: Function, warn?: Function }} logger
 * @returns {{ proxy: import('playwright').LaunchOptions['proxy'], sessionId: string | null, enabled: boolean }}
 */
function buildProxyConfig(logger) {
  const username = process.env.DECODO_USERNAME
  const password = process.env.DECODO_PASSWORD
  if (!username || !password) {
    logger.warn?.('[browser] DECODO_USERNAME / DECODO_PASSWORD unset — launching WITHOUT residential proxy')
    return { proxy: undefined, sessionId: null, enabled: false }
  }
  const host = process.env.DECODO_HOST || 'gate.decodo.com'
  const port = process.env.DECODO_PORT || '10001'
  const sessionId = generateSessionId()
  return {
    proxy: {
      server: `http://${host}:${port}`,
      // Decodo sticky-session syntax: append `-session-XXXX` to the username.
      // Each submission gets a fresh residential IP that holds for the
      // life of this browser launch.
      username: `${username}-session-${sessionId}`,
      password,
    },
    sessionId,
    enabled: true,
  }
}

/**
 * Launch a fresh Chromium with randomized UA + viewport, optionally routed
 * through a Decodo residential proxy with a sticky session. Caller MUST
 * call closeSession to release the browser; otherwise pids accumulate.
 *
 * @param {{
 *   headless?: boolean,
 *   logger?: { debug?: Function, warn?: Function }
 * }} [options]
 * @returns {Promise<BrowserSession>}
 */
export async function launchSession(options = {}) {
  const headless = options.headless ?? true
  const logger = options.logger ?? console

  const userAgent = pickUserAgent()
  const viewport = pickViewport()
  const { proxy, sessionId, enabled: proxyEnabled } = buildProxyConfig(logger)

  const browser = await chromium.launch({
    headless,
    // --no-sandbox needed when running as root in a container/VPS without
    // user-namespace setup. Hetzner box runs as root by default.
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ...(proxy ? { proxy } : {}),
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

  // Track bytes for cost accounting. Counts response Content-Length where
  // present; chunked / streaming responses underestimate but it's a
  // good-enough proxy for billing-month-level Decodo spend visibility.
  let bytesIn = 0
  page.on('response', (res) => {
    const cl = res.headers()['content-length']
    if (!cl) return
    const len = parseInt(cl, 10)
    if (Number.isFinite(len) && len > 0) bytesIn += len
  })

  logger.debug?.({ userAgent, viewport, proxyEnabled, sessionId }, '[browser] session launched')

  return {
    browser,
    context,
    page,
    userAgent,
    viewport,
    proxyEnabled,
    sessionId,
    getBytesUsed: () => bytesIn,
  }
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
