#!/usr/bin/env node
/**
 * dev-submit — run a single submission item end-to-end with verbose logging.
 *
 *   npm run dev:submit <item_id>            # process the item; honors batch.dry_run
 *   npm run dev:submit <item_id> --headed   # show the Chromium window (debugging)
 *
 * Useful for iterating on the filler / outcome detector without standing up
 * a full batch.
 */

import 'dotenv/config'
import { supabase, supabaseEnabled } from '../src/supabase.js'
import { launchSession, closeSession } from '../src/submission/browser.js'
import { fillForm } from '../src/submission/filler.js'
import { submitForm } from '../src/submission/submitter.js'
import { captureAndUpload } from '../src/lib/screenshots.js'
import { completeSuccess, completeFailure, completeSkipped } from '../src/queue/complete.js'

function usage() {
  console.error('Usage: npm run dev:submit <item_id> [--headed]')
  process.exit(2)
}

async function main() {
  if (!supabaseEnabled) {
    console.error('[dev-submit] Supabase not configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env')
    process.exit(1)
  }
  const args = process.argv.slice(2)
  const itemId = args.find((a) => !a.startsWith('--'))
  const headed = args.includes('--headed')
  if (!itemId) usage()

  console.log(`[dev-submit] item=${itemId} headed=${headed}`)

  // Load item + batch + cache
  const { data: item, error: itemErr } = await supabase
    .from('prospect_form_submission_batch_items')
    .select('id, batch_id, sourced_website_id, payload, attempts, max_attempts')
    .eq('id', itemId)
    .maybeSingle()
  if (itemErr || !item) {
    console.error('[dev-submit] item not found:', itemErr?.message)
    process.exit(1)
  }

  const { data: batch } = await supabase
    .from('prospect_form_submission_batches')
    .select('id, dry_run')
    .eq('id', item.batch_id)
    .maybeSingle()

  const { data: cache } = await supabase
    .from('prospect_form_cache')
    .select('contact_url, field_mapping, submit_selector, captcha_type, discovery_status')
    .eq('sourced_website_id', item.sourced_website_id)
    .maybeSingle()

  if (!cache || cache.discovery_status !== 'success') {
    console.error('[dev-submit] no usable form_cache for this website')
    await completeSkipped({
      supabase,
      itemId,
      sourcedWebsiteId: item.sourced_website_id,
      reason: 'no_form_cache',
    })
    process.exit(1)
  }
  if (cache.captcha_type) {
    console.error(`[dev-submit] cache marks captcha (${cache.captcha_type}); skipping until step 9`)
    await completeSkipped({
      supabase,
      itemId,
      sourcedWebsiteId: item.sourced_website_id,
      reason: 'captcha_pending',
    })
    process.exit(0)
  }

  console.log(`[dev-submit] dry_run=${batch?.dry_run} url=${cache.contact_url}`)

  const session = await launchSession({ headless: !headed, logger: console })
  try {
    await session.page.goto(cache.contact_url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
      session.page.goto(cache.contact_url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    )

    const beforePath = await captureAndUpload({ page: session.page, supabase, itemId, label: 'before' })
    console.log(`[dev-submit] before screenshot → ${beforePath}`)

    const { filledKeys, skippedKeys } = await fillForm({
      page: session.page,
      fieldMapping: cache.field_mapping,
      payload: item.payload,
      logger: console,
    })
    console.log(`[dev-submit] filled=${filledKeys.length} skipped=${skippedKeys.length}`)

    const preSubmitPath = await captureAndUpload({ page: session.page, supabase, itemId, label: 'pre_submit' })
    console.log(`[dev-submit] pre_submit screenshot → ${preSubmitPath}`)

    if (batch?.dry_run) {
      await completeSuccess({
        supabase,
        itemId,
        sourcedWebsiteId: item.sourced_website_id,
        successIndicator: 'dry_run',
        screenshotPath: preSubmitPath ?? beforePath ?? null,
        proxyBytesUsed: session.getBytesUsed(),
        isDryRun: true,
      })
      console.log(
        `[dev-submit] dry-run success — item marked, sourced_website reset to pending, proxyBytes=${session.getBytesUsed()}`,
      )
      return
    }

    const beforeUrl = session.page.url()
    const outcome = await submitForm({
      page: session.page,
      submitSelector: cache.submit_selector,
      beforeUrl,
      logger: console,
    })
    console.log(`[dev-submit] outcome:`, outcome)
    const afterPath = await captureAndUpload({ page: session.page, supabase, itemId, label: 'after' })
    console.log(`[dev-submit] after screenshot → ${afterPath}`)

    const proxyBytesUsed = session.getBytesUsed()
    if (outcome.status === 'success') {
      await completeSuccess({
        supabase,
        itemId,
        sourcedWebsiteId: item.sourced_website_id,
        successIndicator: outcome.indicator,
        screenshotPath: afterPath ?? null,
        proxyBytesUsed,
        isDryRun: false,
      })
    } else {
      const failureReason =
        outcome.status === 'ambiguous' ? `ambiguous_${outcome.indicator}` : outcome.indicator
      await completeFailure({
        supabase,
        itemId,
        sourcedWebsiteId: item.sourced_website_id,
        failureReason,
        attempts: item.attempts,
        maxAttempts: item.max_attempts,
        screenshotPath: afterPath ?? null,
        proxyBytesUsed,
      })
    }
  } finally {
    await closeSession(session)
  }
}

main().catch((err) => {
  console.error('[dev-submit] fatal:', err)
  process.exit(1)
})
