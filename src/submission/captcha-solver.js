const TWOCAPTCHA_BASE = 'https://2captcha.com'
const POLL_INTERVAL_MS = 5000
const MAX_POLL_MS = 90_000

/**
 * @typedef {'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile'} CaptchaType
 *
 * @typedef {{
 *   token: string,
 *   costCents: number,
 *   elapsedMs: number,
 *   captchaId: string
 * }} SolveResult
 */

/**
 * Average per-solve cost in cents — used for the `captcha_solve_cost_cents`
 * column when 2Captcha doesn't expose actuals on the synchronous path. These
 * are the cheapest tier prices on 2Captcha's PAYG plan as of v1; the
 * dashboard's billing log is the source of truth for accounting.
 *
 * @type {Record<CaptchaType, number>}
 */
const APPROX_COST_CENTS = {
  recaptcha_v2: 0.2,
  recaptcha_v3: 0.2,
  hcaptcha: 0.3,
  turnstile: 0.2,
}

/**
 * 2Captcha's `method` param mapping. reCAPTCHA v3 uses the same `userrecaptcha`
 * method but with `version=v3` + `min_score` + `action` extras.
 *
 * @type {Record<CaptchaType, string>}
 */
const METHOD = {
  recaptcha_v2: 'userrecaptcha',
  recaptcha_v3: 'userrecaptcha',
  hcaptcha: 'hcaptcha',
  turnstile: 'turnstile',
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Submit a captcha job to 2Captcha. Returns the captcha id (string) used to
 * poll for the result. Throws when the submit endpoint rejects (bad key,
 * insufficient balance, malformed sitekey, etc.).
 *
 * @param {{
 *   type: CaptchaType,
 *   siteKey: string,
 *   pageUrl: string,
 *   apiKey: string
 * }} args
 * @returns {Promise<string>}
 */
async function submitJob({ type, siteKey, pageUrl, apiKey }) {
  const params = new URLSearchParams({
    key: apiKey,
    method: METHOD[type],
    pageurl: pageUrl,
    json: '1',
  })
  // `sitekey` for Turnstile, `googlekey` for everything else (yes, including
  // hCaptcha — 2Captcha's API is inconsistent here for legacy reasons).
  if (type === 'turnstile') {
    params.set('sitekey', siteKey)
  } else {
    params.set('googlekey', siteKey)
  }
  if (type === 'recaptcha_v3') {
    params.set('version', 'v3')
    params.set('min_score', '0.7')
    params.set('action', 'submit')
  }

  const res = await fetch(`${TWOCAPTCHA_BASE}/in.php?${params}`, { method: 'POST' })
  const data = /** @type {{status: number, request: string}} */ (await res.json())
  if (data.status !== 1) {
    throw new Error(`2Captcha submit failed: ${data.request}`)
  }
  return data.request
}

/**
 * Poll for the solved token. Returns the token string. Throws on permanent
 * errors (e.g. `ERROR_CAPTCHA_UNSOLVABLE`) or after MAX_POLL_MS.
 *
 * @param {{
 *   captchaId: string,
 *   apiKey: string,
 *   logger: { debug: Function }
 * }} args
 * @returns {Promise<string>}
 */
async function pollResult({ captchaId, apiKey, logger }) {
  const start = Date.now()
  // Initial wait — solves rarely finish in <10s, polling sooner just wastes calls.
  await sleep(POLL_INTERVAL_MS)

  while (Date.now() - start < MAX_POLL_MS) {
    const params = new URLSearchParams({
      key: apiKey,
      action: 'get',
      id: captchaId,
      json: '1',
    })
    const res = await fetch(`${TWOCAPTCHA_BASE}/res.php?${params}`)
    const data = /** @type {{status: number, request: string}} */ (await res.json())
    if (data.status === 1) return data.request

    // 2Captcha returns the literal string 'CAPCHA_NOT_READY' (sic) while the
    // job is in flight. Anything else under status=0 is terminal.
    if (data.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2Captcha solve failed: ${data.request}`)
    }
    logger.debug?.({ captchaId, elapsedMs: Date.now() - start }, '[captcha] still solving')
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`2Captcha solve timed out after ${MAX_POLL_MS}ms`)
}

/**
 * Solve a captcha via 2Captcha's HTTP API. Returns null when the API key
 * isn't configured (caller decides whether to skip the item or proceed). Throws
 * on solve failure — caller should catch and route to `captcha_failed` (which
 * is non-retryable per spec §7.9).
 *
 * @param {{
 *   type: CaptchaType,
 *   siteKey: string,
 *   pageUrl: string,
 *   apiKey?: string,
 *   logger?: { info: Function, debug: Function, warn: Function }
 * }} args
 * @returns {Promise<SolveResult | null>}
 */
export async function solveCaptcha({
  type,
  siteKey,
  pageUrl,
  apiKey = process.env.TWOCAPTCHA_API_KEY,
  logger = console,
}) {
  if (!apiKey) return null
  if (!METHOD[type]) throw new Error(`Unsupported captcha type: ${type}`)
  if (!siteKey) throw new Error(`Missing siteKey for ${type}`)

  const start = Date.now()
  const captchaId = await submitJob({ type, siteKey, pageUrl, apiKey })
  logger.info?.({ type, captchaId, pageUrl }, '[captcha] submitted to 2Captcha')

  const token = await pollResult({ captchaId, apiKey, logger })
  const elapsedMs = Date.now() - start
  logger.info?.(
    { type, captchaId, elapsedMs, costCents: APPROX_COST_CENTS[type] },
    '[captcha] solved',
  )

  return {
    token,
    costCents: APPROX_COST_CENTS[type],
    elapsedMs,
    captchaId,
  }
}

/**
 * Inject a solved captcha token into the page so the form's submit handler
 * sees a valid response. Per spec §7.7, this is where most form-fill projects
 * die — different captcha vendors expect tokens in different places, and SPAs
 * can re-bind their form handlers between page-load and our inject.
 *
 * Best-effort — if the page doesn't have the expected DOM, the inject is a
 * no-op and the form's own captcha widget will still be unsolved. The submit
 * will then fail and the item gets marked `captcha_failed`.
 *
 * @param {{
 *   page: import('playwright').Page,
 *   type: CaptchaType,
 *   token: string,
 *   logger?: { debug: Function, warn: Function }
 * }} args
 */
export async function injectCaptchaToken({ page, type, token, logger = console }) {
  if (!token) return

  if (type === 'recaptcha_v2') {
    await page
      .evaluate((t) => {
        // Standard target — the hidden textarea reCAPTCHA renders for every
        // form. Many sites' submit validation reads only this value.
        const ta = document.getElementById('g-recaptcha-response')
        if (ta) {
          ta.innerHTML = t
          // Some themes hide the textarea visually; making it visible is
          // harmless and helps frameworks that check `!textarea.value`.
          if (ta instanceof HTMLElement) ta.style.display = ''
        }
        // Some integrations skip the textarea and call a callback() in the
        // grecaptcha config. Walk the structure best-effort.
        // @ts-expect-error grecaptcha is global
        const cfg = window.___grecaptcha_cfg
        if (cfg && cfg.clients) {
          for (const cid of Object.keys(cfg.clients)) {
            const client = cfg.clients[cid]
            for (const k of Object.keys(client)) {
              const branch = client[k]
              if (!branch || typeof branch !== 'object') continue
              for (const sk of Object.keys(branch)) {
                const node = branch[sk]
                if (node && typeof node.callback === 'function') {
                  try {
                    node.callback(t)
                  } catch {
                    /* swallow — many entries aren't real callbacks */
                  }
                }
              }
            }
          }
        }
      }, token)
      .catch((err) => logger.warn?.({ err: String(err) }, '[captcha] v2 inject errored'))
    return
  }

  if (type === 'recaptcha_v3') {
    // v3 is invisible; the form calls grecaptcha.execute() to fetch a token
    // right before submit. Stub it so it returns our pre-solved token. Also
    // pre-fill any hidden input the form might already wire to.
    await page
      .evaluate((t) => {
        // @ts-expect-error grecaptcha is global
        window.grecaptcha = window.grecaptcha || {}
        // @ts-expect-error stub
        window.grecaptcha.execute = () => Promise.resolve(t)
        // @ts-expect-error stub
        window.grecaptcha.ready = (cb) => (typeof cb === 'function' ? cb() : undefined)
        for (const el of Array.from(
          document.querySelectorAll(
            'input[name="g-recaptcha-response"], textarea[name="g-recaptcha-response"]',
          ),
        )) {
          /** @type {any} */ (el).value = t
        }
      }, token)
      .catch((err) => logger.warn?.({ err: String(err) }, '[captcha] v3 inject errored'))
    return
  }

  if (type === 'hcaptcha') {
    await page
      .evaluate((t) => {
        for (const el of Array.from(
          document.querySelectorAll(
            'textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]',
          ),
        )) {
          /** @type {any} */ (el).value = t
        }
      }, token)
      .catch((err) => logger.warn?.({ err: String(err) }, '[captcha] hcaptcha inject errored'))
    return
  }

  if (type === 'turnstile') {
    await page
      .evaluate((t) => {
        for (const el of Array.from(
          document.querySelectorAll(
            'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
          ),
        )) {
          /** @type {any} */ (el).value = t
        }
      }, token)
      .catch((err) => logger.warn?.({ err: String(err) }, '[captcha] turnstile inject errored'))
    return
  }

  logger.warn?.({ type }, '[captcha] no injector for type — skipping')
}
