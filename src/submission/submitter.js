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

  // Wait for *something* to change. Race three positive signals.
  //
  // networkidle is deliberately NOT in the race: AJAX-submit forms (Gravity,
  // WPForms, Wix, HubSpot, …) leave the page already at networkidle when the
  // click fires, so waitForLoadState resolves in milliseconds — before the POST
  // has even gone out — and we classify a stale DOM as ambiguous_no_signal.
  let waitReason = 'timeout'
  try {
    await Promise.race([
      page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: POST_SUBMIT_TIMEOUT_MS }).then(() => {
        waitReason = 'url_change'
      }),
      page
        .waitForFunction(
          () => /thank|received|sent|submitted|success/i.test(document.body?.innerText ?? ''),
          { timeout: POST_SUBMIT_TIMEOUT_MS },
        )
        .then(() => {
          waitReason = 'success_text'
        }),
      // Form replaced/removed by JS — typical AJAX confirmation pattern.
      page
        .waitForFunction(
          () => document.querySelectorAll('form').length === 0,
          { timeout: POST_SUBMIT_TIMEOUT_MS },
        )
        .then(() => {
          waitReason = 'form_removed'
        }),
    ])
  } catch {
    // All three timed out — proceed to classify whatever we have.
    logger.warn({ beforeUrl, timeoutMs: POST_SUBMIT_TIMEOUT_MS }, '[submitter] post-submit wait timed out')
  }
  // Belt-and-suspenders: brief settle time so AJAX confirmations rendering
  // just after our signal have time to land in the DOM before we read text.
  await page.waitForTimeout(2000)
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
