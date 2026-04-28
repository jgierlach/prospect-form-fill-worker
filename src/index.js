import Fastify from 'fastify'
import secureJsonParse from 'secure-json-parse'
import { supabaseEnabled } from './supabase.js'

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
 * Step 3 (skeleton): validates auth + batch id, logs, returns 202. The actual
 * submission runner lands in step 5.
 */
fastify.post('/batches/:id/run', async (request, reply) => {
  if (!supabaseEnabled) {
    return reply.code(500).send({ error: 'Worker not configured (missing SUPABASE env vars)' })
  }

  const { id } = /** @type {{ id: string }} */ (request.params)
  if (!id) {
    return reply.code(400).send({ error: 'Batch id is required' })
  }

  fastify.log.info({ batchId: id }, '[run] batch trigger received (no-op until submission runner lands)')

  return reply.code(202).send({ batch_id: id, status: 'accepted' })
})

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
    fastify.log.info(`Prospect form-fill worker listening on port ${PORT}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
