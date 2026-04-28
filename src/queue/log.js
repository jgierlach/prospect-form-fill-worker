/**
 * Insert a structured row into `prospect_form_submission_logs`. Best-effort —
 * logging failures should never crash the submission flow.
 *
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   itemId: string,
 *   step: string,
 *   status: 'ok' | 'warn' | 'error',
 *   durationMs?: number | null,
 *   metadata?: Record<string, unknown> | null,
 *   logger?: { warn: Function }
 * }} args
 */
export async function logStep({
  supabase,
  itemId,
  step,
  status,
  durationMs = null,
  metadata = null,
  logger = console,
}) {
  const { error } = await supabase.from('prospect_form_submission_logs').insert({
    item_id: itemId,
    step,
    status,
    duration_ms: durationMs,
    metadata,
  })
  if (error) {
    logger.warn(
      { itemId, step, err: error.message },
      '[log] insert failed (non-fatal)',
    )
  }
}
