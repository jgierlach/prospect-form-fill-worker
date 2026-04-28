/**
 * @typedef {{
 *   id: string,
 *   sourced_website_id: string,
 *   sourced_contact_id: string | null,
 *   payload: Record<string, string>,
 *   attempts: number,
 *   max_attempts: number
 * }} ClaimedItem
 */

/**
 * Atomically claim up to `limit` pending items from a batch. Wraps the
 * `claim_prospect_form_submission_items` RPC.
 *
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   batchId: string,
 *   limit: number,
 *   workerId: string
 * }} args
 * @returns {Promise<ClaimedItem[]>}
 */
export async function claimItems({ supabase, batchId, limit, workerId }) {
  const { data, error } = await supabase.rpc('claim_prospect_form_submission_items', {
    p_batch_id: batchId,
    p_limit: limit,
    p_worker_id: workerId,
  })
  if (error) throw new Error(`[claim] RPC failed: ${error.message}`)
  return /** @type {ClaimedItem[]} */ (data ?? [])
}
