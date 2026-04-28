const DEFAULT_TIMEOUT_MS = 10000

// Realistic Chrome desktop UA — discovery wants to see the same HTML a real
// visitor would. Bot-y UAs occasionally trip CDN edge-side rules and serve
// stripped pages without forms.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * Fetch a URL with a short timeout, HTML-only. Returns null on any failure.
 * Discovery is best-effort — never throws for recoverable network errors.
 *
 * @param {string} url
 * @param {{
 *   timeoutMs?: number,
 *   userAgent?: string,
 *   logger?: { debug: (...args: unknown[]) => void }
 * }} [options]
 * @returns {Promise<string | null>}
 */
export async function fetchHtml(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  const logger = options.logger ?? console

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!res.ok) {
      logger.debug({ url, status: res.status }, '[fetchHtml] non-ok')
      return null
    }
    const contentType = res.headers.get('content-type') || ''
    if (!/text\/html|application\/xhtml/.test(contentType)) {
      logger.debug({ url, contentType }, '[fetchHtml] non-html')
      return null
    }
    return await res.text()
  } catch (err) {
    logger.debug(
      { url, err: err instanceof Error ? err.message : String(err) },
      '[fetchHtml] error',
    )
    return null
  } finally {
    clearTimeout(timeout)
  }
}
