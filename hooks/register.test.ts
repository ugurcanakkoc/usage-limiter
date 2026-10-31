import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-01T02:00:00Z')
const WEEK_RESET = '2026-11-07T00:00:00Z'
const FIVE_RESET = '2026-11-01T03:00:00Z'
const reading = (weekly: number, fiveHour = 10) => ({
  context: { window: 200000 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: weekly, resetsAt: WEEK_RESET },
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: FIVE_RESET },
  ],
  changed: ['rateLimits'],
}) as any

async function setup($: any, on: any, limit = 'h90 w70') {
  const seen = { timers: [] as { ms: number; fn: () => void }[], prompts: [] as string[] }
  const store = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'limit' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', () => ({ changed: [] }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_: any, e: any) => (seen.prompts.push(e.text), { text: e.text }))
  on('clock.now', () => ({ value: NOW }))
  // A clock.after dispatch fires its timer when the hook resolves: the test holds the release.
  on('clock.after', (_: any, e: any) => new Promise(fire => seen.timers.push({ ms: e.ms, fn: () => fire({ value: undefined }) })))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  await $.session.start({ cwd: '/work/game', surface: 'terminal', isInteractive: true })
  if (limit) await $.command.run({ command: 'limit', args: limit } as any)
  return seen
}

const bash = async ($: any) => (await $.tool.call({ tool: 'Bash', command: 'ls' })).deny

test('weekly threshold stops work, keeps the note writable, resumes on "continue"', async ($, on) => {
  await setup($, on)

  await $.session.measure(reading(50))
  expect(await bash($)).toBeUndefined()

  await $.session.measure(reading(71))
  expect(await bash($)).toMatch(/Bash blocked/)
  expect((await $.tool.call({ tool: 'Write', file_path: '/p/src/app.ts', content: '' })).deny).toMatch(/blocked/)
  expect((await $.tool.call({ tool: 'Write', file_path: '/p/CONTINUE.md', content: '' })).deny).toBeUndefined()

  // An automatic prompt neither runs nor lifts the stop.
  expect(((await $.prompt.submit({ text: 'continue', isMeta: true } as any)) as any).drop).toBeDefined()
  expect(await bash($)).toMatch(/blocked/)

  await $.prompt.submit({ text: 'devam et' } as any)
  expect(await bash($)).toBeUndefined()
  await $.session.measure(reading(80))
  expect(await bash($)).toBeUndefined()
})

test('5-hour threshold stops, then resumes by itself at the reset', async ($, on) => {
  const seen = await setup($, on)
  await $.session.measure(reading(30, 92))
  expect(await bash($)).toMatch(/blocked/)

  const timer = seen.timers.at(-1)!
  expect(timer.ms).toBe(Date.parse(FIVE_RESET) - NOW + 60_000)
  timer.fn()
  // The resume runs on the timer, outside this call: give it a few dispatches to land.
  for (let i = 0; i < 20 && !seen.prompts.length; i++) await bash($)
  expect(await bash($)).toBeUndefined()
  expect(seen.prompts.at(-1)).toMatch(/CONTINUE\.md/)
})

test('off, on, number turns it on, percent forms', async ($, on) => {
  await setup($, on)
  await $.session.measure(reading(75))
  expect(await bash($)).toMatch(/blocked/)
  await $.command.run({ command: 'limit', args: 'off' } as any)
  expect(await bash($)).toBeUndefined()
  await $.command.run({ command: 'limit', args: 'on' } as any)
  expect(await bash($)).toMatch(/blocked/)
  await $.command.run({ command: 'limit', args: 'off' } as any)
  // A bare number sets both windows and turns it back on; "%" is accepted either side.
  await $.command.run({ command: 'limit', args: '%70' } as any)
  expect(await bash($)).toMatch(/blocked/)
  await $.command.run({ command: 'limit', args: '80%' } as any)
  expect(await bash($)).toBeUndefined()
  await $.session.measure(reading(10, 81))
  expect(await bash($)).toMatch(/blocked/)
  // h = 5-hour, w = weekly, set apart.
  await $.command.run({ command: 'limit', args: 'h95 w20' } as any)
  expect(await bash($)).toBeUndefined()
  await $.session.measure(reading(25, 81))
  expect(await bash($)).toMatch(/blocked/)
  await $.session.measure(reading(10, 81))
  expect(await bash($)).toBeUndefined()
  await $.command.run({ command: 'limit', args: '%h3' } as any)
  expect(await bash($)).toMatch(/blocked/)
  // Naming one window leaves the other unlimited.
  await $.session.measure(reading(99, 1))
  expect(await bash($)).toBeUndefined()
  await $.command.run({ command: 'limit', args: 'w20' } as any)
  expect(await bash($)).toMatch(/blocked/)
  await $.session.measure(reading(10, 99))
  expect(await bash($)).toBeUndefined()
  expect((await $.command.run({ command: 'limit', args: 'banana' } as any) as any).text).toMatch(/h90 w70/)
})

test('nothing is limited until a number is set', async ($, on) => {
  await setup($, on, '')
  await $.session.measure(reading(99, 99))
  expect(await bash($)).toBeUndefined()
  expect(((await $.command.run({ command: 'limit', args: 'on' } as any)) as any).text).toMatch(/No limit set yet/)
  expect(await bash($)).toBeUndefined()
})
