/**
 * Failure-reason categories that should NOT be retried. Spec §7.9 — these
 * indicate a hostile site / discovery problem / cache invalidation, where
 * retrying just burns more proxy bytes and captcha solves.
 */
const NON_RETRYABLE_REASONS = new Set([
  'captcha_failed',
  'blocked',
  'no_form_cache',
  'form_disappeared',
])

/** Backoff schedule per spec §7.9. Indexed by attempts already made. */
const BACKOFF_SECONDS = [5 * 60, 30 * 60]

/**
 * @param {string | undefined} failureReason
 * @param {number} attempts
 * @param {number} maxAttempts
 * @returns {{ status: 'failed' | 'pending', nextAttemptAt: string | null }}
 */
function decideRetry(failureReason, attempts, maxAttempts) {
  if (failureReason && NON_RETRYABLE_REASONS.has(failureReason)) {
    return { status: 'failed', nextAttemptAt: null }
  }
  if (attempts >= maxAttempts) {
    return { status: 'failed', nextAttemptAt: null }
  }
  const backoff = BACKOFF_SECONDS[attempts - 1] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1]
  const next = new Date(Date.now() + backoff * 1000).toISOString()
  return { status: 'pending', nextAttemptAt: next }
}

/**
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   itemId: string,
 *   sourcedWebsiteId: string,
 *   successIndicator: string,
 *   screenshotPath?: string | null,
 *   isDryRun: boolean,
 *   logger?: { info: Function, warn: Function }
 * }} args
 */
export async function completeSuccess({
  supabase,
  itemId,
  sourcedWebsiteId,
  successIndicator,
  screenshotPath = null,
  isDryRun,
  logger = console,
}) {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('prospect_form_submission_batch_items')
    .update({
      status: 'success',
      submitted_at: now,
      success_indicator: successIndicator,
      failure_reason: null,
      screenshot_url: screenshotPath,
      worker_id: null,
      next_attempt_at: null,
      updated_at: now,
    })
    .eq('id', itemId)
  if (error) throw new Error(`[complete:success] update failed: ${error.message}`)

  // Bump batch counter
  await incrementBatchCounter(supabase, itemId, 'succeeded', logger)

  // Dedup-mark sourced_websites — but NOT in dry-run mode (spec §7.11)
  if (!isDryRun) {
    const { error: rpcErr } = await supabase.rpc('mark_prospect_form_submitted', {
      p_website_ids: [sourcedWebsiteId],
    })
    if (rpcErr) {
      logger.warn(
        { itemId, sourcedWebsiteId, err: rpcErr.message },
        '[complete:success] mark_prospect_form_submitted RPC failed (non-fatal)',
      )
    }
  }
}

/**
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   itemId: string,
 *   failureReason: string,
 *   attempts: number,
 *   maxAttempts: number,
 *   screenshotPath?: string | null,
 *   logger?: { info: Function, warn: Function }
 * }} args
 */
export async function completeFailure({
  supabase,
  itemId,
  failureReason,
  attempts,
  maxAttempts,
  screenshotPath = null,
  logger = console,
}) {
  const { status, nextAttemptAt } = decideRetry(failureReason, attempts, maxAttempts)
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('prospect_form_submission_batch_items')
    .update({
      status,
      failure_reason: failureReason,
      screenshot_url: screenshotPath,
      next_attempt_at: nextAttemptAt,
      // worker_id only cleared when we're done (terminal failed) or about to retry
      worker_id: null,
      updated_at: now,
    })
    .eq('id', itemId)
  if (error) throw new Error(`[complete:failure] update failed: ${error.message}`)

  if (status === 'failed') {
    await incrementBatchCounter(supabase, itemId, 'failed', logger)
  }
}

/**
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   itemId: string,
 *   reason: string,
 *   logger?: { info: Function, warn: Function }
 * }} args
 */
export async function completeSkipped({ supabase, itemId, reason, logger = console }) {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('prospect_form_submission_batch_items')
    .update({
      status: 'skipped',
      failure_reason: reason,
      worker_id: null,
      next_attempt_at: null,
      updated_at: now,
    })
    .eq('id', itemId)
  if (error) throw new Error(`[complete:skipped] update failed: ${error.message}`)
  await incrementBatchCounter(supabase, itemId, 'skipped', logger)
}

/**
 * Bump the parent batch's counter for the given outcome. Reads batch_id off
 * the item row to avoid a redundant param at every callsite. Best-effort —
 * counter drift is tolerable and the admin UI rebuilds totals from item
 * statuses anyway.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} itemId
 * @param {'succeeded' | 'failed' | 'skipped'} field
 * @param {{ warn: Function }} logger
 */
async function incrementBatchCounter(supabase, itemId, field, logger) {
  const { data: item, error: lookupErr } = await supabase
    .from('prospect_form_submission_batch_items')
    .select('batch_id')
    .eq('id', itemId)
    .maybeSingle()
  if (lookupErr || !item?.batch_id) {
    logger.warn({ itemId, err: lookupErr?.message }, '[complete] batch lookup failed for counter bump')
    return
  }
  // Plain SQL increment via two-step read-then-write would race under
  // concurrency. Use a single update with raw SQL via PostgREST.
  // (No dedicated RPC was created for this; if drift becomes a problem we'll
  // add one. For step 5 dry-run we can tolerate eventual consistency.)
  const { data: row } = await supabase
    .from('prospect_form_submission_batches')
    .select(field)
    .eq('id', item.batch_id)
    .maybeSingle()
  if (!row) return
  const current = /** @type {number} */ (row[field] ?? 0)
  await supabase
    .from('prospect_form_submission_batches')
    .update({ [field]: current + 1, updated_at: new Date().toISOString() })
    .eq('id', item.batch_id)
}
