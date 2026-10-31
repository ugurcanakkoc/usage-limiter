import type { Register, SessionRateLimit } from 'claude-code'

// Usage limiter for Claude Code subscriptions.
// - Past the weekly or 5-hour threshold: blocks tools that start new work, drops automatic prompts,
//   tells the model to stop at a safe point and write CONTINUE.md.
// - When the window resets: resumes by itself (or on "continue").
// - Near the limits: tells the model where usage stands so it can pace large work.
const DEFAULTS = { weekly: 70, fiveHour: 90 }
const NOTE = 'CONTINUE.md'
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'TaskStop'])
const RESUME = /^\s*continue\b/i
const WINDOWS = { seven_day: 'weekly', five_hour: '5-hour' } as const
type Kind = keyof typeof WINDOWS
const KINDS = Object.keys(WINDOWS) as Kind[]

const STOP = `USAGE THRESHOLD REACHED. Do not start new work, agents, workflows or commands.
1. Stop at a safe point without leaving the current step half done.
2. Write ${NOTE} in the project root: what is done, what is half done, the exact next step (command/file/decision).
3. Tell the user in two lines that you stopped; work resumes when the usage window resets, or when they type "continue".`

const RESUMED = `The usage window has reset (usage-limiter). Read ${NOTE} in the project root and continue from its next step. Delete ${NOTE} once its work is done.`

const HELP = `/limit           status: current usage, thresholds, reset times
/limit on        turn the limiter on with the saved thresholds
/limit 50        stop at 50% of both the 5-hour and the weekly limit
/limit h90 w70   set them apart: h = 5-hour, w = weekly
/limit h3        limit the 5-hour window only (weekly unlimited); /limit w20 the other way
/limit off       turn the limiter off
/limit reset     back to defaults (h90 w70)
Setting a number also turns the limiter on.`

type Settings = { on: boolean; weekly: number; fiveHour: number }

async function settings($: any): Promise<Settings> {
  const s = ((await $.store.get('settings')) ?? {}) as Partial<Settings>
  return { on: s.on ?? true, weekly: s.weekly ?? DEFAULTS.weekly, fiveHour: s.fiveHour ?? DEFAULTS.fiveHour }
}
async function save($: any, patch: Partial<Settings>) {
  await $.store.set('settings', { ...(await settings($)), ...patch })
}

const limits: Partial<Record<Kind, SessionRateLimit>> = {}
let stopped: { kinds: Kind[]; resetsAt?: string } | undefined
let resumeTimer: { cancel(): void } | undefined

const threshold = (s: Settings, k: Kind) => (k === 'seven_day' ? s.weekly : s.fiveHour)
// A reading whose window already reset says nothing about the new window.
const live = (k: Kind, now: number) => {
  const r = limits[k]
  return r && !(r.resetsAt && Date.parse(r.resetsAt) <= now) ? r : undefined
}
const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?'

function statusLine(s: Settings, now: number) {
  if (!s.on) return 'Limiter off'
  const part = (k: Kind) => `${WINDOWS[k]} ${live(k, now)?.percentUsed ?? 0}%/${threshold(s, k) || 'no limit'}${threshold(s, k) ? '%' : ''}`
  return `${part('five_hour')} · ${part('seven_day')}${stopped ? ' · STOPPED' : ''}`
}

async function evaluate($: any, readings: SessionRateLimit[]) {
  for (const r of readings) if (r.kind in WINDOWS) limits[r.kind as Kind] = r
  const s = await settings($)
  const now = await $.clock.now()
  const paused = ((await $.store.get('paused')) ?? {}) as Partial<Record<Kind, string>>
  const over = KINDS.filter(k => {
    const r = live(k, now)
    const t = threshold(s, k)
    return s.on && r && t > 0 && r.percentUsed >= t && paused[k] !== (r.resetsAt ?? 'manual')
  })
  if (over.length && !stopped) {
    // Resume once every window that tripped has reset.
    const resetsAt = over.map(k => limits[k]!.resetsAt).filter(Boolean).sort().pop()
    stopped = { kinds: over, resetsAt }
    const what = over.map(k => `${WINDOWS[k]} ${limits[k]!.percentUsed}%`).join(', ')
    $.ui.toast(`Usage ${what} reached the threshold: stopping work safely. Resumes ${when(resetsAt)}, or type "continue".`)
    resumeTimer?.cancel()
    if (resetsAt) resumeTimer = $.clock.after(Math.max(0, Date.parse(resetsAt) - now) + 60_000, () => void resume($, true))
  } else if (!over.length && stopped) {
    stopped = undefined
    resumeTimer?.cancel()
  }
  $.ui.status(statusLine(s, now))
}

async function resume($: any, byTimer: boolean) {
  stopped = undefined
  resumeTimer?.cancel()
  resumeTimer = undefined
  $.ui.toast(byTimer ? 'Usage window reset: resuming work.' : 'Limiter paused until this usage window resets.')
  $.ui.status(statusLine(await settings($), await $.clock.now()))
  if (byTimer) void $.prompt.submit({ text: RESUMED })
}

// While stopped: reads stay open, writes only to the hand-off note, everything else is denied.
function allowedWhileStopped(e: any) {
  if (READ_ONLY.has(e.tool)) return true
  if (e.tool !== 'Write' && e.tool !== 'Edit') return false
  return String(e.file_path ?? '').split(/[\\/]/).pop() === NOTE
}

// Shown to the model once a window passes half its threshold; bucketed to 10% so the system
// prompt (and its cache) rarely changes.
async function pacing($: any) {
  const s = await settings($)
  if (!s.on) return undefined
  const now = await $.clock.now()
  const rows = KINDS.flatMap(k => {
    const r = live(k, now)
    const t = threshold(s, k)
    if (!r || !t || r.percentUsed < t / 2) return []
    return [`- ${WINDOWS[k]} window: ~${Math.floor(r.percentUsed / 10) * 10}% used, limiter stops at ${t}%, resets ${when(r.resetsAt)}`]
  })
  if (!rows.length) return undefined
  return `Subscription usage (usage-limiter):
${rows.join('\n')}
Pace the work to this budget: finish and checkpoint the current task before starting large new ones, keep parallel agents and workflows few, and note progress often. If the next step is large and the remaining budget is small, finish what is in flight and write ${NOTE} instead; the limiter resumes the work after the reset.`
}

async function report($: any) {
  const s = await settings($)
  const now = await $.clock.now()
  const row = (k: Kind) => {
    const r = live(k, now)
    const t = threshold(s, k)
    // Without a live reading, say why: none reported yet, or the last one is from a window that has reset.
    const used = r ? `${r.percentUsed}%`.padStart(4) : limits[k] ? '   - (window reset, waiting for a reading)' : '   - (not reported yet)'
    return `${WINDOWS[k].padEnd(7)} ${used} / stop at ${t ? `${t}%` : 'no limit'}${r ? ` · resets ${when(r.resetsAt)}` : ''}`
  }
  const head = s.on ? 'Limiter on' : 'Limiter OFF (turn on with /limit on, /limit 50 or /limit h90 w70)'
  const stop = stopped ? ` · STOPPED until ${when(stopped.resetsAt)} (type "continue" to go on now)` : ''
  return `${head}${stop}
${row('five_hour')}
${row('seven_day')}`
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    // rateLimits come from the last API response; re-read them in case a subagent's response moved them.
    $.clock.every(2 * 60 * 1000, async () => evaluate($, (await $.session.usage()).rateLimits))
    await $.command.register({ name: 'limit', description: 'Usage limiter: /limit, /limit on, /limit 50, /limit h90 w70, /limit off, /limit reset' })
    const r = await next(e)
    await evaluate($, (await $.session.usage()).rateLimits)
    return r
  })

  on('session.measure', async ($, e, next) => {
    await evaluate($, e.rateLimits)
    return next(e)
  })

  // Fail closed: if this hook throws while stopped, the tool is refused.
  on('tool.call', async ($, e, next) =>
    stopped && !allowedWhileStopped(e)
      ? { deny: `usage-limiter: usage threshold reached, ${e.tool} blocked. Stop safely and write ${NOTE}.` }
      : next(e),
  ).catch(($, e, next) =>
    next.called || !stopped ? next(e) : { deny: 'usage-limiter: guard failed while stopped.' },
  )

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const text = stopped ? STOP : await pacing($)
    return text ? { sections: [...r.sections, { id: 'usage-limiter', text, scope: 'session' as const }] } : r
  })

  on('prompt.submit', async ($, e, next) => {
    if (!stopped) return next(e)
    // Automatic prompts (loops, schedules, notifications) neither resume nor run while stopped.
    if (e.isMeta) return { drop: 'usage-limiter: usage threshold reached, automatic prompt dropped.' }
    if (!e.command && RESUME.test(e.text)) {
      const paused = ((await $.store.get('paused')) ?? {}) as Partial<Record<Kind, string>>
      for (const k of stopped.kinds) paused[k] = limits[k]?.resetsAt ?? 'manual'
      await $.store.set('paused', paused)
      await resume($, false)
    }
    return next(e)
  })

  on('command.run', { command: 'limit' }, async ($, e) => {
    // "/limit 50" sets both windows; "/limit h3 w20" sets them apart; "%" is ignored. A number turns it on.
    const words = e.args.trim().toLowerCase().replace(/%/g, '').split(/\s+/).filter(Boolean)
    const numbers = words.map(w => /^(h|w)?(\d{1,3})$/.exec(w))
    const [a = ''] = words
    if (a === 'on' || a === 'off') await save($, { on: a === 'on' })
    else if (a === 'reset') { await $.store.set('settings', {}); await $.store.set('paused', {}) }
    else if (words.length && numbers.every(Boolean)) {
      // Only the windows named are limited: "/limit h3" leaves the weekly window unlimited, and the other way round.
      const set: Settings = { on: true, fiveHour: 0, weekly: 0 }
      for (const [, which, n] of numbers as RegExpExecArray[]) {
        if (which !== 'w') set.fiveHour = Math.min(100, Number(n))
        if (which !== 'h') set.weekly = Math.min(100, Number(n))
      }
      await save($, set)
    }
    else if (words.length) return { text: HELP }
    await evaluate($, (await $.session.usage()).rateLimits)
    return { text: await report($) }
  })
}
