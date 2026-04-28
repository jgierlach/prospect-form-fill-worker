/**
 * Recent stable Chrome desktop UAs across macOS / Windows / Linux. Kept
 * intentionally narrow — wide UA pools draw more attention from fingerprinters
 * than they avoid. The viewport randomization in browser.js does the heavier
 * lifting on differentiation.
 */
const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

/** @returns {string} */
export function pickUserAgent() {
  return UAS[Math.floor(Math.random() * UAS.length)]
}

/** Common desktop viewport sizes — both 16:9 and 16:10 to look natural. */
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
]

/** @returns {{ width: number, height: number }} */
export function pickViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]
}
