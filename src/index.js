// MUST stay first — populates process.env before any module that reads it
// (supabase.js, runner.js) is imported. Without this, pm2 only sees env vars
// the user has exported into the shell before `pm2 start`, which is fragile
// and bit us once already on a fresh box.
import 'dotenv/config'

import Fastify from 'fastify'
import secureJsonParse from 'secure-json-parse'
import { supabase, supabaseEnabled } from './supabase.js'
import { runSubmissionBatch, recoverOnStartup } from './submission/runner.js'
import { discoverDomain, persistDiscovery } from './discovery/runner.js'

const PORT = parseInt(process.env.PORT || '3000', 10)
const API_TOKEN = process.env.API_TOKEN || ''
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'

const fastify = Fastify({
  logger: {
    level: LOG_LEVEL,
  },
})

// Fastify's default JSON parser throws FST_ERR_CTP_EMPTY_JSON_BODY when a
// request advertises Content-Type: application/json but sends an empty body.
// POST /batches/:id/run takes no body — the ID in the URL is sufficient.
// secure-json-parse blocks prototype-poisoning via __proto__ / constructor keys.
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try {
    const trimmed = typeof body === 'string' ? body.trim() : ''
    if (trimmed === '') return done(null, {})
    done(null, secureJsonParse(trimmed))
  } catch (err) {
    err.statusCode = 400
    done(err, undefined)
  }
})

// Bearer token authentication — everything except /health.
fastify.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return

  const authHeader = request.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!API_TOKEN || token !== API_TOKEN) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
})

fastify.get('/health', async () => {
  return { status: 'ok' }
})

/**
 * POST /batches/:id/run
 * Wakes the submission worker for a prospect-form-fill batch. Returns 202
 * immediately; the worker owns the batch lifecycle from this point.
 *
 * Fire-and-forget pattern matches email-verification-service. Errors inside
 * runSubmissionBatch get logged + per-item failure rows; the HTTP response
 * already left the building.
 */
fastify.post('/batches/:id/run', async (request, reply) => {
  if (!supabaseEnabled) {
    return reply.code(500).send({ error: 'Worker not configured (missing SUPABASE env vars)' })
  }

  const { id } = /** @type {{ id: string }} */ (request.params)
  if (!id) {
    return reply.code(400).send({ error: 'Batch id is required' })
  }

  runSubmissionBatch({ batchId: id, supabase, logger: fastify.log }).catch((err) => {
    fastify.log.error(
      { batchId: id, err: err instanceof Error ? err.message : String(err) },
      'Submission runner threw synchronously',
    )
  })

  return reply.code(202).send({ batch_id: id, status: 'accepted' })
})

/**
 * POST /discover/:sourcedWebsiteId
 * Synchronous (re-)discovery for a single sourced_website. Used by the admin
 * "Re-run discovery" UI when an operator wants to override the crawler — for
 * example, pointing it at a homepage with a JS-rendered Wix form, or pasting
 * a deep-linked /contact URL the heuristic crawler missed.
 *
 * Body (all optional):
 *   - contactUrlOverride: string  — skip resolveContactUrl, use this URL
 *   - forceBrowser:       boolean — always fetch via Playwright (Wix etc.)
 *
 * Returns 200 with the persisted discovery result. Synchronous because the
 * UI shows the outcome immediately; a single discovery run is fast enough
 * (a few seconds — tens of seconds with --forceBrowser).
 */
fastify.post('/discover/:sourcedWebsiteId', async (request, reply) => {
  if (!supabaseEnabled) {
    return reply.code(500).send({ error: 'Worker not configured (missing SUPABASE env vars)' })
  }

  const { sourcedWebsiteId } = /** @type {{ sourcedWebsiteId: string }} */ (request.params)
  if (!sourcedWebsiteId) {
    return reply.code(400).send({ error: 'sourcedWebsiteId is required' })
  }

  const body = /** @type {{ contactUrlOverride?: string, forceBrowser?: boolean }} */ (
    request.body ?? {}
  )
  const contactUrlOverride =
    typeof body.contactUrlOverride === 'string' && body.contactUrlOverride.trim()
      ? body.contactUrlOverride.trim()
      : null
  const forceBrowser = body.forceBrowser === true

  const { data: site, error: siteErr } = await supabase
    .from('sourced_websites')
    .select('id, domain')
    .eq('id', sourcedWebsiteId)
    .maybeSingle()
  if (siteErr || !site?.domain) {
    return reply.code(404).send({ error: 'sourced_website not found' })
  }

  const result = await discoverDomain(site.domain, {
    sourcedWebsiteId: site.id,
    supabase,
    logger: fastify.log,
    contactUrlOverride,
    forceBrowser,
  })

  await persistDiscovery({ sourcedWebsiteId: site.id, result, supabase, logger: fastify.log })

  return reply.code(200).send({
    sourced_website_id: site.id,
    domain: site.domain,
    result,
  })
})

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
    fastify.log.info(`Prospect form-fill worker listening on port ${PORT}`)

    // Resume any batches that were running when the previous process exited.
    // Fire-and-forget — recoverOnStartup spawns long-running runSubmissionBatch
    // tasks per recovered batch and we don't want to block HTTP listening.
    if (supabaseEnabled) {
      recoverOnStartup({ supabase, logger: fastify.log }).catch((err) => {
        fastify.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Startup recovery threw',
        )
      })
    }
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
