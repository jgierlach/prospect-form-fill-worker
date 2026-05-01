import { fetchHtml } from '../lib/fetchHtml.js'
import { fetchHtmlBrowser } from '../lib/fetchHtmlBrowser.js'
import { detectSpaBuilder } from '../lib/spaDetector.js'
import { resolveContactUrl } from './crawler.js'
import { extractContactForm } from './extractor.js'
import { mapFields } from './field-mapper.js'
import { mapFieldsViaLLM, hasRequiredKeys } from './llm-field-mapper.js'
import { detectCaptcha } from './captcha-detector.js'

/**
 * @typedef {{ info: Function, debug: Function, warn: Function, error: Function }} Logger
 *
 * @typedef {{
 *   status: 'success',
 *   contactUrl: string,
 *   formHtml: string,
 *   fieldMapping: import('./field-mapper.js').FieldMapping,
 *   submitSelector: string,
 *   formBuilder: string,
 *   captchaType: string | null,
 *   captchaSiteKey: string | null,
 *   confidenceScore: number,
 *   mappingMethod: 'heuristic' | 'llm',
 *   llmTokensUsed?: number,
 *   needsProxy?: boolean
 * } | {
 *   status: 'failed',
 *   failureReason: 'no_contact_page' | 'fetch_failed' | 'no_form_found' | 'low_mapping_confidence' | 'iframe_only_builder',
 *   contactUrl?: string | null,
 *   formBuilder?: string | null,
 *   confidenceScore?: number,
 *   partialMapping?: import('./field-mapper.js').FieldMapping,
 *   needsProxy?: boolean
 * }} DiscoveryResult
 *
 * @typedef {{
 *   sourcedWebsiteId?: string | null,
 *   supabase?: import('@supabase/supabase-js').SupabaseClient | null,
 *   logger?: Logger,
 *   contactUrlOverride?: string | null,
 *   forceBrowser?: boolean
 * }} DiscoverOptions
 */

/**
 * Run discovery for a single domain. Pure function — no DB writes, no side
 * effects beyond network fetches. Persistence (`prospect_form_cache` insert,
 * `sourced_websites.contact_page_url` write-back) is the caller's job.
 *
 * @param {string} domain
 * @param {DiscoverOptions} [options]
 * @returns {Promise<DiscoveryResult>}
 */
export async function discoverDomain(domain, options = {}) {
  const logger = options.logger ?? console
  const forceBrowser = options.forceBrowser === true
  const supabase = options.supabase ?? null
  const sourcedWebsiteId = options.sourcedWebsiteId ?? null

  // Look up the cached "needs_proxy" verdict. If a previous discovery hit
  // the Decodo retry path, every fetch in this run skips the doomed direct
  // attempt and goes straight to proxy. Defensive: if the column doesn't
  // exist yet (pre-migration), fall back to the default.
  let cachedNeedsProxy = false
  if (sourcedWebsiteId && supabase) {
    const { data, error } = await supabase
      .from('sourced_websites')
      .select('needs_proxy')
      .eq('id', sourcedWebsiteId)
      .maybeSingle()
    if (error) {
      logger.debug?.(
        { sourcedWebsiteId, err: error.message },
        '[discovery] needs_proxy lookup failed (column may not exist yet) — defaulting to direct',
      )
    } else if (data?.needs_proxy === true) {
      cachedNeedsProxy = true
      logger.info?.({ domain, sourcedWebsiteId }, '[discovery] cached needs_proxy=true — routing all fetches through Decodo')
    }
  }
  /** @type {import('../lib/fetchHtml.js').FetchState} */
  const fetchState = { forceProxy: cachedNeedsProxy, usedProxy: false }
  const optionsWithState = { ...options, fetchState }

  // 1. Resolve contact URL — operator override skips crawling entirely.
  let contactUrl
  if (options.contactUrlOverride) {
    contactUrl = options.contactUrlOverride
    logger.info({ domain, contactUrl }, '[discovery] using operator-provided contactUrlOverride')
  } else {
    contactUrl = await resolveContactUrl(domain, optionsWithState)
    if (!contactUrl) {
      logger.info({ domain }, '[discovery] no contact page found')
      return { status: 'failed', failureReason: 'no_contact_page', needsProxy: fetchState.usedProxy }
    }
  }

  // 2. Fetch the contact page. Mirrors crawler's smart-fetch: try static
  // first, escalate to Playwright when fingerprint suggests a JS-rendered
  // builder (or unconditionally when forceBrowser is set).
  let html = forceBrowser ? null : await fetchHtml(contactUrl, { logger, fetchState })
  let usedBrowser = false
  if (forceBrowser) {
    logger.info({ domain, contactUrl }, '[discovery] forceBrowser=true — fetching contact page via Playwright')
    html = await fetchHtmlBrowser(contactUrl, { logger, fetchState })
    usedBrowser = true
  } else if (html && !extractContactForm(html) && detectSpaBuilder(html)) {
    const builder = detectSpaBuilder(html)
    logger.info({ domain, contactUrl, builder }, '[discovery] SPA builder detected on contact page — re-fetching via Playwright')
    const rendered = await fetchHtmlBrowser(contactUrl, { logger, fetchState })
    if (rendered) {
      html = rendered
      usedBrowser = true
    }
  }
  if (!html) {
    logger.info({ domain, contactUrl, usedBrowser }, '[discovery] contact page fetch failed')
    return { status: 'failed', failureReason: 'fetch_failed', contactUrl, needsProxy: fetchState.usedProxy }
  }
  logger.info(
    { domain, contactUrl, usedBrowser, htmlLength: html.length },
    '[discovery] contact page fetched',
  )

  // 3. Extract form
  const form = extractContactForm(html)
  if (!form) {
    // Distinguish between "no form" and "iframe-only builder we can't read".
    // detectFormBuilder is run again here cheaply (re-parse) only if useful.
    // Iframe-only builders host the form on a third-party origin we can't
    // statically extract or fill from the parent page. Detection fingerprints:
    //   - HubSpot:               hbspt.forms / js.hsforms.net
    //   - Typeform:              typeform.com (any subdomain)
    //   - Calendly / scheduler:  assets.calendly.com
    //   - GoHighLevel widget:    link.<host>.com/widget/form, leadconnectorhq
    //                            (used by handymanmarketingpros and many
    //                            white-label CRMs to embed lead-capture forms)
    //   - JotForm embed:         form.jotform.com / jotform.com/form
    const isIframeBuilder =
      /hbspt\.forms|js\.hsforms\.net|typeform\.com|assets\.calendly\.com|leadconnectorhq|link\.[\w-]+\.com\/widget\/form|form\.jotform\.com|jotform\.com\/form/i.test(html)
    const detectedBuilder = detectSpaBuilder(html)
    if (isIframeBuilder) {
      logger.info({ domain, contactUrl, usedBrowser }, '[discovery] iframe-only form builder; deferring to LLM mapper')
      return { status: 'failed', failureReason: 'iframe_only_builder', contactUrl, formBuilder: detectedBuilder, needsProxy: fetchState.usedProxy }
    }
    // Surface "we Playwright-fetched and STILL saw no <form>" — this is the
    // case where the operator should consider a contact-URL override (the
    // form may live on a different page than the homepage we landed on).
    logger.info(
      { domain, contactUrl, usedBrowser, detectedBuilder, hasFormTag: /<form\b/i.test(html) },
      '[discovery] no usable contact form on page',
    )
    return { status: 'failed', failureReason: 'no_form_found', contactUrl, formBuilder: detectedBuilder, needsProxy: fetchState.usedProxy }
  }

  // 4. Heuristic mapping first — free, fast, succeeds on plain HTML forms.
  const heuristic = mapFields(form.fields)
  let mapping = { ...heuristic.mapping }
  let confidence = heuristic.confidence
  /** @type {'heuristic' | 'llm'} */
  let mappingMethod = 'heuristic'
  let llmTokensUsed = 0

  // If the heuristic missed any of the three required keys (email, message,
  // a name), ask Claude. This is where wpforms[fields][N] / input_3 / similar
  // opaque field names get resolved.
  if (!hasRequiredKeys(heuristic.mapping) && process.env.ANTHROPIC_API_KEY) {
    try {
      const llm = await mapFieldsViaLLM({ formHtml: form.formHtml, logger })
      llmTokensUsed = llm.tokensUsed
      if (hasRequiredKeys(llm.mapping)) {
        // LLM produced a usable mapping — switch to it. Carry the LLM's
        // self-reported confidence so the cache row reflects which method
        // produced the result.
        mapping = { ...llm.mapping }
        confidence = llm.confidence
        mappingMethod = 'llm'
        logger.info(
          { domain, contactUrl, mappedKeys: Object.keys(llm.mapping).length, llmTokensUsed },
          '[discovery] LLM mapping accepted',
        )
      } else {
        logger.info(
          { domain, contactUrl, llmMapping: llm.mapping, llmTokensUsed },
          '[discovery] LLM mapping still missing required keys',
        )
      }
    } catch (err) {
      logger.warn(
        { domain, contactUrl, err: err instanceof Error ? err.message : String(err) },
        '[discovery] LLM mapper failed; falling back to heuristic result',
      )
    }
  }

  if (!hasRequiredKeys(mapping)) {
    logger.info(
      { domain, contactUrl, confidence, mapping, mappingMethod, llmTokensUsed },
      '[discovery] mapping missing required keys after both methods',
    )
    return {
      status: 'failed',
      failureReason: 'low_mapping_confidence',
      contactUrl,
      formBuilder: form.formBuilder,
      confidenceScore: confidence,
      partialMapping: mapping,
      needsProxy: fetchState.usedProxy,
    }
  }

  // 5. Detect captcha (full-page HTML, since widgets often live outside the form).
  //    If we see a placeholder div but no sitekey, the host is JS-injecting the
  //    sitekey at runtime — common on hCaptcha-protected SvelteKit/React forms
  //    and reCAPTCHA v3 sites. Re-fetch through Playwright once so the rendered
  //    DOM exposes the sitekey. Without it, submissions silently fail server-
  //    side because we never call 2Captcha.
  let captcha = detectCaptcha(html)
  if (captcha && !captcha.siteKey && !usedBrowser) {
    logger.info(
      { domain, contactUrl, captchaType: captcha.type },
      '[discovery] captcha placeholder without sitekey — re-fetching via browser to extract',
    )
    const rendered = await fetchHtmlBrowser(contactUrl, { logger, fetchState })
    if (rendered) {
      const browserCaptcha = detectCaptcha(rendered)
      if (browserCaptcha?.siteKey) {
        captcha = browserCaptcha
        logger.info(
          { domain, contactUrl, captchaType: browserCaptcha.type },
          '[discovery] captcha sitekey recovered via browser',
        )
      } else {
        logger.warn(
          { domain, contactUrl, captchaType: captcha.type },
          '[discovery] captcha sitekey still missing after browser re-fetch — submissions will likely fail',
        )
      }
    }
  }

  // Inject submit_button into the mapping for the submission worker — Playwright
  // clicks this selector to fire the form. Heuristic and LLM both leave this
  // out by default; the extractor's fallback selector is more reliable than
  // either since it's anchored on type=submit.
  mapping.submit_button = form.submitSelector

  return {
    status: 'success',
    contactUrl,
    formHtml: form.formHtml,
    fieldMapping: mapping,
    submitSelector: form.submitSelector,
    formBuilder: form.formBuilder,
    captchaType: captcha?.type ?? null,
    captchaSiteKey: captcha?.siteKey ?? null,
    mappingMethod,
    llmTokensUsed,
    confidenceScore: confidence,
    needsProxy: fetchState.usedProxy,
  }
}

/**
 * Persist a discovery result to Supabase: writes prospect_form_cache and
 * back-fills sourced_websites.contact_page_url (no `.is(null)` guard — the
 * worker's value is authoritative since it actually verified a form).
 *
 * Called by the polling loop (lands in step 5+ alongside batch wiring) and
 * the dev:discover CLI when --persist is passed.
 *
 * @param {{
 *   sourcedWebsiteId: string,
 *   result: DiscoveryResult,
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   logger?: Logger
 * }} args
 */
export async function persistDiscovery({ sourcedWebsiteId, result, supabase, logger = console }) {
  const now = new Date().toISOString()

  if (result.status === 'failed') {
    const { error } = await supabase
      .from('prospect_form_cache')
      .upsert(
        {
          sourced_website_id: sourcedWebsiteId,
          contact_url: result.contactUrl ?? '',
          form_html: '',
          field_mapping: result.partialMapping ?? {},
          submit_selector: '',
          form_builder: result.formBuilder ?? null,
          discovery_status: 'failed',
          discovery_failure_reason: result.failureReason,
          discovered_at: now,
          updated_at: now,
        },
        { onConflict: 'sourced_website_id' },
      )
    if (error) {
      logger.error({ sourcedWebsiteId, err: error.message }, '[persistDiscovery] failed-row upsert error')
      throw error
    }
    return
  }

  const { error: cacheErr } = await supabase
    .from('prospect_form_cache')
    .upsert(
      {
        sourced_website_id: sourcedWebsiteId,
        contact_url: result.contactUrl,
        form_html: result.formHtml,
        field_mapping: result.fieldMapping,
        submit_selector: result.submitSelector,
        form_builder: result.formBuilder,
        captcha_type: result.captchaType,
        captcha_site_key: result.captchaSiteKey,
        confidence_score: result.confidenceScore,
        discovery_status: 'success',
        discovery_failure_reason: null,
        discovered_at: now,
        updated_at: now,
      },
      { onConflict: 'sourced_website_id' },
    )
  if (cacheErr) {
    logger.error({ sourcedWebsiteId, err: cacheErr.message }, '[persistDiscovery] success-row upsert error')
    throw cacheErr
  }

  // Write-back to sourced_websites.contact_page_url. Worker-resolved value is
  // authoritative — it actually verified a form lives there.
  const { error: writebackErr } = await supabase
    .from('sourced_websites')
    .update({ contact_page_url: result.contactUrl })
    .eq('id', sourcedWebsiteId)
  if (writebackErr) {
    logger.warn({ sourcedWebsiteId, err: writebackErr.message }, '[persistDiscovery] contact_page_url writeback failed (non-fatal)')
  }

  // needs_proxy is a one-way ratchet: set true when this run had to fall back
  // to Decodo, so subsequent re-discoveries skip the ~10s doomed direct
  // attempt. Done in a separate UPDATE so a missing column (pre-migration)
  // doesn't take out the contact_page_url writeback above.
  if (result.needsProxy === true) {
    const { error: proxyErr } = await supabase
      .from('sourced_websites')
      .update({ needs_proxy: true })
      .eq('id', sourcedWebsiteId)
    if (proxyErr) {
      logger.warn(
        { sourcedWebsiteId, err: proxyErr.message },
        '[persistDiscovery] needs_proxy writeback failed (non-fatal — column may not exist yet pre-migration)',
      )
    }
  }
}
