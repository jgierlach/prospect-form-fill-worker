/**
 * Static-HTML fingerprints for site builders that render forms client-side.
 * Each builder's signatures are intentionally specific — false-positive here
 * means a wasted Playwright launch (~3-5s + chromium memory) when a plain
 * static refetch would have done. False-negative means we skip Playwright on
 * a site that needs it and discovery returns no_form_found.
 *
 * Order matters only for logging clarity — first match wins.
 */
const BUILDER_SIGNATURES = [
  {
    name: 'wix',
    patterns: [
      /static\.wixstatic\.com/i,
      /static\.parastorage\.com/i,
      /<meta[^>]+name=["']generator["'][^>]+content=["']Wix\.com/i,
      /_wixCIDX|wix-bolt|wixBiSession/,
    ],
  },
  {
    name: 'squarespace',
    patterns: [
      /static1\.squarespace\.com/i,
      /Static\.SQUARESPACE_CONTEXT/,
      /<meta[^>]+name=["']generator["'][^>]+content=["']Squarespace/i,
    ],
  },
  {
    name: 'webflow',
    patterns: [
      /assets\.website-files\.com/i,
      /assets-global\.website-files\.com/i,
      /<html[^>]+data-wf-site=/i,
      /webflow\.js/i,
    ],
  },
  {
    name: 'duda',
    patterns: [
      /irp\.cdn-website\.com/i,
      /static\.cdn-website\.com/i,
      /<meta[^>]+name=["']generator["'][^>]+content=["']Duda/i,
    ],
  },
  {
    name: 'site123',
    patterns: [/site123\.com/i, /<meta[^>]+name=["']generator["'][^>]+content=["']SITE123/i],
  },
  {
    name: 'godaddy_websites',
    patterns: [/img1\.wsimg\.com/i, /<meta[^>]+name=["']generator["'][^>]+content=["']GoDaddy Website Builder/i],
  },
  // WordPress sites are technically SSR but their form widgets (Elementor
  // Pro, WPForms, Contact Form 7) are commonly JS-injected into a placeholder
  // container — the static HTML has the widget shell (data-form-id /
  // wpforms-container / wpcf7) but no `<form>` tag yet. Treating these as
  // "SPA-like" so the crawler escalates to Playwright recovers the form.
  // Sites that DO render the form server-side already match the form-shape
  // check in fetchHtmlSmart and never need this escalation, so the cost is
  // bounded to actually-needed cases.
  {
    name: 'elementor',
    patterns: [
      /<meta[^>]+name=["']generator["'][^>]+content=["']Elementor/i,
      /data-elementor-type=["'][^"']+["']/i,
      /class=["'][^"']*\belementor-form\b/i,
    ],
  },
  {
    name: 'wpforms',
    patterns: [
      /class=["'][^"']*\bwpforms-(?:container|form)\b/i,
      /wpforms\.elementor\.com/i,
      /id=["'][^"']*wpforms-form-/i,
    ],
  },
  {
    name: 'contact_form_7',
    patterns: [/class=["'][^"']*\bwpcf7\b/i, /\/wp-content\/plugins\/contact-form-7\//i],
  },
]

/**
 * Identify a JS-rendered site builder from raw HTML. Returns the builder name
 * (e.g. 'wix') when matched, otherwise null. Caller uses the name as a hint
 * to escalate to Playwright; the value is also persisted in
 * prospect_form_cache.form_builder for downstream stats.
 *
 * @param {string} html
 * @returns {string | null}
 */
export function detectSpaBuilder(html) {
  if (typeof html !== 'string' || html.length === 0) return null
  for (const { name, patterns } of BUILDER_SIGNATURES) {
    if (patterns.some((p) => p.test(html))) return name
  }
  return null
}
