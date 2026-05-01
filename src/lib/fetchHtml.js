import crypto from 'node:crypto'
import { ProxyAgent } from 'undici'

const DEFAULT_TIMEOUT_MS = 10000
const PROXY_TIMEOUT_MS = 20000

// Realistic Chrome desktop UA — discovery wants to see the same HTML a real
// visitor would. Bot-y UAs occasionally trip CDN edge-side rules and serve
// stripped pages without forms.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// Connection-level error codes that indicate "the host firewalled our IP" or
// "the network can't get there." Distinguish these from app-level rejections
// (4xx/5xx) and DNS failures, since only the network-layer ones get a Decodo
// retry — application errors and dead domains shouldn't burn proxy cost.
const PROXY_RETRY_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function shouldRetryViaProxy(err) {
  if (!err) return false
  // AbortError = our own timeout fired before TCP connected. Treat as a
  // connection-level fail and retry through Decodo (which often *does* connect
  // because residential routing avoids the host's datacenter blocklist).
  if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') return true
  const code =
    err && typeof err === 'object' && 'code' in err
      ? /** @type {{ code?: unknown }} */ (err).code
      : undefined
  const causeCode =
    err && typeof err === 'object' && 'cause' in err && err.cause && typeof err.cause === 'object' && 'code' in err.cause
      ? /** @type {{ cause: { code?: unknown } }} */ (err).cause.code
      : undefined
  if (typeof code === 'string' && PROXY_RETRY_CODES.has(code)) return true
  if (typeof causeCode === 'string' && PROXY_RETRY_CODES.has(causeCode)) return true
  return false
}

/**
 * Build a one-shot Decodo dispatcher with a fresh sticky session. Returns null
 * when Decodo isn't configured, in which case callers skip the proxy retry.
 *
 * @returns {ProxyAgent | null}
 */
function buildDecodoDispatcher() {
  const username = process.env.DECODO_USERNAME
  const password = process.env.DECODO_PASSWORD
  if (!username || !password) return null
  const host = process.env.DECODO_HOST || 'gate.decodo.com'
  const port = process.env.DECODO_PORT || '10001'
  const sessionId = crypto.randomBytes(8).toString('hex')
  const proxyUrl = `http://user-${username}-session-${sessionId}:${password}@${host}:${port}`
  return new ProxyAgent(proxyUrl)
}

/**
 * Single-attempt fetch. Returns either { html } on success or { error } on
 * any failure path (incl. non-2xx, non-html). Never throws.
 *
 * @param {string} url
 * @param {{ timeoutMs: number, userAgent: string, dispatcher?: ProxyAgent, logger: { debug: Function } }} args
 * @returns {Promise<{ html: string | null, error: unknown }>}
 */
async function fetchOnce(url, { timeoutMs, userAgent, dispatcher, logger }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!res.ok) {
      logger.debug({ url, status: res.status }, '[fetchHtml] non-ok')
      return { html: null, error: null }
    }
    const contentType = res.headers.get('content-type') || ''
    if (!/text\/html|application\/xhtml/.test(contentType)) {
      logger.debug({ url, contentType }, '[fetchHtml] non-html')
      return { html: null, error: null }
    }
    return { html: await res.text(), error: null }
  } catch (err) {
    return { html: null, error: err }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Fetch a URL with a short timeout, HTML-only. Returns null on any failure.
 * Discovery is best-effort — never throws for recoverable network errors.
 *
 * Strategy: try the host's IP directly first (cheap, fast). If the failure
 * looks like a network-layer block (TCP timeout, ECONNREFUSED, etc.) — common
 * on managed-WP hosts that firewall datacenter IPs — retry the request through
 * Decodo's residential proxy. Application-level errors (4xx, 5xx, non-html
 * content) skip the retry to avoid burning proxy cost on dead pages.
 *
 * @param {string} url
 * @param {{
 *   timeoutMs?: number,
 *   userAgent?: string,
 *   logger?: { debug: (...args: unknown[]) => void, info?: (...args: unknown[]) => void }
 * }} [options]
 * @returns {Promise<string | null>}
 */
export async function fetchHtml(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  const logger = options.logger ?? console

  // 1. Direct attempt — free when it works.
  const direct = await fetchOnce(url, { timeoutMs, userAgent, logger })
  if (direct.html) return direct.html
  if (!shouldRetryViaProxy(direct.error)) {
    if (direct.error) {
      logger.debug(
        { url, err: direct.error instanceof Error ? direct.error.message : String(direct.error) },
        '[fetchHtml] error',
      )
    }
    return null
  }

  // 2. Connection-level fail → host likely blocks our datacenter IP. Retry
  //    through Decodo (residential routing usually bypasses the block).
  const dispatcher = buildDecodoDispatcher()
  if (!dispatcher) {
    logger.debug(
      { url },
      '[fetchHtml] connection error and Decodo not configured — giving up',
    )
    return null
  }
  logger.info?.(
    { url, err: direct.error instanceof Error ? direct.error.message : null },
    '[fetchHtml] direct blocked — retrying via Decodo',
  )
  const proxied = await fetchOnce(url, {
    timeoutMs: PROXY_TIMEOUT_MS,
    userAgent,
    dispatcher,
    logger,
  })
  // Best-effort dispatcher cleanup; ProxyAgent.close() returns a promise.
  try {
    await dispatcher.close()
  } catch {
    /* swallow */
  }
  if (proxied.html) return proxied.html
  if (proxied.error) {
    logger.debug(
      { url, err: proxied.error instanceof Error ? proxied.error.message : String(proxied.error) },
      '[fetchHtml] Decodo retry failed',
    )
  }
  return null
}
