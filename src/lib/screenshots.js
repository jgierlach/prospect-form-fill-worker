const BUCKET = 'prospect-form-fill-evidence'

/**
 * Capture a full-page screenshot and upload it to the
 * `prospect-form-fill-evidence` bucket. Returns the storage path
 * (`{itemId}/{label}.png`) — the admin UI generates a signed URL from this on
 * read. Returns null if either the capture or upload fails (best-effort).
 *
 * @param {{
 *   page: import('playwright').Page,
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   itemId: string,
 *   label: 'before' | 'pre_submit' | 'after',
 *   logger?: { warn: Function, debug: Function }
 * }} args
 * @returns {Promise<string | null>} storage path or null on failure
 */
export async function captureAndUpload({ page, supabase, itemId, label, logger = console }) {
  let pngBuffer
  try {
    pngBuffer = await page.screenshot({ fullPage: true, type: 'png' })
  } catch (err) {
    logger.warn(
      { itemId, label, err: err instanceof Error ? err.message : String(err) },
      '[screenshots] capture failed',
    )
    return null
  }

  const path = `${itemId}/${label}.png`
  const { error } = await supabase.storage.from(BUCKET).upload(path, pngBuffer, {
    contentType: 'image/png',
    upsert: true,
  })
  if (error) {
    logger.warn({ itemId, label, path, err: error.message }, '[screenshots] upload failed')
    return null
  }
  logger.debug({ itemId, label, path }, '[screenshots] uploaded')
  return path
}
