/**
 * @typedef {'success' | 'failed' | 'ambiguous'} OutcomeStatus
 *
 * @typedef {{
 *   status: OutcomeStatus,
 *   indicator: string,
 *   detail?: string
 * }} OutcomeResult
 */

const SUCCESS_PHRASES = [
  /\bthank(?:s| you)\b/i,
  /\bwe(?:'| ?)ll be in touch\b/i,
  /\bmessage (?:sent|received|submitted)\b/i,
  /\b(?:your )?submission (?:has been )?received\b/i,
  /\bwe(?:'| ?)ve received your\b/i,
  /\bsuccessfully (?:sent|submitted|received)\b/i,
  /\bgot your message\b/i,
  /\bwe(?:'| ?)ll get back to you\b/i,
  /\bsubmission successful\b/i,
]

const SUCCESS_URL_PATTERNS = [
  /\/thank[-_]?you\b/i,
  /\/thanks\b/i,
  /\/success\b/i,
  /\/submitted\b/i,
  /\/received\b/i,
  /[?&]submitted=(true|1)\b/i,
]

const ERROR_PHRASES = [
  /\bplease (?:enter|provide|fill in|complete)\b/i,
  /\bthis field is required\b/i,
  /\binvalid (?:email|phone|input)\b/i,
  /\bsomething went wrong\b/i,
  /\bunable to (?:send|submit)\b/i,
  /\bthere (?:was|were) (?:an? )?(?:errors?|problems?)\b/i,
  /\bcaptcha (?:failed|verification)\b/i,
]

/**
 * Classify the post-submit page. Inputs are intentionally minimal:
 *   - The URL we landed on (for success-path redirects).
 *   - The full body text (lowercased).
 *   - Whether the original form is still in the DOM (form removal is a strong
 *     success signal even when nothing replaced it visually).
 *
 * @param {{
 *   beforeUrl: string,
 *   afterUrl: string,
 *   afterText: string,
 *   formStillPresent: boolean
 * }} args
 * @returns {OutcomeResult}
 */
export function classifyOutcome({ beforeUrl, afterUrl, afterText, formStillPresent }) {
  // 1. URL-based redirect to a thank-you path is the cleanest signal.
  if (beforeUrl !== afterUrl) {
    for (const re of SUCCESS_URL_PATTERNS) {
      if (re.test(afterUrl)) {
        return { status: 'success', indicator: 'redirect', detail: afterUrl }
      }
    }
  }

  // 2. Confirmation language in body text.
  for (const re of SUCCESS_PHRASES) {
    if (re.test(afterText)) {
      return {
        status: 'success',
        indicator: 'confirmation_text',
        detail: afterText.match(re)?.[0],
      }
    }
  }

  // 3. Form removed from DOM, no errors visible — typical AJAX-replace pattern.
  if (!formStillPresent) {
    const errored = ERROR_PHRASES.some((re) => re.test(afterText))
    if (!errored) {
      return { status: 'success', indicator: 'form_disappeared' }
    }
  }

  // 4. Validation/error language wins over silence.
  for (const re of ERROR_PHRASES) {
    if (re.test(afterText)) {
      return { status: 'failed', indicator: 'error_text', detail: afterText.match(re)?.[0] }
    }
  }

  // 5. URL changed but no thank-you keywords — could be a confirmation page
  // with custom copy. Mark ambiguous so the admin UI flags for review rather
  // than counting it as silent success.
  if (beforeUrl !== afterUrl) {
    return { status: 'ambiguous', indicator: 'url_changed_no_phrases', detail: afterUrl }
  }

  return { status: 'ambiguous', indicator: 'no_signal' }
}
