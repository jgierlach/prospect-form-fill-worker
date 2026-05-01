import os from 'node:os'
import { launchSession, closeSession } from './browser.js'
import { fillForm } from './filler.js'
import { submitForm } from './submitter.js'
import { solveCaptcha, injectCaptchaToken } from './captcha-solver.js'
import { captureAndUpload } from '../lib/screenshots.js'
import { claimItems } from '../queue/claim.js'
import {
  completeSuccess,
  completeFailure,
  completeSkipped,
  setWebsiteStatus,
} from '../queue/complete.js'
import { logStep } from '../queue/log.js'
import { discoverDomain, persistDiscovery } from '../discovery/runner.js'

const SUBMISSION_CONCURRENCY = parseInt(process.env.SUBMISSION_CONCURRENCY || '3', 10)
// Per-item budget. Has to comfortably fit auto-discovery on a fresh site
// (~30–60s) + nav (~15s) + human-paced fill (~30–60s) + hCaptcha solve
// (up to ~180s) + submit click + screenshots (~15s). 360s gives headroom
// for that worst case; tune via env when working on a thinner queue.
const SUBMISSION_TIMEOUT_MS = parseInt(process.env.SUBMISSION_TIMEOUT_MS || '360000', 10)
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
  let { data: cache, error: cacheErr } = await supabase
    .from('prospect_form_cache')
    .select(
      'sourced_website_id, contact_url, field_mapping, submit_selector, form_builder, captcha_type, captcha_site_key, discovery_status',
    )
    .eq('sourced_website_id', item.sourced_website_id)
    .maybeSingle()
  if (cacheErr) {
    logger.warn({ itemId: item.id, err: cacheErr.message }, '[runner] cache lookup error')
  }

  // 1b. Auto-discover when cache is missing or hasn't completed yet. The
  // admin's POST /batches inserts placeholder cache rows via
  // ensureDiscoveryQueued (discovery_status='pending') but doesn't actually
  // run discovery. Without this fallback every fresh-site item silently
  // skips with `no_form_cache` even though discovery would have succeeded.
  // We only auto-discover from the not-yet-attempted states (missing cache
  // row, or status=null/pending). If a previous discovery already ran and
  // failed, the operator should re-trigger explicitly via the admin
  // "Re-run discovery" UI rather than burning batch time on every retry.
  const needsAutoDiscovery = !cache || !cache.discovery_status || cache.discovery_status === 'pending'
  if (needsAutoDiscovery) {
    const { data: site } = await supabase
      .from('sourced_websites')
      .select('domain')
      .eq('id', item.sourced_website_id)
      .maybeSingle()
    if (!site?.domain) {
      logger.warn(
        { itemId: item.id, sourcedWebsiteId: item.sourced_website_id },
        '[runner] auto-discover skipped — sourced_website not found',
      )
    } else {
      logger.info(
        { itemId: item.id, domain: site.domain, cacheStatus: cache?.discovery_status ?? 'missing' },
        '[runner] auto-discovering before submit',
      )
      const discoverStart = Date.now()
      try {
        const result = await discoverDomain(site.domain, {
          sourcedWebsiteId: item.sourced_website_id,
          supabase,
          logger,
        })
        await persistDiscovery({
          sourcedWebsiteId: item.sourced_website_id,
          result,
          supabase,
          logger,
        })
        await logStep({
          supabase,
          itemId: item.id,
          step: 'auto_discovered',
          status: result.status === 'success' ? 'ok' : 'warn',
          durationMs: Date.now() - discoverStart,
          metadata: {
            outcome: result.status,
            failureReason: result.status === 'failed' ? result.failureReason : null,
            contactUrl: 'contactUrl' in result ? result.contactUrl : null,
          },
        })
        // Re-load cache so the rest of the flow sees the persisted result.
        const { data: refreshed } = await supabase
          .from('prospect_form_cache')
          .select(
            'sourced_website_id, contact_url, field_mapping, submit_selector, form_builder, captcha_type, captcha_site_key, discovery_status',
          )
          .eq('sourced_website_id', item.sourced_website_id)
          .maybeSingle()
        cache = refreshed
      } catch (err) {
        logger.warn(
          { itemId: item.id, domain: site.domain, err: err instanceof Error ? err.message : String(err) },
          '[runner] auto-discovery threw',
        )
      }
    }
  }

  if (!cache || cache.discovery_status !== 'success') {
    logger.warn(
      { itemId: item.id, sourcedWebsiteId: item.sourced_website_id, status: cache?.discovery_status },
      '[runner] no usable form_cache; skipping',
    )
    await completeSkipped({
      supabase,
      itemId: item.id,
      sourcedWebsiteId: item.sourced_website_id,
      reason: 'no_form_cache',
      logger,
    })
    return
  }

  // Captcha gate. If the cache marks one but we don't have a 2Captcha key
  // configured, skip cleanly (operator hasn't enabled paid solving). With a
  // key, we'll solve mid-flow once we know the page actually rendered.
  if (cache.captcha_type && !process.env.TWOCAPTCHA_API_KEY) {
    logger.info(
      { itemId: item.id, captchaType: cache.captcha_type },
      '[runner] cache marks captcha but TWOCAPTCHA_API_KEY unset; skipping',
    )
    await completeSkipped({
      supabase,
      itemId: item.id,
      sourcedWebsiteId: item.sourced_website_id,
      reason: 'captcha_pending',
      logger,
    })
    return
  }

  // We have a real form to fill — flip the website's status to 'processing'
  // so the admin Queue UI accurately reflects in-flight work. (Skipped items
  // bypass this so they never visibly transition through 'processing'.)
  await setWebsiteStatus({
    supabase,
    websiteIds: [item.sourced_website_id],
    status: 'processing',
    logger,
  })

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
      metadata: {
        userAgent: session.userAgent,
        viewport: session.viewport,
        proxyEnabled: session.proxyEnabled,
        sessionId: session.sessionId,
      },
    })

    // 3. Navigate
    const navStart = Date.now()
    let navResponse = null
    try {
      navResponse = await session.page.goto(cache.contact_url, { waitUntil: 'networkidle', timeout: 45000 })
    } catch {
      // networkidle can be flaky on chatty sites; fall back to domcontentloaded
      navResponse = await session.page.goto(cache.contact_url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    // Playwright's goto() does NOT throw on HTTP 4xx/5xx — it returns a
    // Response with the error status. Without an explicit check we'd "succeed"
    // navigation to a proxy-407 or site-403 error page and waste time filling
    // a DOM that doesn't have the form. Treat anything >=400 as a nav failure.
    const navStatus = navResponse?.status() ?? null
    if (!navStatus || navStatus >= 400) {
      await logStep({
        supabase,
        itemId: item.id,
        step: 'navigated',
        status: 'error',
        durationMs: Date.now() - navStart,
        metadata: { url: cache.contact_url, httpStatus: navStatus },
      })
      await completeFailure({
        supabase,
        itemId: item.id,
        sourcedWebsiteId: item.sourced_website_id,
        failureReason: navStatus ? `nav_failed_${navStatus}` : 'nav_failed',
        attempts: item.attempts,
        maxAttempts: item.max_attempts,
        proxyBytesUsed: session.getBytesUsed(),
        logger,
      })
      return
    }
    await logStep({
      supabase,
      itemId: item.id,
      step: 'navigated',
      status: 'ok',
      durationMs: Date.now() - navStart,
      metadata: { url: cache.contact_url, httpStatus: navStatus },
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

    // 6. Solve + inject captcha if the cache marks one. Done after fill so the
    // form is fully populated when we drop the token (some sites validate
    // both at submit time). Solve is bounded to ~90s; failure is non-retryable
    // per spec §7.9 — once a site is captcha-hostile, retry just burns spend.
    let captchaSolveCostCents = 0
    if (cache.captcha_type && cache.captcha_site_key) {
      const captchaStart = Date.now()
      try {
        const solveResult = await solveCaptcha({
          type: cache.captcha_type,
          siteKey: cache.captcha_site_key,
          pageUrl: cache.contact_url,
          logger,
        })
        if (solveResult) {
          captchaSolveCostCents = solveResult.costCents
          await injectCaptchaToken({
            page: session.page,
            type: cache.captcha_type,
            token: solveResult.token,
            logger,
          })
          await logStep({
            supabase,
            itemId: item.id,
            step: 'captcha_solved',
            status: 'ok',
            durationMs: Date.now() - captchaStart,
            metadata: {
              type: cache.captcha_type,
              solveMs: solveResult.elapsedMs,
              costCents: solveResult.costCents,
            },
          })
        }
      } catch (err) {
        logger.warn(
          { itemId: item.id, err: err instanceof Error ? err.message : String(err) },
          '[runner] captcha solve failed',
        )
        await logStep({
          supabase,
          itemId: item.id,
          step: 'captcha_failed',
          status: 'error',
          durationMs: Date.now() - captchaStart,
          metadata: { error: err instanceof Error ? err.message : String(err) },
        })
        await completeFailure({
          supabase,
          itemId: item.id,
          sourcedWebsiteId: item.sourced_website_id,
          failureReason: 'captcha_failed',
          attempts: item.attempts,
          maxAttempts: item.max_attempts,
          proxyBytesUsed: session.getBytesUsed(),
          logger,
        })
        return
      }
    }

    // 7. Pre-submit screenshot (always — useful evidence both paths)
    const preSubmitPath = await captureAndUpload({
      page: session.page,
      supabase,
      itemId: item.id,
      label: 'pre_submit',
      logger,
    })

    // 8. Branch on dry-run
    if (batch.dry_run) {
      await completeSuccess({
        supabase,
        itemId: item.id,
        sourcedWebsiteId: item.sourced_website_id,
        successIndicator: 'dry_run',
        screenshotPath: preSubmitPath ?? beforePath ?? null,
        proxyBytesUsed: session.getBytesUsed(),
        captchaSolveCostCents,
        isDryRun: true,
        logger,
      })
      logger.info(
        { itemId: item.id, elapsedMs: Date.now() - t0, proxyBytes: session.getBytesUsed() },
        '[runner] dry-run success',
      )
      return
    }

    // 9. Real submit
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

    const proxyBytesUsed = session.getBytesUsed()

    // 11. Complete based on outcome
    if (outcome.status === 'success') {
      await completeSuccess({
        supabase,
        itemId: item.id,
        sourcedWebsiteId: item.sourced_website_id,
        successIndicator: outcome.indicator,
        screenshotPath: afterPath ?? preSubmitPath ?? null,
        proxyBytesUsed,
        captchaSolveCostCents,
        isDryRun: false,
        logger,
      })
    } else {
      const failureReason =
        outcome.status === 'ambiguous' ? `ambiguous_${outcome.indicator}` : outcome.indicator
      await completeFailure({
        supabase,
        itemId: item.id,
        sourcedWebsiteId: item.sourced_website_id,
        failureReason,
        attempts: item.attempts,
        maxAttempts: item.max_attempts,
        screenshotPath: afterPath ?? preSubmitPath ?? null,
        proxyBytesUsed,
        captchaSolveCostCents,
        logger,
      })
    }

    logger.info(
      { itemId: item.id, outcome, elapsedMs: Date.now() - t0, proxyBytes: proxyBytesUsed, captchaCents: captchaSolveCostCents },
      '[runner] item complete',
    )
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
      sourcedWebsiteId: item.sourced_website_id,
      failureReason: 'worker_exception',
      attempts: item.attempts,
      maxAttempts: item.max_attempts,
      proxyBytesUsed: session?.getBytesUsed() ?? null,
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

// How long to sleep between checks when the batch has retry-pending items
// not yet due. Capped so we re-check batch status (cancellation) regularly.
const RETRY_WAIT_CAP_MS = 120_000  // 2 min
const RETRY_WAIT_FLOOR_MS = 5_000   // 5 sec — avoid tight-spinning on near-due retries

/**
 * Are there any pending items left in this batch (claimable now or sleeping
 * for retry)? Returns the earliest next_attempt_at if items are sleeping.
 * Uses one query so a concurrently-drained queue cannot look pending with no
 * remaining row. Throws on database errors so a failed read never looks like
 * an empty queue.
 *
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   batchId: string
 * }} args
 * @returns {Promise<{ hasPending: boolean, nextDueAt: string | null }>}
 */
async function batchPendingState({ supabase, batchId }) {
  const { data: nextDue, error } = await supabase
    .from('prospect_form_submission_batch_items')
    .select('next_attempt_at')
    .eq('batch_id', batchId)
    .eq('status', 'pending')
    .order('next_attempt_at', { ascending: true, nullsFirst: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`[runner] pending-state query failed: ${error.message}`)
  if (!nextDue) return { hasPending: false, nextDueAt: null }
  return { hasPending: true, nextDueAt: nextDue.next_attempt_at ?? null }
}

/**
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   batchId: string
 * }} args
 * @returns {Promise<'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | null>}
 */
async function readBatchStatus({ supabase, batchId }) {
  const { data } = await supabase
    .from('prospect_form_submission_batches')
    .select('status')
    .eq('id', batchId)
    .maybeSingle()
  return data?.status ?? null
}

/**
 * Main entry: own a batch through its full lifecycle. Keeps polling until
 * every item is terminal (success / failed / skipped) — including waiting
 * for retry-backoff sleeps. Exits cleanly on cancellation.
 *
 * Idempotent enough to be called from both the HTTP trigger and from
 * recoverOnStartup. The claim RPC's FOR UPDATE SKIP LOCKED keeps two
 * concurrent runners from double-processing, so a double-call is wasted CPU
 * not data corruption.
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
  let cancelled = false

  /** @returns {Promise<void>} */
  const workerLoop = async () => {
    while (!cancelled) {
      // Cheap status check before each claim — admin cancellation should
      // stop us within a couple of seconds.
      const status = await readBatchStatus({ supabase, batchId })
      if (status === 'cancelled') {
        cancelled = true
        break
      }

      let claimed
      try {
        claimed = await claimItems({ supabase, batchId, limit: 1, workerId: WORKER_ID })
      } catch (err) {
        logger.error({ batchId, err: err instanceof Error ? err.message : String(err) }, '[runner] claim error')
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }

      if (claimed.length > 0) {
        for (const item of claimed) {
          await processItemBounded({ item, batch: { id: batch.id, dry_run: batch.dry_run }, supabase, logger })
          processed++
        }
        continue
      }

      // Empty claim. Either the batch is genuinely drained, or items are
      // sleeping for retry backoff. Decide which.
      let pendingState
      try {
        pendingState = await batchPendingState({ supabase, batchId })
      } catch (err) {
        logger.error(
          { batchId, err: err instanceof Error ? err.message : String(err) },
          '[runner] pending-state check failed',
        )
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }

      const { hasPending, nextDueAt } = pendingState
      if (!hasPending) break

      // Sleep until the earliest retry is due (or RETRY_WAIT_CAP_MS, whichever
      // is smaller — we want to re-check cancellation regularly).
      const dueMs = nextDueAt ? new Date(nextDueAt).getTime() - Date.now() : RETRY_WAIT_CAP_MS
      const sleepMs = Math.max(RETRY_WAIT_FLOOR_MS, Math.min(RETRY_WAIT_CAP_MS, dueMs))
      logger.debug?.(
        { batchId, sleepMs, nextDueAt },
        '[runner] queue empty but retries pending; sleeping',
      )
      await new Promise((r) => setTimeout(r, sleepMs))
    }
  }

  await Promise.all(Array.from({ length: SUBMISSION_CONCURRENCY }, () => workerLoop()))

  // Don't flip cancelled batches back to completed.
  if (!cancelled) {
    await supabase
      .from('prospect_form_submission_batches')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', batchId)
  }

  logger.info(
    { batchId, processed, elapsedMs: Date.now() - t0, cancelled },
    '[runner] batch terminal',
  )
}

/**
 * On worker startup, find any batches stuck in 'running' state — those were
 * being processed when the previous process exited (deploy, crash, oom, etc.)
 * — and relaunch runSubmissionBatch for each. The reaper RPC separately
 * re-queues items whose claim went stale.
 *
 * Fire-and-forget: each batch runs in its own promise. Don't await; that'd
 * block index.js startup until every recovered batch drained.
 *
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   logger: { info: Function, debug: Function, warn: Function, error: Function }
 * }} args
 */
export async function recoverOnStartup({ supabase, logger }) {
  // Free any items whose worker died mid-claim. Without this, those items
  // sit in 'processing' status forever and never get retried.
  try {
    const { data: reclaimedCount } = await supabase.rpc('reclaim_stale_prospect_form_submission_items')
    if (reclaimedCount && Number(reclaimedCount) > 0) {
      logger.info({ reclaimedCount }, '[runner] reclaimed stale processing items on startup')
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[runner] reclaim_stale RPC failed on startup — continuing',
    )
  }

  const { data: stuck, error } = await supabase
    .from('prospect_form_submission_batches')
    .select('id')
    .eq('status', 'running')
  if (error) {
    logger.error({ err: error.message }, '[runner] startup recovery: batch query failed')
    return
  }
  if (!stuck || stuck.length === 0) {
    logger.info('[runner] startup recovery: no batches in flight')
    return
  }

  logger.info({ count: stuck.length, batchIds: stuck.map((b) => b.id) }, '[runner] resuming in-flight batches')
  for (const batch of stuck) {
    runSubmissionBatch({ batchId: batch.id, supabase, logger }).catch((err) => {
      logger.error(
        { batchId: batch.id, err: err instanceof Error ? err.message : String(err) },
        '[runner] resumed batch threw',
      )
    })
  }
}

export const __testables = { WORKER_ID, SUBMISSION_CONCURRENCY }
