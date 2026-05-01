import * as cheerio from 'cheerio'

/**
 * @typedef {{ type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile', siteKey: string | null }} CaptchaInfo
 */

/**
 * Detect whether a contact page hosts a known captcha vendor and extract its
 * sitekey. Operates on the full page HTML — captcha widgets are often outside
 * the form element, attached at body-level via JS.
 *
 * Returns null if no captcha is detected.
 *
 * @param {string} html
 * @returns {CaptchaInfo | null}
 */
export function detectCaptcha(html) {
  const $ = cheerio.load(html)

  // Build two haystacks once: the full source of inline scripts (for
  // grecaptcha.execute / hcaptcha.render style calls) and the concatenated
  // src URLs of remote scripts (for `api.js?render=KEY` URL params used by
  // reCAPTCHA v3 and some hCaptcha integrations).
  const scriptText = $('script')
    .toArray()
    .map((el) => $(el).html() || '')
    .join('\n')
  const scriptSrcs = $('script[src]')
    .toArray()
    .map((el) => $(el).attr('src') || '')
    .join('\n')

  // ── reCAPTCHA v2 ─────────────────────────────────────────────────────────
  // Explicit `.g-recaptcha` widget div with data-sitekey.
  const v2 = $('.g-recaptcha[data-sitekey], div[data-sitekey][class*="g-recaptcha"]').first()
  if (v2.length) {
    return { type: 'recaptcha_v2', siteKey: v2.attr('data-sitekey') ?? null }
  }

  // ── reCAPTCHA v3 ─────────────────────────────────────────────────────────
  // 3 places the sitekey can live, in priority order:
  //   1. Script src URL parameter — `<script src=".../api.js?render=KEY">`.
  //      This is the most reliable signal: GoDaddy WB and many enterprise
  //      sites SSR exactly this script tag with the sitekey in the URL.
  //   2. Inline JS calling grecaptcha.execute('KEY', …).
  //   3. Inline JS calling grecaptcha.render(…, { sitekey: 'KEY' }).
  const v3SrcMatch = scriptSrcs.match(
    /(?:google\.com|gstatic\.com|recaptcha\.net)\/recaptcha\/(?:api|enterprise)\.js[^"'\s]*[?&]render=([\w-]+)/i,
  )
  const v3InlineExec = scriptText.match(/grecaptcha(?:\.enterprise)?\.execute\s*\(\s*['"]([\w-]+)['"]/)
  const v3InlineRender = scriptText.match(
    /grecaptcha(?:\.enterprise)?\.render\s*\([^)]*sitekey\s*[:=]\s*['"]([\w-]+)['"]/,
  )
  const v3 = v3SrcMatch || v3InlineExec || v3InlineRender
  if (v3) {
    return { type: 'recaptcha_v3', siteKey: v3[1] ?? null }
  }

  // ── hCaptcha ─────────────────────────────────────────────────────────────
  // 4 detection paths, in priority order:
  //   1. Widget div with data-sitekey — the canonical pattern.
  //   2. Script src URL parameter — `<script src=".../api.js?sitekey=KEY">`
  //      or `…?render=KEY` (less common than reCAPTCHA's but exists).
  //   3. Inline JS calling hcaptcha.render(…, { sitekey: 'KEY' }).
  //   4. .h-captcha placeholder div WITHOUT data-sitekey but with a sitekey
  //      somewhere in surrounding inline JS / data attributes — common when
  //      the host SSRs the placeholder but injects the sitekey at runtime.
  const hCapWithKey = $('.h-captcha[data-sitekey], div[data-sitekey][class*="h-captcha"]').first()
  if (hCapWithKey.length) {
    return { type: 'hcaptcha', siteKey: hCapWithKey.attr('data-sitekey') ?? null }
  }
  const hCapSrcMatch = scriptSrcs.match(
    /js\.hcaptcha\.com\/1\/api\.js[^"'\s]*[?&](?:sitekey|render)=([\w-]+)/i,
  )
  if (hCapSrcMatch) {
    return { type: 'hcaptcha', siteKey: hCapSrcMatch[1] ?? null }
  }
  const hCapInlineRender = scriptText.match(
    /hcaptcha\.render\s*\([^)]*sitekey\s*[:=]\s*['"]([\w-]+)['"]/,
  )
  if (hCapInlineRender) {
    return { type: 'hcaptcha', siteKey: hCapInlineRender[1] ?? null }
  }
  // Last-ditch: placeholder div present but no sitekey discoverable in the
  // static snapshot. Surface as `siteKey: null` so the caller knows a captcha
  // exists (and can decide to skip vs. force-browser) — better than missing
  // it entirely.
  const hCapPlaceholder = $('.h-captcha').first()
  if (hCapPlaceholder.length) {
    return { type: 'hcaptcha', siteKey: null }
  }

  // ── Cloudflare Turnstile ─────────────────────────────────────────────────
  const turn = $('.cf-turnstile[data-sitekey], div[data-sitekey][class*="cf-turnstile"]').first()
  if (turn.length) {
    return { type: 'turnstile', siteKey: turn.attr('data-sitekey') ?? null }
  }
  const turnInlineRender = scriptText.match(
    /turnstile\.render\s*\([^)]*sitekey\s*[:=]\s*['"]([\w-]+)['"]/,
  )
  if (turnInlineRender) {
    return { type: 'turnstile', siteKey: turnInlineRender[1] ?? null }
  }
  const turnPlaceholder = $('.cf-turnstile').first()
  if (turnPlaceholder.length) {
    return { type: 'turnstile', siteKey: null }
  }

  return null
}
