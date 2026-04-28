#!/usr/bin/env node
/**
 * dev-discover — CLI for testing the discovery worker against a real domain.
 *
 *   npm run dev:discover <domain>            # dry run, prints result, no DB
 *   npm run dev:discover <domain> --persist  # looks up sourced_websites by
 *                                            # domain, writes prospect_form_cache
 *
 * Step 4 demo. Heuristic mapper only (no LLM).
 */

import { discoverDomain, persistDiscovery } from '../src/discovery/runner.js'
import { supabase, supabaseEnabled } from '../src/supabase.js'

function usage() {
  console.error('Usage: npm run dev:discover <domain> [--persist]')
  console.error('Examples:')
  console.error('  npm run dev:discover example.com')
  console.error('  npm run dev:discover example.com --persist')
  process.exit(2)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) usage()
  const domain = args.find((a) => !a.startsWith('--'))
  const persist = args.includes('--persist')
  if (!domain) usage()

  console.log(`[dev-discover] domain=${domain} persist=${persist}`)

  const sourcedWebsiteId = persist ? await lookupSourcedWebsiteId(domain) : null
  const result = await discoverDomain(domain, {
    sourcedWebsiteId,
    supabase: persist ? supabase : null,
    logger: console,
  })

  console.log('\n--- Discovery result ---')
  console.log(JSON.stringify(redactHtml(result), null, 2))

  if (persist) {
    if (!supabaseEnabled) {
      console.error('\n[dev-discover] --persist set but Supabase is not configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env')
      process.exit(1)
    }
    if (!sourcedWebsiteId) {
      console.error(`\n[dev-discover] --persist set but no sourced_websites row found for domain="${domain}". Aborting.`)
      process.exit(1)
    }
    await persistDiscovery({ sourcedWebsiteId, result, supabase, logger: console })
    console.log(`\n[dev-discover] Persisted to prospect_form_cache for sourced_website_id=${sourcedWebsiteId}`)
  } else {
    console.log('\n[dev-discover] dry run — nothing written. Re-run with --persist to write to prospect_form_cache.')
  }
}

/**
 * Trim form_html to a preview so the CLI output stays readable.
 *
 * @param {object} result
 */
function redactHtml(result) {
  if (result && typeof result === 'object' && 'formHtml' in result && typeof result.formHtml === 'string') {
    const html = result.formHtml
    return { ...result, formHtml: html.length > 400 ? `${html.slice(0, 400)}… (${html.length} chars total)` : html }
  }
  return result
}

/**
 * @param {string} domain
 * @returns {Promise<string | null>}
 */
async function lookupSourcedWebsiteId(domain) {
  if (!supabaseEnabled) return null
  const { data, error } = await supabase
    .from('sourced_websites')
    .select('id')
    .eq('domain', domain)
    .maybeSingle()
  if (error) {
    console.error('[dev-discover] sourced_websites lookup error:', error.message)
    return null
  }
  return data?.id ?? null
}

main().catch((err) => {
  console.error('[dev-discover] fatal:', err)
  process.exit(1)
})
