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
