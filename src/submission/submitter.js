import { classifyOutcome } from './outcome-detector.js'

const POST_SUBMIT_TIMEOUT_MS = 30000

/**
 * Click the submit button and classify the result. Caller is expected to have
 * already filled the form and captured a pre-submit screenshot.
 *
 * Honors a synthetic `${formScope}::submit` selector emitted by the extractor
 * when no submit button was found — falls back to dispatching `form.submit()`
 * directly via JS.
 *
 * @param {{
 *   page: import('playwright').Page,
 *   submitSelector: string,
 *   beforeUrl: string,
 *   logger?: { info: Function, debug: Function, warn: Function }
 * }} args
 * @returns {Promise<import('./outcome-detector.js').OutcomeResult>}
 */
export async function submitForm({ page, submitSelector, beforeUrl, logger = console }) {
  // Synthetic selector: extract the form scope, dispatch form.submit() in-page.
  if (submitSelector.endsWith('::submit')) {
    const formScope = submitSelector.slice(0, -'::submit'.length)
    logger.debug({ formScope }, '[submitter] using synthetic form.submit() dispatch')
    await page.evaluate((scope) => {
      const el = document.querySelector(scope)
      if (el && 'submit' in el && typeof el.submit === 'function') el.submit()
    }, formScope)
  } else {
    await page.locator(submitSelector).first().click({ delay: 50 })
  }

  // Wait for *something* to change. Race three signals.
  let waitReason = 'timeout'
  try {
    await Promise.race([
      page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: POST_SUBMIT_TIMEOUT_MS }).then(() => {
        waitReason = 'url_change'
      }),
      page.waitForLoadState('networkidle', { timeout: POST_SUBMIT_TIMEOUT_MS }).then(() => {
        waitReason = 'network_idle'
      }),
      page
        .waitForFunction(
          () => /thank|received|sent|submitted|success/i.test(document.body?.innerText ?? ''),
          { timeout: POST_SUBMIT_TIMEOUT_MS },
        )
        .then(() => {
          waitReason = 'success_text'
        }),
    ])
  } catch {
    // All three timed out — proceed to classify whatever we have.
    logger.warn({ beforeUrl, timeoutMs: POST_SUBMIT_TIMEOUT_MS }, '[submitter] post-submit wait timed out')
  }
  logger.debug({ waitReason }, '[submitter] post-submit settled')

  const afterUrl = page.url()
  // page.locator('form') matches *any* form, including replacements. We want
  // to know if the original is still around; in practice if any form is gone
  // and another took its place that's still typically a success swap. Using
  // count() === 0 as a coarse proxy is good enough for v1.
  const formStillPresent = (await page.locator('form').count()) > 0
  const afterText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')

  return classifyOutcome({ beforeUrl, afterUrl, afterText, formStillPresent })
}
