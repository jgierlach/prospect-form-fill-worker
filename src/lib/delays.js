/**
 * Promise-based sleep.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Random integer in [min, max] inclusive.
 * @param {number} min
 * @param {number} max
 */
export function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

/**
 * Per-character delay for human-like typing. Most chars 50–150ms. Roughly 1
 * in 8 characters gets a longer "thinking" pause (300–600ms) to mimic a
 * cursor moving / pausing mid-word. Caps total runtime so a 500-char message
 * doesn't burn 90 seconds.
 *
 * @returns {number} delay in ms for the *next* keystroke
 */
export function nextTypeDelay() {
  const base = randInt(50, 150)
  if (Math.random() < 0.12) return base + randInt(300, 600)
  return base
}

/** Inter-field pause when moving from one input to the next. */
export function nextFieldPause() {
  return randInt(250, 700)
}
