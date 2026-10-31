# usage-limiter

Leave Claude Code running overnight without burning your week.

usage-limiter is a Claude Code plugin for Pro and Max subscriptions. It stops work safely before your usage limits run out, and writes a hand-off note so the work can pick up where it left off.

Claude Code already stops at 100%. That is too late if you need the rest of the week, and a hard stop can cut a task in half. usage-limiter stops earlier, at your number, at a safe point.

## What it does

- **Stops at your threshold.** You choose the numbers, for the 5-hour window, the weekly window, or both. Nothing is limited until you set one. New work is blocked: shell commands, agents, workflows, schedules, and edits. Reading files stays allowed.
- **Writes a hand-off note.** Claude finishes the current step and writes `CONTINUE.md` in the project root: what's done, what's half done, the exact next step. That note is the only file it can write while stopped.
- **Resumes when you say so.** Type `continue` (Turkish: `devam et`), or raise the limit, and Claude picks up from `CONTINUE.md`.
- **Resumes after the reset (experimental).** When the window resets, the plugin tells Claude to read `CONTINUE.md` and carry on. This path is covered by tests but not yet proven in long real runs; please open an issue if it misbehaves.
- **Paces the work.** Once usage passes half your threshold, Claude is told where usage stands and when it resets. That helps it checkpoint instead of starting a big job it can't finish.
- **Ignores automatic prompts while stopped.** `/loop` ticks, scheduled wakeups, and background notifications don't start new turns.

The status line shows both windows, for example `5-hour 42%/90% · weekly 64%/70%`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-limiter --marketplace ugurcanakkoc/usage-limiter
```

Answer `y` to add the marketplace, then pick the **user** scope so it runs in every session.

From a shell:

```
claude plugin install usage-limiter --marketplace ugurcanakkoc/usage-limiter
```

## Commands

| Command | Effect |
| --- | --- |
| `/limit` | Show usage, thresholds, and reset times |
| `/limit 50` | Stop at 50% of both the 5-hour and the weekly limit |
| `/limit h90 w70` | Set them apart: `h` = 5-hour, `w` = weekly |
| `/limit h3` | Limit only the 5-hour window; weekly is unlimited (`/limit w20`: only weekly) |
| `/limit off` | Turn the limiter off |
| `/limit on` | Turn it back on with the last numbers you set |

Not sure what numbers to use? Run `/limit` first to see your current usage. Setting a number turns the limiter on. `%` is optional: `/limit 50%` works too.

## How it measures

Claude Code receives the account's usage figures with every model response. The plugin reads the weekly (`seven_day`) and 5-hour (`five_hour`) windows from them, so the session doing the work always has a current number. Usage from other devices or sessions shows up with this session's next response.

API-key usage reports no usage windows, so the limiter stays idle there.

## Limits

- It makes no network requests and sends nothing anywhere. It only reads the usage figures Claude Code already has.
- This is a soft brake inside Claude Code. It does not change your plan's limits or billing.
- The first response of a new session goes through before any reading exists.
- Auto-resume needs the session to stay open until the reset.
- If the plugin itself fails while stopped, tool calls are refused (fail-closed).

## License

MIT
