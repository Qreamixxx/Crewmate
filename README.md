# Crewmate
You never skip the flight you paid for. You skip the 6 a.m. run that cost nothing. Crewmate puts a few dollars on the things friends promise each other: a crew sets a challenge, everyone who is in has money on it, and whoever skips owes the crew. Crewmate never holds the money and never takes a cut; it earns from the Plus subscription for the crew.

## Crew challenges
- A new user starts by setting a challenge: what, when (every day, chosen weekdays, or one date) and how much. That creates the crew and gives an invite link.
- Being in means betting: joining a challenge puts its stake on every day it runs. The stake cannot be lowered and the task cannot be removed or renamed. Friends who have not answered are listed on the wall.
- On each day it runs, the challenge becomes an ordinary task plus a stake for everyone who is in, so scoring, debts, streaks and doubts work as for a personal plan. This also happens for someone who never opens the app that day, so silence counts as a skip.
- Leaving stops future days; a day already on the plan still counts. Ending (creator or crew owner) takes effect the next day.
- Optional proof, per challenge or per personal task: a check-in time (the tick only works within 15 minutes of it, in the crew's timezone; `CHECKIN_WINDOW_MIN` changes that) and/or a photo (shrunk in the browser, stored as a small JPEG, shown only to the crew).
- Free crews run one challenge at a time with stakes up to $5; Plus lifts both.

## Run
    node server.js        # Node 22.13+, no npm install needed
    open http://localhost:3000

## Deploy (live link)
Any host that runs Node 22+ works (Render, Railway, Fly.io). Start command: `node server.js`. Mount a persistent disk and set `DB_FILE=/data/data.db`. Needs Node 22.13+ (`node:sqlite` without a flag).

Payments (optional, the app runs without them):
- `STRIPE_LINK`: a Stripe Payment Link URL for Plus. The app appends `?client_reference_id=<group id>`.
- `STRIPE_WEBHOOK_SECRET`: signing secret of a Stripe webhook pointed at `POST /api/stripe/webhook`, event `checkout.session.completed`.
- `PLUS_PRICE`: text shown on the Plus page, e.g. the price you set in Stripe.

## How it works
- `server.js`: HTTP API + SQLite (built-in `node:sqlite`). Passwords hashed with scrypt, HttpOnly session cookie.
- Days close lazily: whenever a group is read, every finished day is scored once (`done` / `missed` / `none`) and missed stakes become ledger debts. No midnight job.
- Streaks and week dots are computed from the `results` table.
- Money never moves in the app. The ledger tracks who owes the group; a friend (not the debtor) confirms payment.
- A group's day ends at midnight in the timezone of whoever created it (taken from their browser, fixed at creation). Groups made before this change stay on UTC.
- Default bet: the first task of the day puts $2 (or the crew minimum) on it. For 10 minutes, before anything is ticked, it can be lowered or switched to None and staked tasks can be removed. After that the stake only goes up and the plan is locked. The crew creator can set a minimum daily stake ($0 to $5 free, up to $50 on Plus). The minimum applies on days you post a plan; not posting stays visible on the wall.
- Stake rules (older, still true after the grace window): you need a plan before you can stake; once staked, the stake only goes up and tasks cannot be removed; a staked day with no plan counts as missed. Only a friend who was in the group on the missed day can confirm payment.
- Plus: free crews hold 3 people (`FREE_MEMBERS` changes that; the tests run with 4), one challenge at a time and $2/$5 stakes; Plus lifts the member cap and adds $10 stakes. It is switched on only by a signed Stripe `checkout.session.completed` webhook.
- `public/index.html`: single-page frontend, no build step. The wall refreshes every 8 s.
- Nudge: a friend can poke someone who has not finished today (one nudge per friend per day). The invite link shows the group name before sign-up. Login is limited to 8 wrong passwords per 10 minutes.

## Gamification and profile pictures
- XP is computed from the data (never stored): 10 per ticked task (at most 5 tasks a day count, so padding a plan earns nothing), 25 per fully finished day, 15 more when money was on that day, 3 per nudge or cheer (max 30). Levels at 0/50/150/300/500/800/1200/1800/2600/3600 XP: Rookie, Regular, Grinder, Machine, Veteran, Beast, Legend, Mythic, Immortal, Mastermind.
- 10 badges (first win, 3/7/21/30-day streaks, comeback, high roller, skin in the game, paid up, hype man), shown on each card and on the Account page with locked ones greyed.
- Weekly crew quest: the group ticks 10 tasks per member together; a progress bar sits on the wall.
- A "+10 XP" pop-up on every tick, with confetti on a level-up.
- Profile photos: the browser crops and shrinks the photo to 160x160 JPEG; the server accepts only a small real JPEG and only shows it to people who share a group with you. No photo shows the first letter of the name.

## Notifications
- Browser push with no dependencies and nothing to configure: the signing key pair is made on first start and kept in the database (so keep `DB_FILE` on a persistent disk). People switch it on from the wall or the Account page. On iPhone it works once Crewmate is added to the home screen.
- The push carries no content. It wakes the service worker, which asks `/api/push/latest` what to show, so nothing private passes through the push service. Only real browser push services are accepted as addresses.
- What is sent: a reminder 30 minutes before a timed check-in opens (`CHECKIN_PING_MIN`), the evening "tasks left, money on the line" reminder, a friend finishing a task or joining a challenge, nudges and reactions, and who skipped yesterday and what they owe.
- Set `VAPID_SUBJECT` to `mailto:` your address in production; push services use it to contact the sender.
- Telegram still works if its variables are set, and stays hidden otherwise.

## Social layer, freezes, install
- Reactions (👏 🔥 💪 😮) on friends' finished tasks; the owner is notified.
- Activity feed on the wall ("Dana finished Gym · 5 min ago") and a 🔔 inbox with a notification for every task a friend finishes (once per task, no duplicates on re-tick). Telegram copies can be muted on the Account page.
- Streak freeze: one skipped day per week keeps the streak alive (3 per week with Plus). A frozen day still costs the stake if money was on it. `FREEZES_OFF=1` disables it.
- Installable web app (manifest, icons, service worker) and link previews: `/join/CODE` and `/r/TOKEN` serve Open Graph tags so chats show "Join <crew> on Crewmate". Native alert/prompt/confirm boxes are replaced by in-page dialogs.
- Admin stats: set `ADMIN_TOKEN`, open `/admin.html`, enter the token. Real usage only (sample groups excluded).

## Optional settings (environment variables)
| Variable | What it does |
|---|---|
| `PORT`, `DB_FILE` | Port and database path (put `DB_FILE` on a persistent disk) |
| `STRIPE_LINK`, `STRIPE_WEBHOOK_SECRET`, `PLUS_PRICE` | Plus checkout. The webhook also switches Plus off on `customer.subscription.deleted` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME` | Turns on Telegram reminders (evening, 7pm group time; change with `REMIND_HOUR`) and nudge messages |
| `STAKE_GRACE_MS` | How long a new bet can be lowered/removed (default 600000 = 10 minutes) |
| `ADMIN_TOKEN` | Enables `/admin.html` usage numbers (off if unset) |
| `FREEZES_OFF` | Set to 1 to turn streak freezes off |
| `SIGNUP_LIMIT` | Sign-ups per IP per 10 minutes (default 20). Behind a host's proxy the visitor's address is taken from the proxy's headers |
| `CHECKIN_WINDOW_MIN` | Minutes before and after a check-in time during which the tick works (default 15) |

## Tests
- `node sim/simulate.js`: 100 users, 25 groups, 14 days (details below).
- `node sim/features-test.js`: 167 checks for browser push (signed with the server key, address allow-list, dropped subscriptions), the pre-check-in reminder, crew challenges (join, floor on the stake, skip without opening the app, leave, end), proof by check-in time and photo, XP cap, reactions, feed, notifications, freezes, link previews, PWA files, admin gate, recovery codes, password change, session expiry, invite reset, leave rules, custom stakes and the Plus gate, doubts, public recap, sample group, Telegram link and reminders (against a fake Telegram server).

## Simulation
`node sim/simulate.js` starts the server on a temp database and runs 100 users in 25 groups for 14 days (about 9,500 requests). Days are advanced by shifting dates in the database. It checks every user-day against an independent model of the rules (results, debts, streaks), and fires cheating attempts that must all be refused. Last run: `sim/last-run.json`. User behaviour (reliability, drop-out, who stakes) is assumed, not measured, so the product numbers are illustrative; the correctness checks are real.
