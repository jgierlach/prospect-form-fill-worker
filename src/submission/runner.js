import os from 'node:os'
import { launchSession, closeSession } from './browser.js'
import { fillForm } from './filler.js'
import { submitForm } from './submitter.js'
import { captureAndUpload } from '../lib/screenshots.js'
import { claimItems } from '../queue/claim.js'
import { completeSuccess, completeFailure, completeSkipped } from '../queue/complete.js'
import { logStep } from '../queue/log.js'

const SUBMISSION_CONCURRENCY = parseInt(process.env.SUBMISSION_CONCURRENCY || '3', 10)
const SUBMISSION_TIMEOUT_MS = parseInt(process.env.SUBMISSION_TIMEOUT_MS || '120000', 10)
const WORKER_ID_PREFIX = process.env.WORKER_ID_PREFIX || 'hetzner-prospect-fill'
const WORKER_ID = `${WORKER_ID_PREFIX}-${os.hostname()}-${process.pid}`

/**
 * @typedef {import('../queue/claim.js').ClaimedItem} ClaimedItem
 *
 * @typedef {{
 *   id: string,
 *   dry_run: boolean
 * }} BatchRow
 *
 * @typedef {{
 *   sourced_website_id: string,
 *   contact_url: string,
 *   field_mapping: Record<string, string>,
 *   submit_selector: string,
 *   form_builder: string | null,
 *   captcha_type: string | null,
 *   captcha_site_key: string | null,
 *   discovery_status: string
 * }} CacheRow
 */

/**
 * Process a single claimed item end-to-end. Wraps the whole flow in a
 * SUBMISSION_TIMEOUT_MS-bounded race so a hung Chromium doesn't pin the
 * worker forever.
 *
 * @param {{
 *   item: ClaimedItem,
 *   batch: BatchRow,
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   logger: { info: Function, debug: Function, warn: Function, error: Function }
 * }} args
 */
async function processItem({ item, batch, supabase, logger }) {
  const t0 = Date.now()
  logger.info({ itemId: item.id, batchId: batch.id, dryRun: batch.dry_run }, '[runner] processing item')

  // 1. Load cache
  const { data: cache, error: cacheErr } = await supabase
    .from('prospect_form_cache')
    .select(
      'sourced_website_id, contact_url, field_mapping, submit_selector, form_builder, captcha_type, captcha_site_key, discovery_status',
    )
    .eq('sourced_website_id', item.sourced_website_id)
    .maybeSingle()

  if (cacheErr || !cache || cache.discovery_status !== 'success') {
    logger.warn(
      { itemId: item.id, sourcedWebsiteId: item.sourced_website_id, status: cache?.discovery_status },
      '[runner] no usable form_cache; skipping',
    )
    await completeSkipped({ supabase, itemId: item.id, reason: 'no_form_cache', logger })
    return
  }

  // Step 5 deliberately skips captcha-protected forms (no 2Captcha until step 9).
  if (cache.captcha_type) {
    logger.info(
      { itemId: item.id, captchaType: cache.captcha_type },
      '[runner] cache marks captcha; skipping until step 9',
    )
    await completeSkipped({ supabase, itemId: item.id, reason: 'captcha_pending', logger })
    return
  }

  /** @type {import('./browser.js').BrowserSession | null} */
  let session = null
  try {
    // 2. Launch browser
    session = await launchSession({ logger })
    await logStep({
      supabase,
      itemId: item.id,
      step: 'browser_launched',
      status: 'ok',
      metadata: { userAgent: session.userAgent, viewport: session.viewport },
    })

    // 3. Navigate
    const navStart = Date.now()
    try {
      await session.page.goto(cache.contact_url, { waitUntil: 'networkidle', timeout: 45000 })
    } catch {
      // networkidle can be flaky on chatty sites; fall back to domcontentloaded
      await session.page.goto(cache.contact_url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    await logStep({
      supabase,
      itemId: item.id,
      step: 'navigated',
      status: 'ok',
      durationMs: Date.now() - navStart,
      metadata: { url: cache.contact_url },
    })

    // 4. Before screenshot
    const beforePath = await captureAndUpload({
      page: session.page,
      supabase,
      itemId: item.id,
      label: 'before',
      logger,
    })

    // 5. Fill
    const fillStart = Date.now()
    const { filledKeys, skippedKeys } = await fillForm({
      page: session.page,
      fieldMapping: cache.field_mapping,
      payload: item.payload,
      logger,
    })
    await logStep({
      supabase,
      itemId: item.id,
      step: 'filled',
      status: skippedKeys.length > 0 ? 'warn' : 'ok',
      durationMs: Date.now() - fillStart,
      metadata: { filledKeys, skippedKeys },
    })

    // 6. Pre-submit screenshot (always — useful evidence both paths)
    const preSubmitPath = await captureAndUpload({
      page: session.page,
      supabase,
      itemId: item.id,
      label: 'pre_submit',
      logger,
    })

    // 7. Branch on dry-run
    if (batch.dry_run) {
      await completeSuccess({
        supabase,
        itemId: item.id,
        sourcedWebsiteId: item.sourced_website_id,
        successIndicator: 'dry_run',
        screenshotPath: preSubmitPath ?? beforePath ?? null,
        isDryRun: true,
        logger,
      })
      logger.info({ itemId: item.id, elapsedMs: Date.now() - t0 }, '[runner] dry-run success')
      return
    }

    // 8. Real submit (currently rare in step 5 — no proxy, no captcha, expect Cloudflare to block on most prod sites)
    const submitStart = Date.now()
    const beforeUrl = session.page.url()
    const outcome = await submitForm({
      page: session.page,
      submitSelector: cache.submit_selector,
      beforeUrl,
      logger,
    })
    await logStep({
      supabase,
      itemId: item.id,
      step: 'submitted',
      status: outcome.status === 'failed' ? 'error' : outcome.status === 'ambiguous' ? 'warn' : 'ok',
      durationMs: Date.now() - submitStart,
      metadata: outcome,
    })

    // 9. After screenshot
    const afterPath = await captureAndUpload({
      page: session.page,
      supabase,
      itemId: item.id,
      label: 'after',
      logger,
    })

    // 10. Complete based on outcome
    if (outcome.status === 'success') {
      await completeSuccess({
        supabase,
        itemId: item.id,
        sourcedWebsiteId: item.sourced_website_id,
        successIndicator: outcome.indicator,
        screenshotPath: afterPath ?? preSubmitPath ?? null,
        isDryRun: false,
        logger,
      })
    } else {
      const failureReason =
        outcome.status === 'ambiguous' ? `ambiguous_${outcome.indicator}` : outcome.indicator
      await completeFailure({
        supabase,
        itemId: item.id,
        failureReason,
        attempts: item.attempts,
        maxAttempts: item.max_attempts,
        screenshotPath: afterPath ?? preSubmitPath ?? null,
        logger,
      })
    }

    logger.info({ itemId: item.id, outcome, elapsedMs: Date.now() - t0 }, '[runner] item complete')
  } catch (err) {
    logger.error(
      { itemId: item.id, err: err instanceof Error ? err.message : String(err) },
      '[runner] item processing threw',
    )
    await logStep({
      supabase,
      itemId: item.id,
      step: 'fatal',
      status: 'error',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    })
    await completeFailure({
      supabase,
      itemId: item.id,
      failureReason: 'worker_exception',
      attempts: item.attempts,
      maxAttempts: item.max_attempts,
      logger,
    })
  } finally {
    if (session) await closeSession(session)
  }
}

/**
 * Process a single item with a hard timeout. If the timeout fires we abandon
 * the item — its `claimed_at` is stale; the reaper RPC will recover it.
 *
 * @param {{
 *   item: ClaimedItem,
 *   batch: BatchRow,
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   logger: object
 * }} args
 */
async function processItemBounded(args) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`submission timed out after ${SUBMISSION_TIMEOUT_MS}ms`)),
      SUBMISSION_TIMEOUT_MS,
    )
  })
  try {
    await Promise.race([processItem(args), timeout])
  } catch (err) {
    args.logger.error(
      { itemId: args.item.id, err: err instanceof Error ? err.message : String(err) },
      '[runner] processItemBounded error',
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Main entry: drain a batch's pending items via N concurrent worker tasks.
 * Returns when the queue empties (or after a configurable empty-poll cap).
 *
 * @param {{
 *   batchId: string,
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   logger: { info: Function, debug: Function, warn: Function, error: Function }
 * }} args
 */
export async function runSubmissionBatch({ batchId, supabase, logger }) {
  logger.info({ batchId, workerId: WORKER_ID, concurrency: SUBMISSION_CONCURRENCY }, '[runner] starting batch')

  // Load the batch row once for dry_run flag and update its status.
  const { data: batch, error: batchErr } = await supabase
    .from('prospect_form_submission_batches')
    .select('id, dry_run, status')
    .eq('id', batchId)
    .maybeSingle()
  if (batchErr || !batch) {
    logger.error({ batchId, err: batchErr?.message }, '[runner] batch not found')
    return
  }
  if (batch.status === 'completed' || batch.status === 'cancelled') {
    logger.info({ batchId, status: batch.status }, '[runner] batch already terminal; skipping')
    return
  }

  await supabase
    .from('prospect_form_submission_batches')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', batchId)

  const t0 = Date.now()
  let processed = 0
  let consecutiveEmptyPolls = 0
  const MAX_EMPTY_POLLS = 3

  /** @returns {Promise<void>} */
  const workerLoop = async () => {
    while (consecutiveEmptyPolls < MAX_EMPTY_POLLS) {
      let claimed
      try {
        claimed = await claimItems({ supabase, batchId, limit: 1, workerId: WORKER_ID })
      } catch (err) {
        logger.error({ batchId, err: err instanceof Error ? err.message : String(err) }, '[runner] claim error')
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }

      if (claimed.length === 0) {
        consecutiveEmptyPolls++
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      consecutiveEmptyPolls = 0

      for (const item of claimed) {
        await processItemBounded({ item, batch: { id: batch.id, dry_run: batch.dry_run }, supabase, logger })
        processed++
      }
    }
  }

  await Promise.all(
    Array.from({ length: SUBMISSION_CONCURRENCY }, () => workerLoop()),
  )

  await supabase
    .from('prospect_form_submission_batches')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', batchId)

  logger.info(
    { batchId, processed, elapsedMs: Date.now() - t0 },
    '[runner] batch complete',
  )
}

export const __testables = { WORKER_ID, SUBMISSION_CONCURRENCY }
