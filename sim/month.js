// A month of crew challenges: 100 people, 28 crews, 30 days, driven through the real HTTP API.
// Run: node sim/month.js   (starts its own server on a temporary database; your data.db is not touched)
//
// What is real: every request goes through the server, days pass by moving the server's test clock
// (SIM_CLOCK_FILE), and every debt in the database is compared with an independent count kept here.
// What is assumed: how people behave (how often they show up, who quits, how fast debts are settled).
// Those numbers are set in ASSUME below. The output shows what the product records under those
// assumptions; it is not a measurement of real users.
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const DB = path.join(os.tmpdir(), 'crewmate-month.db'), CLOCK = path.join(os.tmpdir(), 'crewmate-month.clock');
for (const f of [DB, DB + '-wal', DB + '-shm', CLOCK]) fs.rmSync(f, { force: true });
const PORT = 3231, BASE = `http://localhost:${PORT}`, SECRET = 'whsec_month', DAYS = 30;

const ASSUME = {
  showUpMin: 0.50, showUpMax: 0.95, // each person has their own chance of showing up on a challenge day
  weekendFactor: 0.85,              // people show up a little less on Saturday and Sunday
  neverAnswers: 0.12,               // invited friends who join the crew but never tap "I'm in"
  answerDelay: [0.60, 0.25, 0.15],  // "I'm in" on the day of the invite, the next day, two days later
  quitPerWeekBase: 0.02, quitPerWeekSlope: 0.12, // weekly chance of leaving the challenge; higher for people who show up less
  opensAppWhenSkipping: 0.40,       // someone who skips still opens the app that day
  nudgeChance: 0.25,                // a friend who showed up nudges one who has not
  settlePerDay: 0.30,               // chance per day that a friend confirms an open debt as paid
  plusCrews: 4, plusCrewSize: 7, freeCrews: 24, freeCrewSize: 3, // 4*7 + 24*3 = 100 people
};

// seeded random numbers, so every run gives the same month
let seed = 20261115;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];

let requests = 0; const unexpected = [];
async function call(u, method, p, body, okStatuses = [200]) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie: (u && u.cookie) || '' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  requests++;
  const sc = r.headers.get('set-cookie'); if (sc && u) u.cookie = sc.split(';')[0];
  let j = {}; try { j = await r.json(); } catch {}
  if (!okStatuses.includes(r.status)) unexpected.push({ method, p, s: r.status, e: j.error });
  if (u) u.active = true;
  return { s: r.status, j };
}
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dowOf = d => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0

(async () => {
  fs.writeFileSync(CLOCK, '0');
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DB_FILE: DB, SIM_CLOCK_FILE: CLOCK, SIGNUP_LIMIT: '100000', STRIPE_WEBHOOK_SECRET: SECRET, FREE_MEMBERS: '3' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => { if (!/Experimental|trace-warnings/.test(d)) process.stderr.write(d); });
  await new Promise(r => srv.stdout.on('data', d => /on http/.test(d) && r()));
  const day0 = new Date().toISOString().slice(0, 10);

  // ---- the cast
  let n = 0; const person = () => ({ name: 'P' + (++n), r: ASSUME.showUpMin + (ASSUME.showUpMax - ASSUME.showUpMin) * rnd(), cookie: '', id: 0, in: false, left: false, signed: false });
  const crews = [];
  const mk = (size, plus, startDay) => {
    const people = Array.from({ length: size }, person), rr = rnd();
    for (const [i, u] of people.entries()) {
      if (i === 0) { u.answerDay = startDay; continue; } // the creator is in from the start
      const x = rnd(); u.joinDay = startDay + (x < 0.6 ? 0 : x < 0.85 ? 1 : 2);
      const y = rnd(); u.answerDay = rnd() < ASSUME.neverAnswers ? null : u.joinDay + (y < ASSUME.answerDelay[0] ? 0 : y < ASSUME.answerDelay[0] + ASSUME.answerDelay[1] ? 1 : 2);
    }
    crews.push({ plus, startDay, people, days: rr < 0.35 ? '' : rr < 0.70 ? '024' : '13', stake: plus ? 10 : (rnd() < 0.4 ? 2 : 5), gid: 0, cid: 0, code: '' });
  };
  for (let i = 0; i < ASSUME.plusCrews; i++) mk(ASSUME.plusCrewSize, true, i);
  for (let i = 0; i < ASSUME.freeCrews; i++) mk(ASSUME.freeCrewSize, false, i % 10); // crews start over the first ten days
  const everyone = crews.flatMap(c => c.people);

  // ---- the month
  const perDay = []; let expDebts = 0, expDollars = 0;
  for (let d = 0; d < DAYS; d++) {
    fs.writeFileSync(CLOCK, String(d));
    const date = addDays(day0, d), dow = dowOf(date), weekend = dow >= 5;
    for (const u of everyone) u.active = false;
    const row = { day: d + 1, date, due: 0, checkedIn: 0, skipped: 0, owed: 0, nudges: 0, settled: 0 };
    for (const c of crews) {
      if (d < c.startDay) continue;
      const [boss, ...rest] = c.people;
      if (d === c.startDay) {
        await call(boss, 'POST', '/api/signup', { name: boss.name, password: 'secret1' }); boss.signed = true;
        boss.id = (await call(boss, 'GET', '/api/me')).j.user.id;
        const g = (await call(boss, 'POST', '/api/groups', { name: 'Crew ' + crews.indexOf(c), tz: 'UTC' })).j; c.gid = g.id; c.code = g.code;
        if (c.plus) { // the organiser pays: Plus is switched on by a signed Stripe event, exactly as in production
          const ev = { type: 'checkout.session.completed', data: { object: { payment_status: 'paid', client_reference_id: String(c.gid), subscription: 'sub_' + c.gid } } }, ts = Math.floor(Date.now() / 1000);
          const r = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${crypto.createHmac('sha256', SECRET).update(ts + '.' + JSON.stringify(ev)).digest('hex')}` }, body: JSON.stringify(ev) });
          requests++; if (r.status !== 200) unexpected.push({ p: 'webhook', s: r.status });
        }
        c.cid = (await call(boss, 'POST', `/api/groups/${c.gid}/challenges`, { title: pick(['6 a.m. run', 'Gym', 'Study hour', 'Morning walk', 'Swim']), stake: c.stake, days: c.days })).j.id;
        boss.in = true;
      }
      for (const u of rest) {
        if (u.joinDay === d) { await call(u, 'POST', '/api/signup', { name: u.name, password: 'secret1' }); u.signed = true; u.id = (await call(u, 'GET', '/api/me')).j.user.id; await call(u, 'POST', '/api/join', { code: c.code }); }
        if (u.answerDay === d) { await call(u, 'POST', `/api/challenges/${c.cid}/join`, {}); u.in = true; }
      }
      const on = !c.days || c.days.includes(String(dow));
      const showed = [], missing = [];
      for (const u of c.people) {
        if (!u.in || u.left) continue;
        // once a week (counted from the day they said yes) a person may quit the challenge
        const quits = u !== boss && d > u.answerDay && (d - u.answerDay) % 7 === 0 && rnd() < ASSUME.quitPerWeekBase + ASSUME.quitPerWeekSlope * (ASSUME.showUpMax - u.r);
        if (quits) { await call(u, 'POST', `/api/challenges/${c.cid}/leave`, {}); u.left = true; u.leftDay = d; }
        if (!on) continue;
        row.due++; // the day they quit still counts, as the product says
        const shows = !quits && rnd() < u.r * (weekend ? ASSUME.weekendFactor : 1);
        if (shows) {
          const me = (await call(u, 'GET', `/api/groups/${c.gid}/wall`)).j.members.find(m => m.me), t = me.tasks.find(x => x.challenge_id === c.cid);
          if (t && !t.done) await call(u, 'POST', `/api/tasks/${t.id}/toggle`, {});
          row.checkedIn++; showed.push(u);
        } else {
          row.skipped++; row.owed += c.stake; expDebts++; expDollars += c.stake; missing.push(u);
          if (!quits && rnd() < ASSUME.opensAppWhenSkipping) await call(u, 'GET', `/api/groups/${c.gid}/wall`);
        }
      }
      for (const m of missing) for (const s of showed) if (rnd() < ASSUME.nudgeChance) { await call(s, 'POST', `/api/groups/${c.gid}/nudge`, { user_id: m.id }); row.nudges++; }
      // friends confirm debts that were paid back
      const anyone = c.people.find(u => u.signed);
      if (anyone) {
        const led = (await call(anyone, 'GET', `/api/groups/${c.gid}/ledger`)).j;
        for (const debt of led.debts.filter(x => !x.paid)) {
          if (rnd() >= ASSUME.settlePerDay) continue;
          const friend = c.people.find(u => u.signed && u.id !== debt.user_id && (u === boss ? c.startDay : u.joinDay) <= d - 1);
          if (!friend) continue;
          const r = await call(friend, 'POST', `/api/debts/${debt.id}/paid`, {}, [200, 400]); // 400: that friend joined after the missed day
          if (r.s === 200) row.settled += debt.amount;
        }
      }
    }
    row.activeUsers = everyone.filter(u => u.active).length;
    row.signedUp = everyone.filter(u => u.signed).length;
    row.inChallenge = everyone.filter(u => u.in && !u.left).length;
    perDay.push(row);
  }
  // close the last day
  fs.writeFileSync(CLOCK, String(DAYS));
  for (const c of crews) await call(c.people[0], 'GET', `/api/groups/${c.gid}/wall`);

  // ---- what the database says, against what was counted here
  const db = new DatabaseSync(DB); db.exec('PRAGMA busy_timeout=5000');
  const one = (q, ...a) => db.prepare(q).get(...a);
  const dbDebts = one('SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM debts'), dbPaid = one('SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM debts WHERE paid=1');
  const dbTasks = one('SELECT COUNT(*) c, COALESCE(SUM(done),0) d FROM tasks WHERE challenge_id IS NOT NULL AND day<?', addDays(day0, DAYS));
  const perDayMismatch = perDay.filter(r => { const x = one('SELECT COUNT(*) c, COALESCE(SUM(done),0) d FROM tasks WHERE challenge_id IS NOT NULL AND day=?', r.date); return x.c !== r.due || x.d !== r.checkedIn; }).map(r => r.day);
  const due = perDay.reduce((s, r) => s + r.due, 0), came = perDay.reduce((s, r) => s + r.checkedIn, 0);
  const said = everyone.filter(u => u.in).length;
  const out = {
    setup: { people: everyone.length, crews: crews.length, days: DAYS, freeCrews: ASSUME.freeCrews, plusCrews: ASSUME.plusCrews, seed: 20261115 },
    assumptions: ASSUME,
    requests: { total: requests, unexpected: unexpected.length, sample: unexpected.slice(0, 5) },
    correctness: { debtsCounted: expDebts, debtsInDb: dbDebts.c, dollarsCounted: expDollars, dollarsInDb: dbDebts.s, challengeDaysCounted: due, challengeDaysInDb: dbTasks.c, checkInsCounted: came, checkInsInDb: dbTasks.d, daysThatDisagree: perDayMismatch },
    totals: { saidImIn: said, neverAnswered: everyone.length - said, stillInOnDay30: everyone.filter(u => u.in && !u.left).length, quit: everyone.filter(u => u.left).length, challengeDays: due, checkIns: came, showUpRate: +(came / due).toFixed(3), skips: due - came, dollarsOwed: dbDebts.s, dollarsSettled: dbPaid.s, nudges: perDay.reduce((s, r) => s + r.nudges, 0), plusCrewsPaying: one('SELECT COUNT(*) c FROM groups WHERE plus=1').c },
    perDay,
  };
  db.close();
  fs.writeFileSync(path.join(__dirname, 'month-run.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ setup: out.setup, requests: out.requests, correctness: out.correctness, totals: out.totals }, null, 2));
  srv.kill(); process.exit(unexpected.length || perDayMismatch.length || expDebts !== dbDebts.c || expDollars !== dbDebts.s ? 1 : 0);
})();
