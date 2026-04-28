/**
 * Smoke test for Decodo proxy wiring. Two paths:
 *   1. No DECODO env vars → launches without proxy, warning logged.
 *   2. Fake DECODO env vars → launches WITH proxy config, navigation will
 *      eventually fail (no real Decodo session), but launch + config build
 *      should succeed.
 *
 * Run: node scripts/smoke-decodo.mjs
 */
import { launchSession, closeSession } from '../src/submission/browser.js'

async function pathA() {
  console.log('\n=== Path A: no Decodo env vars ===')
  delete process.env.DECODO_USERNAME
  delete process.env.DECODO_PASSWORD
  const session = await launchSession({ logger: console })
  console.log({
    proxyEnabled: session.proxyEnabled,
    sessionId: session.sessionId,
    bytes: session.getBytesUsed(),
  })
  // Quick navigation against httpbin to verify the box's IP is used and bytes are tracked.
  await session.page.goto('https://httpbin.org/ip', { waitUntil: 'domcontentloaded', timeout: 15000 })
  console.log({ bytesAfterNav: session.getBytesUsed() })
  await closeSession(session)
}

async function pathB() {
  console.log('\n=== Path B: fake Decodo env vars ===')
  process.env.DECODO_USERNAME = 'fake-user'
  process.env.DECODO_PASSWORD = 'fake-pass'
  process.env.DECODO_HOST = 'gate.decodo.com'
  process.env.DECODO_PORT = '10001'
  const session = await launchSession({ logger: console })
  console.log({
    proxyEnabled: session.proxyEnabled,
    sessionId: session.sessionId,
    bytes: session.getBytesUsed(),
  })
  // Try a navigation. With fake creds Decodo should reject, leading to a
  // proxy auth error. The launch and config-build still succeed — that's what
  // we're proving.
  try {
    await session.page.goto('https://httpbin.org/ip', { waitUntil: 'domcontentloaded', timeout: 8000 })
    console.log('navigation unexpectedly succeeded; bytes=', session.getBytesUsed())
  } catch (err) {
    console.log('navigation failed as expected:', err instanceof Error ? err.message : String(err))
  }
  await closeSession(session)
}

await pathA()
await pathB()
console.log('\nDone.')
