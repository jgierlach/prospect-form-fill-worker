import { launchSession, closeSession } from '../src/submission/browser.js'
import { fillForm } from '../src/submission/filler.js'
import { writeFile } from 'node:fs/promises'

const session = await launchSession({ logger: console })
try {
  await session.page.goto('https://httpbin.org/forms/post', { waitUntil: 'domcontentloaded', timeout: 30000 })

  // Hand-crafted mapping matching httpbin's form (verified by inspection)
  const fieldMapping = {
    full_name: 'input[name="custname"]',
    phone: 'input[name="custtel"]',
    email: 'input[name="custemail"]',
    message: 'textarea[name="comments"]',
  }
  const payload = {
    full_name: 'Jan Test',
    phone: '+1 555 555 5555',
    email: 'outreach@example.com',
    message: 'This is a smoke test of the prospect-form-fill-worker filler pipeline.',
  }

  const result = await fillForm({ page: session.page, fieldMapping, payload, logger: console })
  console.log('\nFILL RESULT:', JSON.stringify(result, null, 2))

  const png = await session.page.screenshot({ fullPage: true, type: 'png' })
  await writeFile('/tmp/smoke-fill.png', png)
  console.log('Saved screenshot to /tmp/smoke-fill.png (' + png.length + ' bytes)')

  // Read back the values to confirm they actually landed in the DOM.
  const readback = await session.page.evaluate(() => ({
    full_name: /** @type {HTMLInputElement} */ (document.querySelector('input[name="custname"]'))?.value,
    phone: /** @type {HTMLInputElement} */ (document.querySelector('input[name="custtel"]'))?.value,
    email: /** @type {HTMLInputElement} */ (document.querySelector('input[name="custemail"]'))?.value,
    message: /** @type {HTMLTextAreaElement} */ (document.querySelector('textarea[name="comments"]'))?.value,
  }))
  console.log('READBACK:', JSON.stringify(readback, null, 2))
} finally {
  await closeSession(session)
}
