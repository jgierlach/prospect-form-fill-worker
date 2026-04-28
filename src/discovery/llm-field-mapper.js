import Anthropic from '@anthropic-ai/sdk'

const DEFAULT_MODEL = 'claude-sonnet-4-6'

// 8000 chars ≈ 2000 tokens — generous headroom for the prompt scaffolding +
// JSON response while keeping per-call cost negligible. Forms longer than
// this almost always carry tracking pixels / surrounding chrome we'd discard
// anyway; the relevant <input>/<textarea>/<button> nodes are early.
const MAX_FORM_CHARS = 8000

const SEMANTIC_KEYS = [
  'first_name',
  'last_name',
  'full_name',
  'email',
  'phone',
  'company',
  'website',
  'subject',
  'message',
  'submit_button',
]

/**
 * Build the spec §7.6 prompt. Kept in this file (not a constant elsewhere)
 * so the trim limit, key list, and instructions stay co-located.
 *
 * @param {string} formHtml
 */
function buildPrompt(formHtml) {
  const trimmed = formHtml.length > MAX_FORM_CHARS ? formHtml.slice(0, MAX_FORM_CHARS) : formHtml
  return [
    "You are mapping a contact form's fields to a standard schema. Given the HTML below, return ONLY a JSON object mapping these semantic keys to CSS selectors (or null if the field doesn't exist):",
    SEMANTIC_KEYS.join(', ') + '.',
    '',
    'Use the most specific selector that uniquely identifies the field (prefer name= attributes, fall back to id=, then class+type combos). For radio/select fields matching a semantic key, include the selector AND a `_value` key with the option to select.',
    '',
    'Include `_confidence` as a float 0–1 based on how obvious the mapping was.',
    '',
    'HTML:',
    '```',
    trimmed,
    '```',
    '',
    'Respond with only JSON, no prose, no markdown fences.',
  ].join('\n')
}

/**
 * Pull the first JSON object out of free text. Claude usually obeys the
 * "no prose" instruction but markdown fences slip through occasionally; the
 * regex grabs the outermost {...} block. Returns null on parse failure.
 *
 * @param {string} text
 */
function extractJson(text) {
  if (!text) return null
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

/**
 * @typedef {{
 *   mapping: Record<string, string>,
 *   confidence: number,
 *   tokensUsed: number,
 *   model: string
 * }} LlmMappingResult
 */

/**
 * Send the form HTML to Claude and return a semantic→selector mapping.
 * Throws when the API call fails or returns an unparseable response — the
 * caller decides whether to fall back to the heuristic mapping.
 *
 * @param {{
 *   formHtml: string,
 *   apiKey?: string,
 *   model?: string,
 *   logger?: { info: Function, debug: Function, warn: Function }
 * }} args
 * @returns {Promise<LlmMappingResult>}
 */
export async function mapFieldsViaLLM({
  formHtml,
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  logger = console,
}) {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set')
  }
  if (!formHtml || formHtml.length === 0) {
    throw new Error('formHtml is empty')
  }

  const client = new Anthropic({ apiKey })
  const prompt = buildPrompt(formHtml)

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })

  const textBlock = response.content.find((c) => c.type === 'text')
  const text = textBlock && 'text' in textBlock ? textBlock.text : ''
  const parsed = extractJson(text)
  if (!parsed) {
    logger.warn({ rawText: text.slice(0, 300) }, '[llm-field-mapper] could not parse JSON')
    throw new Error('LLM returned unparseable JSON')
  }

  // Strip null entries — the worker treats missing keys as "not on this form"
  // anyway. Pull out _confidence; everything else is a selector.
  const confidence = typeof parsed._confidence === 'number' ? parsed._confidence : 0
  /** @type {Record<string, string>} */
  const mapping = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue
    if (typeof value === 'string' && value.trim().length > 0) {
      mapping[key] = value.trim()
    }
  }

  const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)
  logger.info(
    { tokensUsed, confidence, mappedKeys: Object.keys(mapping).length, model },
    '[llm-field-mapper] mapping returned',
  )

  return { mapping, confidence, tokensUsed, model }
}

/**
 * Does a mapping cover the keys needed to file a meaningful contact-form
 * submission? Email is where the reply lands; message is the actual outreach
 * payload. Name is *not* required — plenty of legitimate contact forms
 * (wpforms.com, Ghost-style minimal forms, support tickets) skip it.
 *
 * Used by the runner to decide whether the heuristic was good enough or we
 * need the LLM to take a swing.
 *
 * @param {Record<string, string>} mapping
 */
export function hasRequiredKeys(mapping) {
  if (!mapping) return false
  if (!mapping.email) return false
  if (!mapping.message) return false
  return true
}
