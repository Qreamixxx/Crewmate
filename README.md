# Crewmate

You never skip the flight you paid for. You skip the 6 a.m. run that cost nothing.

Crewmate puts a few dollars on the things friends promise each other. A crew sets a challenge ("6 a.m. run, Tuesday and Thursday, $5 each"), everyone who taps "I'm in" has money on it, and whoever skips owes the crew. Crewmate never holds the money and never takes a cut. It earns from Plus, a subscription for the whole crew.

Web only, no build step, no dependencies: one Node server, one HTML file, SQLite.

## Run it

    node server.js          # needs Node 22.13 or newer; there is nothing to install
    # then open http://localhost:3000

## Check it

| Command | What it proves |
|---|---|
| `npm test` (`node sim/features-test.js`) | 179 checks over the real HTTP API: accounts, crew challenges, proof by check-in time and photo, stakes and debts, the Stripe webhook, browser push, reminders, freezes, doubts, invite links |
| `npm run sim` (`node sim/simulate.js`) | 100 users, 25 groups, 14 days of daily plans. Every user-day is compared with an independent model of the rules, and several hundred cheating attempts must all be refused. Last run: `sim/last-run.json` |
| `npm run month` (`node sim/month.js`) | 100 people, 28 crews, 30 days of crew challenges. Every debt, challenge day and check-in in the database is compared with an independent count. Last run: `sim/month-run.json` |

Each command starts its own server on a temporary database, so `data.db` is never touched.

The two simulations assume how people behave (how often they show up, who quits, how fast debts are settled). Those assumptions are written at the top of each file. The correctness checks are real; the usage numbers are an illustration, not a measurement of real users.

## What is in the repo

| File | What it is |
|---|---|
| `server.js` | The whole backend: HTTP API, SQLite (`node:sqlite`), day closing, challenges, push, Stripe webhook. A contents list is at the top of the file |
| `public/index.html` | The whole frontend: a single page with no framework and no build step |
| `public/sw.js` | Service worker: makes the site installable and shows notifications |
| `public/admin.html` | Usage numbers for the owner (off unless `ADMIN_TOKEN` is set) |
| `sim/` | The feature test and the two simulations |

## How it works

**Crew challenges.** A new user starts by setting a challenge: what, when (every day, chosen weekdays or one date) and how much. That creates the crew and an invite link. Nothing is on a friend until they tap "I'm in"; the wall lists who has not answered. On every day a challenge runs, it becomes an ordinary task plus a stake for each person who is in, so scoring, debts, streaks and doubts are the same code as for a personal plan. That also happens for someone who never opens the app that day, so silence counts as a skip. A challenge stake cannot be lowered and its task cannot be removed or renamed. Leaving stops future days; a day already on the plan still counts.

**Proof, optional per challenge or per task.** A check-in time (the tick only works within 15 minutes of it, in the crew's timezone) and/or a photo (shrunk in the browser, stored as a small JPEG, shown only to the crew). Friends can also doubt a tick: with money on the day, it counts as a miss when more than half of the others, and at least two people, doubt it.

**Days close lazily.** There is no midnight job. Whenever a crew is read, every finished day is scored once (`done`, `missed`, `none`, or a frozen variant) inside one transaction, and missed stakes become debts. A crew's day ends at midnight in the timezone of whoever created it.

**Money never moves in the app.** The ledger records who owes the crew. A friend who was in the crew on the missed day confirms the payment; the debtor cannot.

**Personal plans.** Besides challenges, each person can post tasks for today. The first task puts $2 (or the crew minimum) on the day. For 10 minutes, before anything is ticked, that can be lowered or removed; after that the stake only goes up and the plan is locked.

**Free and Plus.** A free crew holds 3 people, runs one challenge at a time and allows stakes up to $5. Plus removes the member and challenge limits, allows stakes up to $50 and gives 3 streak freezes a week (1 on free). Plus is switched on only by a signed, paid Stripe `checkout.session.completed` event and off by `customer.subscription.deleted`; nothing in the browser can unlock it.

**Notifications.** Browser push with no dependencies and nothing to configure: the signing key pair is made on first start and kept in the database. The push carries no content. It wakes the service worker, which asks the server what to show, so nothing private passes through the push service, and only real browser push services are accepted as addresses. Sent: a reminder 30 minutes before a timed check-in opens, an evening reminder when tasks are left, a friend finishing a task or joining a challenge, nudges and reactions, and who skipped yesterday and what they owe. On iPhone it works once Crewmate is added to the home screen.

**Around it.** Streaks with a weekly freeze, an activity feed, reactions, nudges (one per friend per day), a weekly recap with a public share link, a sample crew for visitors, link previews for invite links, and an installable web app.

**Accounts and safety.** Passwords are hashed with scrypt; the session is an HttpOnly cookie that expires after 30 days. A recovery code, shown once, resets a forgotten password. Login allows 8 wrong passwords per 10 minutes, and sign-ups are limited per address. Responses carry a Content-Security-Policy and related headers.

## Deploy

Any host that runs Node 22.13+ works. Start command: `node server.js`. Put `DB_FILE` on a persistent disk: it holds the accounts, the crews and the push signing key.

| Variable | What it does |
|---|---|
| `PORT`, `DB_FILE` | Port (default 3000) and database path (default `data.db` next to `server.js`) |
| `STRIPE_LINK` | Stripe Payment Link for Plus. The app appends `?client_reference_id=<crew id>` |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of a Stripe webhook pointed at `POST /api/stripe/webhook` |
| `PLUS_PRICE` | Price text shown on the Plus page; set it to what you charge in Stripe |
| `FREE_MEMBERS` | People in a free crew (default 3) |
| `VAPID_SUBJECT` | `mailto:` address that push services can contact; set it in production |
| `CHECKIN_WINDOW_MIN` | Minutes before and after a check-in time during which the tick works (default 15) |
| `CHECKIN_PING_MIN` | Minutes before a check-in time at which the reminder goes out (default 30) |
| `REMIND_HOUR` | Hour of the evening reminder, crew time (default 19) |
| `STAKE_GRACE_MS` | How long a new personal stake can be lowered or removed (default 10 minutes) |
| `SIGNUP_LIMIT` | Sign-ups per address per 10 minutes (default 20). Behind a host's proxy the visitor's address is read from the proxy's headers |
| `FREEZES_OFF` | Set to 1 to turn streak freezes off |
| `ADMIN_TOKEN` | Enables `/admin.html` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME` | Optional Telegram reminders; hidden in the app unless set |
| `SIM_CLOCK_FILE` | Test only: lets `sim/month.js` move the server's date forward. Leave unset |

The app runs without any of them. Without the Stripe variables the Plus page shows "Checkout opens soon".

## Not built yet

- **Deposits.** Today a skipped day is a debt between friends, kept on a tab. Paying in up front, refunded when you show up, is the next step and is not implemented.
- **Live checkout.** The Stripe webhook is implemented and tested; a Payment Link has to be created and configured before anyone can pay.
- **XP, levels and badges.** The server still computes them, but they are no longer shown on any screen: the product is a commitment tool, and the streak, the feed and the money carry it.
