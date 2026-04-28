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

  // reCAPTCHA v2 — explicit `.g-recaptcha` div with data-sitekey
  const v2 = $('.g-recaptcha[data-sitekey], div[data-sitekey][class*="g-recaptcha"]').first()
  if (v2.length) {
    return { type: 'recaptcha_v2', siteKey: v2.attr('data-sitekey') ?? null }
  }

  // reCAPTCHA v3 — invoked from JS via grecaptcha.execute('SITEKEY', ...).
  // Also catches grecaptcha.render(..., { sitekey: 'SITEKEY' }) for v2-invisible.
  const scriptText = $('script')
    .toArray()
    .map((el) => $(el).html() || '')
    .join('\n')
  const v3 =
    scriptText.match(/grecaptcha\.execute\s*\(\s*['"]([\w-]+)['"]/) ||
    scriptText.match(/grecaptcha\.render\s*\([^)]*sitekey\s*[:=]\s*['"]([\w-]+)['"]/)
  if (v3) {
    return { type: 'recaptcha_v3', siteKey: v3[1] ?? null }
  }

  // hCaptcha
  const hCap = $('.h-captcha[data-sitekey], div[data-sitekey][class*="h-captcha"]').first()
  if (hCap.length) {
    return { type: 'hcaptcha', siteKey: hCap.attr('data-sitekey') ?? null }
  }

  // Cloudflare Turnstile
  const turn = $('.cf-turnstile[data-sitekey], div[data-sitekey][class*="cf-turnstile"]').first()
  if (turn.length) {
    return { type: 'turnstile', siteKey: turn.attr('data-sitekey') ?? null }
  }

  return null
}
