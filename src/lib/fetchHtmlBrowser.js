import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { pickUserAgent, pickViewport } from './userAgents.js'

const DEFAULT_TIMEOUT_MS = 45000
const FORM_WAIT_MS = 5000

// Playwright's goto() error message is opaque text, not a code. These regex
// fragments cover the network-level failures that warrant a Decodo retry —
// the host firewalled the datacenter IP, the gateway timed out, etc. We
// deliberately exclude ERR_NAME_NOT_RESOLVED (dead domain) and HTTP-level
// errors (which goto returns as a Response, not a throw).
const BROWSER_RETRY_PATTERNS =
  /ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_TIMED_OUT|net::ERR_FAILED|Timeout \d+ms exceeded/i

const BROWSER_NO_RETRY_PATTERNS = /ERR_NAME_NOT_RESOLVED|ERR_INVALID_URL/i

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function shouldRetryViaProxy(err) {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (!msg) return false
  if (BROWSER_NO_RETRY_PATTERNS.test(msg)) return false
  return BROWSER_RETRY_PATTERNS.test(msg)
}

/**
 * Decodo proxy config for chromium.launch — null when Decodo creds aren't
 * configured (callers skip the retry in that case).
 */
function buildDecodoProxy() {
  const username = process.env.DECODO_USERNAME
  const password = process.env.DECODO_PASSWORD
  if (!username || !password) return null
  const host = process.env.DECODO_HOST || 'gate.decodo.com'
  const port = process.env.DECODO_PORT || '10001'
  const sessionId = crypto.randomBytes(8).toString('hex')
  return {
    server: `http://${host}:${port}`,
    username: `user-${username}-session-${sessionId}`,
    password,
  }
}

/**
 * Single-attempt browser fetch. Launches a fresh Chromium, navigates, waits
 * briefly for a form to render, returns the page HTML. Returns { error } on
 * any throw from launch/goto/content.
 *
 * @param {{
 *   url: string,
 *   timeoutMs: number,
 *   userAgent: string,
 *   viewport: { width: number, height: number },
 *   proxy?: ReturnType<typeof buildDecodoProxy>,
 *   logger: { debug?: Function, info?: Function, warn?: Function }
 * }} args
 * @returns {Promise<{ html: string | null, error: unknown }>}
 */
async function fetchOnce({ url, timeoutMs, userAgent, viewport, proxy, logger }) {
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ...(proxy ? { proxy } : {}),
    })
    const context = await browser.newContext({
      userAgent,
      viewport,
      locale: 'en-US',
      timezoneId: 'America/New_York',
    })
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    const page = await context.newPage()
    // domcontentloaded — not networkidle — for the goto wait. Modern marketing
    // sites keep firing analytics / chat-widget / polling requests for ages,
    // so networkidle routinely times out at 30s even when the form is fully
    // rendered. The form-selector wait below is the meaningful blocking signal.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

    // Some builders (Wix especially) finish their primary network burst before
    // the form widget hydrates. Give the form a few extra seconds to appear,
    // but don't fail if it doesn't — the caller still inspects the snapshot.
    try {
      await page.waitForSelector('form, [role="form"]', { timeout: FORM_WAIT_MS })
    } catch {
      logger.debug?.({ url }, '[fetchHtmlBrowser] form selector did not appear within wait window')
    }

    // Scroll the form (or the bottom of the page if no form) into view so
    // intersection-observer-driven lazy assets fire — captcha scripts on
    // GoDaddy WB / many React sites only inject themselves once the form is
    // visible. Without this, our snapshot misses reCAPTCHA/hCaptcha sitekeys
    // even though a real visitor would clearly see the captcha.
    try {
      await page.evaluate(() => {
        const form = document.querySelector('form, [role="form"]')
        if (form && 'scrollIntoView' in form) {
          /** @type {HTMLElement} */ (form).scrollIntoView({ block: 'center' })
        } else {
          window.scrollTo({ top: document.body.scrollHeight })
        }
      })
      // Brief settle so any lazy scripts triggered by the scroll have time to
      // attach themselves to the DOM. 1.5s covers most common loaders.
      await page.waitForTimeout(1500)
    } catch {
      /* swallow — best-effort */
    }

    return { html: await page.content(), error: null }
  } catch (err) {
    return { html: null, error: err }
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

/**
 * Fetch a URL through a real headless Chromium so JS-rendered forms have a
 * chance to hydrate before we read the DOM. Used by discovery as a fallback
 * when the static-HTML fetch turns up no `<form>` and the page fingerprints
 * as a known SPA builder (Wix/Squarespace/Webflow/etc.).
 *
 * Strategy: try direct (datacenter IP) first — fast and free. If the goto
 * fails with a network-layer signal — common on managed-WP hosts that
 * firewall datacenter IPs at the host firewall — retry through Decodo's
 * residential proxy. DNS-not-resolved and bad-URL errors skip the retry,
 * since residential routing won't fix a dead domain.
 *
 * Pass a `fetchState` (see fetchHtml.js) to share the proxy verdict across
 * fetches in one discovery run.
 *
 * @param {string} url
 * @param {{
 *   timeoutMs?: number,
 *   logger?: { debug?: Function, info?: Function, warn?: Function },
 *   fetchState?: import('./fetchHtml.js').FetchState
 * }} [options]
 * @returns {Promise<string | null>}
 */
export async function fetchHtmlBrowser(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const logger = options.logger ?? console
  const userAgent = pickUserAgent()
  const viewport = pickViewport()
  const fetchState = options.fetchState

  // 1. Direct attempt — skip when caller knows this host firewalls us.
  if (!fetchState?.forceProxy) {
    const direct = await fetchOnce({ url, timeoutMs, userAgent, viewport, logger })
    if (direct.html) return direct.html
    if (!shouldRetryViaProxy(direct.error)) {
      logger.warn?.(
        { url, err: direct.error instanceof Error ? direct.error.message : String(direct.error) },
        '[fetchHtmlBrowser] error',
      )
      return null
    }
    logger.info?.(
      { url, err: direct.error instanceof Error ? direct.error.message : null },
      '[fetchHtmlBrowser] direct blocked — retrying via Decodo',
    )
  }

  // 2. Proxy attempt — managed-WP hosts (WP Engine, Kinsta, Cloudways) and
  //    others firewall datacenter ranges. Residential routing bypasses.
  const proxy = buildDecodoProxy()
  if (!proxy) {
    logger.warn?.({ url }, '[fetchHtmlBrowser] Decodo not configured — giving up')
    return null
  }
  const proxied = await fetchOnce({ url, timeoutMs, userAgent, viewport, proxy, logger })
  if (proxied.html) {
    if (fetchState) {
      fetchState.usedProxy = true
      fetchState.forceProxy = true
    }
    return proxied.html
  }
  if (proxied.error) {
    logger.warn?.(
      { url, err: proxied.error instanceof Error ? proxied.error.message : String(proxied.error) },
      '[fetchHtmlBrowser] Decodo retry failed',
    )
  }
  return null
}
