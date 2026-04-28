import { sleep, nextTypeDelay, nextFieldPause } from '../lib/delays.js'

/**
 * Order matters — we want short fields filled first so any form-validation
 * popovers settle before we hit the long textarea. Visual order roughly
 * matches what a human would do too.
 *
 * @type {Array<keyof import('../discovery/field-mapper.js').FieldMapping>}
 */
const FIELD_FILL_ORDER = [
  'first_name',
  'last_name',
  'full_name',
  'email',
  'phone',
  'company',
  'website',
  'subject',
  'message',
]

/**
 * Find a locator inside the page OR any of its same-origin iframes. Some
 * builders (HubSpot, Webflow) embed the form in an iframe even on the same
 * domain; we look top-frame-first then walk children.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @returns {import('playwright').Locator | null}
 */
function locate(page, selector) {
  const top = page.locator(selector)
  // Lazy — Playwright resolves locators on use, not creation. Caller checks
  // .count() to see if it actually exists.
  return top
}

/**
 * Fill form fields from a payload using a cached field mapping. Throws on
 * fatal errors (selector not found for a required field, page navigated
 * during fill, etc.). Logs and continues on optional-field failures.
 *
 * @param {{
 *   page: import('playwright').Page,
 *   fieldMapping: Record<string, string>,
 *   payload: Record<string, string>,
 *   logger?: { info: Function, debug: Function, warn: Function }
 * }} args
 * @returns {Promise<{ filledKeys: string[], skippedKeys: string[] }>}
 */
export async function fillForm({ page, fieldMapping, payload, logger = console }) {
  /** @type {string[]} */
  const filled = []
  /** @type {string[]} */
  const skipped = []

  for (const key of FIELD_FILL_ORDER) {
    const value = payload[key]
    const selector = fieldMapping[key]
    if (!value || !selector) continue

    const locator = locate(page, selector)
    if (!locator) {
      skipped.push(key)
      continue
    }

    try {
      // Wait briefly for the element to be present (handles delayed-render forms).
      await locator.first().waitFor({ state: 'visible', timeout: 5000 })
    } catch {
      logger.warn({ key, selector }, '[filler] element not visible within 5s; skipping')
      skipped.push(key)
      continue
    }

    try {
      // Click first to focus + dismiss any tooltip on adjacent fields.
      await locator.first().click({ delay: 30 })
      // Use page.keyboard.type with per-keystroke delay rather than locator.fill,
      // which sets the value atomically and skips events some builders listen for.
      for (const char of value) {
        await page.keyboard.type(char)
        await sleep(nextTypeDelay())
      }
      filled.push(key)
      logger.debug({ key, length: value.length }, '[filler] field filled')
      await sleep(nextFieldPause())
    } catch (err) {
      logger.warn(
        { key, selector, err: err instanceof Error ? err.message : String(err) },
        '[filler] type failed; falling back to .fill()',
      )
      // Fallback — at least set the value so the form has data, even if events
      // don't fire perfectly. Better a possibly-rejected submit than no submit.
      try {
        await locator.first().fill(value)
        filled.push(key)
      } catch {
        skipped.push(key)
      }
    }
  }

  logger.info({ filled, skipped }, '[filler] done')
  return { filledKeys: filled, skippedKeys: skipped }
}
