import * as cheerio from 'cheerio'

/**
 * @typedef {{
 *   selector: string,
 *   tag: 'input' | 'textarea' | 'select',
 *   type: string,
 *   name: string | null,
 *   id: string | null,
 *   placeholder: string | null,
 *   label: string,
 *   required: boolean
 * }} FormField
 *
 * @typedef {{
 *   formHtml: string,
 *   submitSelector: string,
 *   formBuilder: string,
 *   formScope: string,
 *   fields: FormField[]
 * } | null} ExtractedForm
 */

// Body-text and action-attr signals that mark a form as a newsletter signup,
// not a contact form. Drop these.
const NEWSLETTER_KEYWORDS =
  /\b(subscribe|newsletter|mailing[-\s]?list|stay[-\s]?up[-\s]?to[-\s]?date|join (our|the) (list|community)|early access)\b/i
const NEWSLETTER_ACTION_HOSTS =
  /mailchimp|us\d+\.list-manage|substack|convertkit|aweber|constantcontact|sendinblue|getresponse|klaviyo/i

// Input types we don't fill — hidden carries CSRF tokens, file uploads are
// out-of-scope per spec §9, etc. Keep the set tight.
const SKIP_INPUT_TYPES = new Set([
  'hidden', 'submit', 'button', 'reset', 'image', 'file', 'password',
])

// Builders that render the form inside a same-origin-blocked iframe. Plain
// HTML scrape can't see the form's fields. Discovery flags + bails; the
// LLM-mapping step (step 8) and Playwright-based submission (step 5+) handle
// these paths.
const IFRAME_ONLY_BUILDERS = new Set(['hubspot', 'typeform'])

/**
 * Identify the form-builder. Returns 'native' when no known signature matches.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {string} html
 * @returns {string}
 */
function detectFormBuilder($, html) {
  if (/hbspt\.forms\.create|js\.hsforms\.net/.test(html) || $('.hs-form').length > 0) return 'hubspot'
  if ($('iframe[src*="typeform.com"]').length > 0) return 'typeform'
  if ($('.gform_wrapper').length > 0) return 'gravity'
  if ($('.wpforms-form, .wpforms-container').length > 0) return 'wpforms'
  if ($('.wpcf7, .wpcf7-form').length > 0) return 'contact_form_7'
  if ($('[data-wf-page], .w-form').length > 0) return 'webflow'
  if (/formstack\.com/.test(html)) return 'formstack'
  if ($('.jotform-form').length > 0 || /jotform\.com\/(form|jsform)/.test(html)) return 'jotform'
  return 'native'
}

/**
 * Walk a form's ancestor chain to detect inline-style or class-based hiding.
 * Sites with multiple forms (e.g. WPForms hidden alongside a popup-modal
 * form) score as high as the visible one because static HTML parsing can't
 * see computed styles — but inline `style="display:none"` and well-known
 * "hidden" class names are reachable. Forms living inside such containers
 * are almost always the wrong target.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Element} formEl
 * @returns {boolean}
 */
function isInsideHiddenContainer($, formEl) {
  let $el = $(formEl)
  for (let i = 0; i < 12 && $el.length && $el[0] && $el[0].tagName !== 'body'; i++) {
    const style = ($el.attr('style') || '').toLowerCase().replace(/\s+/g, '')
    if (/display:none/.test(style)) return true
    if (/visibility:hidden/.test(style)) return true
    const cls = ($el.attr('class') || '').toLowerCase()
    if (/(^|\s)(hidden|d-none|invisible|sr-only|visually-hidden)(\s|$)/.test(cls)) return true
    if ($el.attr('hidden') !== undefined) return true
    if ($el.attr('aria-hidden') === 'true') return true
    $el = $el.parent()
  }
  return false
}

/**
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Element} formEl
 * @returns {number} score; -1 if explicitly excluded (newsletter), 0 if neutral
 */
function scoreForm($, formEl) {
  const $form = $(formEl)
  const action = ($form.attr('action') || '').toLowerCase()
  const text = $form.text().toLowerCase()

  if (NEWSLETTER_KEYWORDS.test(text)) return -1
  if (NEWSLETTER_ACTION_HOSTS.test(action)) return -1

  let score = 0
  // Forms hidden behind display:none / .hidden / aria-hidden almost always
  // belong to widget machinery (lightboxes, alternate states) rather than
  // the form a real visitor would interact with. Penalize hard so visible
  // forms always win when both exist on the page.
  if (isInsideHiddenContainer($, formEl)) score -= 4

  // Email is the strongest signal — every contact form has one. Match across
  // name, id, placeholder, aria-label, and autocomplete because builder-
  // generated forms (GoDaddy WB, Wix, Squarespace) often skip semantic name
  // attributes and only expose intent via placeholder or aria-label.
  if (
    $form.find(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i], input[aria-label*="email" i], input[autocomplete*="email" i]',
    ).length > 0
  ) {
    score += 3
  }
  // Textarea ~= message field; near-universal for contact forms.
  if ($form.find('textarea').length > 0) score += 3
  // Name field
  if (
    $form.find(
      'input[name*="name" i], input[id*="name" i], input[placeholder*="name" i], input[aria-label*="name" i], input[autocomplete*="name" i]',
    ).length > 0
  ) {
    score += 2
  }
  // Phone
  if (
    $form.find(
      'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[placeholder*="phone" i], input[aria-label*="phone" i], input[autocomplete*="tel" i]',
    ).length > 0
  ) {
    score += 1
  }
  // Company / organization
  if (
    $form.find(
      'input[name*="company" i], input[name*="organization" i], input[id*="company" i], input[placeholder*="company" i], input[aria-label*="company" i], input[autocomplete*="organization" i]',
    ).length > 0
  ) {
    score += 1
  }

  // Surrounding language nudges. Trades & B2B sites often head their form
  // with "request a quote" / "free estimate" instead of "contact" — same
  // intent, different vocabulary.
  if (
    /\b(contact|get in touch|reach out|how can we help|send (us )?(a )?message|inquiry|request (?:a |an )?(?:quote|estimate)|free (?:quote|estimate)|tell us about your project)\b/i.test(
      text,
    )
  ) {
    score += 2
  }

  return score
}

/**
 * Escape a value for use inside a CSS attribute selector's double-quoted
 * string: backslash-escape \ and ".
 *
 * @param {string} value
 */
function escapeAttr(value) {
  return String(value).replace(/[\\"]/g, '\\$&')
}

/**
 * Build a Playwright/CSS selector for an `id` attribute. Prefers the bare
 * `#id` form when the id is a valid CSS identifier; falls back to
 * `[id="..."]` attribute syntax when the id has a leading digit, leading
 * hyphen, or contains characters CSS doesn't allow without escaping. Duda
 * (`id="1995151138"`) and similar builders emit purely-numeric ids that
 * blow up Playwright's `#1995151138` parser as `not a valid selector` —
 * the attribute form sidesteps the rules entirely.
 *
 * @param {string} id
 */
function buildIdSelector(id) {
  if (/^[A-Za-z_][\w-]*$/.test(id)) {
    return `#${id}`
  }
  return `[id="${String(id).replace(/[\\"]/g, '\\$&')}"]`
}

/**
 * Conservative CSS identifier escape. Used by buildFormScope where we still
 * want the `form#id` shorthand for readability when the id is plain. For
 * field selectors prefer buildIdSelector, which falls back to attribute
 * syntax when the id is unsafe.
 *
 * @param {string} value
 */
function cssEscapeIdent(value) {
  return String(value).replace(/[^\w-]/g, (c) => `\\${c}`)
}

/**
 * Build a CSS selector that uniquely identifies the chosen form on the page.
 * Used as a scoping prefix for field selectors when a bare [name=...] is
 * ambiguous (e.g. newsletter + contact form on the same page).
 *
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Element} formEl
 */
function buildFormScope($, formEl) {
  const $form = $(formEl)
  const id = $form.attr('id')
  if (id) {
    // Prefer the readable `form#id` shorthand when the id is a clean CSS
    // identifier; fall back to attribute syntax for numeric / oddly-shaped ids.
    if (/^[A-Za-z_][\w-]*$/.test(id)) return `form#${id}`
    return `form[id="${escapeAttr(id)}"]`
  }
  const action = $form.attr('action')
  if (action) return `form[action="${escapeAttr(action)}"]`
  // Fall back: assume the page's single form is ours. Less robust but a
  // reasonable default for small-business sites.
  return 'form'
}

/**
 * Page-unique CSS selector for a single form field. Prefers [name=...] when
 * unique, else #id, else falls back to scoping under formScope.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Element} fieldEl
 * @param {string} formScope
 */
function buildFieldSelector($, fieldEl, formScope) {
  const $field = $(fieldEl)
  const tag = (fieldEl.tagName || 'input').toLowerCase()
  const name = $field.attr('name')
  const id = $field.attr('id')
  // GoDaddy Website Builder regenerates `id="input53420"` on every page render,
  // so an id-anchored selector cached at discovery time won't match at submit
  // time. The same builder emits a stable `data-aid="CONTACT_FORM_NAME"` /
  // `…_EMAIL` / `…_PHONE` / `…_MESSAGE` attribute we can pin to instead.
  const dataAid = $field.attr('data-aid')

  if (name) {
    const bare = `${tag}[name="${escapeAttr(name)}"]`
    if ($(bare).length === 1) return bare
    return `${formScope} ${bare}`
  }

  if (dataAid) {
    const bare = `${tag}[data-aid="${escapeAttr(dataAid)}"]`
    if ($(bare).length === 1) return bare
    return `${formScope} ${bare}`
  }

  if (id) {
    const bare = buildIdSelector(id)
    if ($(bare).length === 1) return bare
    return `${formScope} ${bare}`
  }

  // No anchor — positional fallback within the form. Fragile, low-confidence.
  return `${formScope} ${tag}`
}

/**
 * Find the human-readable label for a field. Tries `label[for=id]`, then
 * wrapping `<label>`, then `aria-label`. Returns empty string when nothing
 * obvious exists.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Element} fieldEl
 */
function findLabel($, fieldEl) {
  const $field = $(fieldEl)
  const id = $field.attr('id')
  if (id) {
    const $label = $(`label[for="${escapeAttr(id)}"]`)
    if ($label.length) return $label.text().trim()
  }
  const $wrapping = $field.parents('label').first()
  if ($wrapping.length) {
    // Wrapping label includes the input's own text; strip the input's
    // value/placeholder if it accidentally got pulled in.
    return $wrapping.text().trim()
  }
  const aria = $field.attr('aria-label')
  if (aria) return aria.trim()
  return ''
}

/**
 * Detect honeypot inputs — fields styled to be invisible to humans but visible
 * to bots. Filling them flags the submission as automated; server-side handlers
 * typically reject (or silently drop) the form. Common fingerprints:
 *   - aria-hidden="true"   — no real form field should be hidden from screen readers
 *   - tabindex="-1"        — real fields belong in tab order
 *   - off-screen positioning (e.g. left:-10000px) via inline style
 *   - 1px × 1px inline-styled box
 *
 * Any one signal is enough — these are intentional bot-trap markers and don't
 * appear on legitimate contact-form fields.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Element} fieldEl
 * @returns {boolean}
 */
function isHoneypot($, fieldEl) {
  const $el = $(fieldEl)
  if ($el.attr('aria-hidden') === 'true') return true
  if ($el.attr('tabindex') === '-1') return true
  const style = ($el.attr('style') || '').toLowerCase().replace(/\s+/g, '')
  if (!style) return false
  // Off-screen via large negative offset (≥3 digits of pixels) on an absolutely
  // or fixed-positioned element. The 3-digit threshold avoids false positives
  // on legitimate negative margins (e.g. -2px borders).
  if (/position:(absolute|fixed)/.test(style) && /(left|top|right|bottom):-\d{3,}/.test(style)) {
    return true
  }
  // 1px × 1px collapsed boxes — real fields render at meaningful sizes.
  if (/width:1px/.test(style) && /height:1px/.test(style)) return true
  // display:none or visibility:hidden inline — covers the simpler-but-rarer pattern.
  if (/display:none/.test(style)) return true
  if (/visibility:hidden/.test(style)) return true
  return false
}

/**
 * Walk the form's input/textarea/select elements and produce metadata the
 * field-mapper consumes.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Element} formEl
 * @param {string} formScope
 * @returns {FormField[]}
 */
function extractFields($, formEl, formScope) {
  const $form = $(formEl)
  /** @type {FormField[]} */
  const fields = []

  $form.find('input, textarea, select').each((_, el) => {
    const $el = $(el)
    const tag = /** @type {'input' | 'textarea' | 'select'} */ ((el.tagName || 'input').toLowerCase())
    const type = (($el.attr('type') || '').toLowerCase()) || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')

    if (tag === 'input' && SKIP_INPUT_TYPES.has(type)) return
    if (isHoneypot($, el)) return

    fields.push({
      selector: buildFieldSelector($, el, formScope),
      tag,
      type,
      name: $el.attr('name') ?? null,
      id: $el.attr('id') ?? null,
      placeholder: $el.attr('placeholder') ?? null,
      label: findLabel($, el),
      required: $el.attr('required') !== undefined,
    })
  })

  return fields
}

/**
 * Locate the submit button (or input[type=submit]) and produce a page-unique
 * selector for it.
 *
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Element} formEl
 * @param {string} formScope
 * @returns {string}
 */
function findSubmitSelector($, formEl, formScope) {
  const $form = $(formEl)
  // Prefer explicit type=submit
  const $submit = $form
    .find('button[type="submit"], input[type="submit"]')
    .first()
  if ($submit.length) {
    const id = $submit.attr('id')
    if (id) {
      // buildIdSelector falls back to `[id="..."]` for non-CSS-safe ids
      // (numeric / leading-digit Duda-style ids that crash Playwright's
      // `#1995151138` parser).
      const bare = buildIdSelector(id)
      if ($(bare).length === 1) return bare
    }
    return `${formScope} ${$submit[0].tagName.toLowerCase()}[type="submit"]`
  }

  // Fall back: any button inside the form
  const $btn = $form.find('button').first()
  if ($btn.length) return `${formScope} button`

  // Last resort: dispatch via form.submit() — surface a synthetic selector
  // the submission worker recognizes.
  return `${formScope}::submit`
}

/**
 * Find the most plausible contact form on the page and extract the fields the
 * field-mapper needs. Returns null when no form scores high enough or when
 * the form is in an iframe-only builder we can't read directly.
 *
 * @param {string} html
 * @returns {ExtractedForm}
 */
export function extractContactForm(html) {
  const $ = cheerio.load(html)
  const builder = detectFormBuilder($, html)

  // HubSpot/Typeform render in cross-origin iframes; we can't see the inner
  // HTML from a plain fetch. The submission worker (Playwright) handles those
  // via iframe support; discovery bails for now.
  if (IFRAME_ONLY_BUILDERS.has(builder)) {
    return null
  }

  const forms = $('form').toArray()
  const scored = forms
    .map((formEl) => ({ formEl, score: scoreForm($, formEl), hasTextarea: $(formEl).find('textarea').length > 0 }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)

  // Threshold: a textarea is a strong contact-form signal on its own (search
  // and newsletter forms don't have one). When present, accept score ≥ 3 —
  // this admits opaque builder-generated forms (GoDaddy WB and similar) that
  // strip semantic name attributes; the LLM field-mapper takes the swing on
  // those. Without a textarea, keep the original ≥ 5 bar.
  if (scored.length === 0) return null
  const top = scored[0]
  const minScore = top.hasTextarea ? 3 : 5
  if (top.score < minScore) return null

  const formEl = top.formEl
  const $form = $(formEl)
  const formScope = buildFormScope($, formEl)

  return {
    formHtml: $.html(formEl),
    submitSelector: findSubmitSelector($, formEl, formScope),
    formBuilder: builder,
    formScope,
    fields: extractFields($, formEl, formScope),
  }
}
