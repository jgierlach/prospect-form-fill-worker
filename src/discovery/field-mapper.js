/**
 * @typedef {import('./extractor.js').FormField} FormField
 *
 * @typedef {{
 *   first_name?: string,
 *   last_name?: string,
 *   full_name?: string,
 *   email?: string,
 *   phone?: string,
 *   company?: string,
 *   website?: string,
 *   subject?: string,
 *   message?: string,
 *   submit_button?: string,
 * }} FieldMapping
 *
 * @typedef {{ mapping: FieldMapping, confidence: number, unmapped: FormField[] }} MappingResult
 */

/**
 * Heuristic patterns for matching a field's name/id/placeholder/label/autocomplete
 * against semantic keys. Order matters within the array — first match per key
 * wins. Patterns are deliberately tight to avoid spurious matches (e.g.
 * `message` matches "your message" but not "newsletter messages").
 *
 * Tied to step 4 only; the LLM-driven mapper in step 8 replaces this for hard
 * cases (HubSpot/Webflow) but the heuristic stays as a fast/free first pass.
 *
 * @type {Array<{ key: keyof FieldMapping, patterns: RegExp[], requireType?: string }>}
 */
const RULES = [
  // Order: most specific keys first so `first_name` wins over generic `name`.
  {
    key: 'first_name',
    patterns: [/\bfirst[-_\s]?name\b/i, /\bfname\b/i, /\bgiven[-_\s]?name\b/i, /\bforename\b/i, /^first$/i],
  },
  {
    key: 'last_name',
    patterns: [/\blast[-_\s]?name\b/i, /\blname\b/i, /\bsurname\b/i, /\bfamily[-_\s]?name\b/i, /^last$/i],
  },
  {
    key: 'email',
    patterns: [/\bemail\b/i, /\be-?mail[-_\s]?address\b/i, /^email$/i],
    requireType: 'email-or-text', // email type input or text-with-name=email
  },
  {
    key: 'phone',
    patterns: [/\bphone\b/i, /\btel(ephone)?\b/i, /\bmobile\b/i, /\bcontact[-_\s]?number\b/i],
  },
  {
    key: 'company',
    patterns: [/\bcompany\b/i, /\borganization\b/i, /\borganisation\b/i, /\bbusiness[-_\s]?name\b/i, /\bemployer\b/i],
  },
  {
    key: 'website',
    patterns: [/\bwebsite\b/i, /\b(business[-_\s]?)?url\b/i, /\bdomain\b/i, /\bweb[-_\s]?address\b/i],
  },
  {
    key: 'subject',
    patterns: [/\bsubject\b/i, /\btopic\b/i, /\breason[-_\s]?for[-_\s]?contact\b/i, /\binquiry[-_\s]?type\b/i],
  },
  {
    key: 'message',
    patterns: [
      /\bmessage\b/i,
      /\bcomment\b/i,
      /\binquiry\b/i,
      /\bquery\b/i,
      /\bquestion\b/i,
      /\bproject[-_\s]?details\b/i,
      /\bdetails\b/i,
      /\bhow[-_\s]+can[-_\s]+we[-_\s]+help\b/i,
      /\btell[-_\s]+us\b/i,
      /\bnotes\b/i,
    ],
  },
  // full_name LAST — generic "name" should only match when no first/last
  // already mapped.
  {
    key: 'full_name',
    patterns: [/\b(your[-_\s]?)?name\b/i, /\bfull[-_\s]?name\b/i, /\bfullname\b/i, /^name$/i],
  },
]

/**
 * Build the haystack string that gets pattern-matched. Combines the field's
 * five most informative attributes; lowercased for case-insensitive regex.
 *
 * @param {FormField} f
 */
function haystackOf(f) {
  return [f.name, f.id, f.placeholder, f.label, /** @type {string|null} */ ('')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * Map extracted form fields to the spec's standard semantic keys, returning
 * a confidence score based on which "required" keys (email, message, and
 * either first_name+last_name or full_name) were resolved.
 *
 * @param {FormField[]} fields
 * @returns {MappingResult}
 */
export function mapFields(fields) {
  /** @type {FieldMapping} */
  const mapping = {}
  /** @type {Set<string>} */
  const usedSelectors = new Set()
  /** @type {FormField[]} */
  const unmapped = []

  // Bias message → textarea, email → input[type=email] when available, before
  // running pattern matching. Cheap correctness win on noisy forms.
  const textarea = fields.find((f) => f.tag === 'textarea')
  if (textarea) {
    mapping.message = textarea.selector
    usedSelectors.add(textarea.selector)
  }
  const emailField = fields.find((f) => f.tag === 'input' && f.type === 'email')
  if (emailField) {
    mapping.email = emailField.selector
    usedSelectors.add(emailField.selector)
  }

  for (const field of fields) {
    if (usedSelectors.has(field.selector)) continue
    const haystack = haystackOf(field)

    for (const rule of RULES) {
      if (mapping[rule.key]) continue
      if (rule.patterns.some((p) => p.test(haystack))) {
        mapping[rule.key] = field.selector
        usedSelectors.add(field.selector)
        break
      }
    }
  }

  for (const field of fields) {
    if (!usedSelectors.has(field.selector)) unmapped.push(field)
  }

  // Confidence: a contact form needs at minimum email + message + some name.
  const hasEmail = !!mapping.email
  const hasMessage = !!mapping.message
  const hasName = !!mapping.full_name || !!mapping.first_name
  const required = [hasEmail, hasMessage, hasName].filter(Boolean).length
  const confidence = required / 3

  return { mapping, confidence, unmapped }
}
