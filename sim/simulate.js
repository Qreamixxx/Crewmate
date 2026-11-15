// Simulation: 100 users, 25 groups, 14 days against the real server.
// Run: node sim/simulate.js   (starts its own server on a temp database)
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const USERS = +process.env.USERS || 100, GROUP_SIZE = 4, DAYS = +process.env.DAYS || 14, PORT = 3222, SEED = 7;
const DB = path.join(os.tmpdir(), 'crewmate-sim.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
const BASE = `http://localhost:${PORT}/api`;

let s = SEED; const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];

const lat = []; const counts = { total: 0, unexpected: 0 }; const unexpectedLog = [];
async function call(user, method, p, body, expectFail = false) {
  const t0 = performance.now();
  const r = await fetch(BASE + '/' + p, { method, headers: { 'content-type': 'application/json', cookie: user.cookie || '' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  lat.push(performance.now() - t0); counts.total++;
  const sc = r.headers.get('set-cookie'); if (sc) user.cookie = sc.split(';')[0];
  let j = {}; try { j = await r.json(); } catch {}
  if (!expectFail && !r.ok) { counts.unexpected++; if (unexpectedLog.length < 5) unexpectedLog.push(`${method} ${p} -> ${r.status} ${j.error}`); }
  return { status: r.status, ok: r.ok, j };
}
async function pool(items, fn, n = 100) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }

function shiftDays(n = 1) {
  const db = new DatabaseSync(DB); db.exec('PRAGMA busy_timeout=5000');
  const sh = (t, c) => db.exec(`UPDATE ${t} SET ${c}=date(${c},'-${n} day')`);
  db.exec('BEGIN'); [['tasks','day'],['stakes','day'],['results','day'],['debts','day'],['nudges','day'],['groups','created'],['groups','closed_through'],['members','joined']].forEach(([t,c]) => sh(t,c)); db.exec('COMMIT'); db.close();
}

(async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DB_FILE: DB, SIGNUP_LIMIT: '100000', FREEZES_OFF: '1', FREE_MEMBERS: '4' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => { if (!/ExperimentalWarning|trace-warnings/.test(d)) process.stderr.write(d); });
  await new Promise(r => srv.stdout.on('data', d => /on http/.test(d) && r()));
  const T0 = Date.now();

  // ---- users with personalities (assumptions, not measurements) ----
  const users = Array.from({ length: USERS }, (_, i) => ({
    i, name: `sim${i}`, pw: 'secret123', cookie: '',
    reliability: 0.45 + rnd() * 0.53,           // chance a given task gets done
    postProb: 0.7 + rnd() * 0.28,               // chance of posting a plan on a day
    stakeProb: rnd() < 0.55 ? 0.35 + rnd() * 0.5 : 0, // 45% of people never stake
    quitDay: rnd() < 0.35 ? 3 + Math.floor(rnd() * (DAYS - 3)) : Infinity, // 35% drop out
    group: Math.floor(i / GROUP_SIZE),
  }));
  await pool(users, u => call(u, 'POST', 'signup', { name: u.name, password: u.pw }));

  // ---- groups: first member creates, the other three join by invite link ----
  const groups = [];
  for (let g = 0; g < USERS / GROUP_SIZE; g++) {
    const mem = users.filter(u => u.group === g), owner = mem[0];
    const r = await call(owner, 'POST', 'groups', { name: `Crew ${g}`, tz: 'America/New_York' });
    groups.push({ id: r.j.id, code: r.j.code, members: mem });
    await Promise.all(mem.slice(1).map(u => call(u, 'POST', 'join', { code: r.j.code })));
  }
  // free groups hold 4: a 5th person must be refused
  const extra = { cookie: '' }; await call(extra, 'POST', 'signup', { name: 'extra5', password: 'secret123' });
  const capCheck = await call(extra, 'POST', 'join', { code: groups[0].code }, true);

  // ---- oracle: what the rules say should happen ----
  const expect = new Map(); // `${uid}|${day}` -> {status, stake}
  const metrics = { postedDaysPerDay: [], doneDays: 0, missedDays: 0, nonePosted: 0, nudgesSent: 0, paidConfirmed: 0 };
  const cheat = { tried: 0, blocked: 0, leaked: [] };
  const userIdOf = new Map();
  for (const u of users) { const m = await call(u, 'GET', 'me'); userIdOf.set(u.i, m.j.user.id); }

  for (let day = 1; day <= DAYS; day++) {
    const active = users.filter(u => day < u.quitDay);
    // morning: everyone opens the wall (this also closes yesterday)
    const walls = new Map();
    await pool(users, async u => { const r = await call(u, 'GET', `groups/${groups[u.group].id}/wall`); walls.set(u.i, r.j); });

    // friends confirm debts from earlier misses (60% do, a day later)
    const ledgers = new Map();
    await pool(users.filter(u => rnd() < 0.5), async u => {
      const l = await call(u, 'GET', `groups/${groups[u.group].id}/ledger`);
      for (const d of l.j.debts.filter(d => !d.paid && d.user_id !== l.j.me && rnd() < 0.6)) { const r = await call(u, 'POST', `debts/${d.id}/paid`, {}, true); if (r.ok) metrics.paidConfirmed++; }
    });

    // plan, stake, tick
    let posted = 0;
    await pool(active, async u => {
      if (rnd() > u.postProb) return;
      const gid = groups[u.group].id, n = 1 + Math.floor(rnd() * 4), ids = [];
      for (let k = 0; k < n; k++) await call(u, 'POST', `groups/${gid}/tasks`, { title: `Task ${k + 1} day ${day}` });
      const w = (await call(u, 'GET', `groups/${gid}/wall`)).j.members.find(m => m.me);
      // A $2 bet goes on automatically with the first task. Some people turn it off, some raise it.
      let stake = 2;
      if (u.stakeProb === 0) { stake = 0; await call(u, 'POST', `groups/${gid}/stake`, { amount: 0 }); }
      else if (rnd() < 0.5) { stake = 5; await call(u, 'POST', `groups/${gid}/stake`, { amount: 5 }); }
      let allDone = true;
      for (const t of w.tasks) { if (rnd() < u.reliability) await call(u, 'POST', `tasks/${t.id}/toggle`, {}); else allDone = false; }
      posted++;
      expect.set(`${userIdOf.get(u.i)}|${day}`, { status: allDone ? 'done' : 'missed', stake, user: u.i });
    });
    metrics.postedDaysPerDay.push(posted);

    // friends nudge quiet people (mechanism check; no behavioural effect assumed)
    await pool(users.filter(u => day < u.quitDay && rnd() < 0.2), async u => {
      const wl = (await call(u, 'GET', `groups/${groups[u.group].id}/wall`)).j;
      const quiet = wl.members.find(m => !m.me && !m.total);
      if (quiet) { const r = await call(u, 'POST', `groups/${groups[u.group].id}/nudge`, { user_id: quiet.id }, true); if (r.ok) metrics.nudgesSent++; }
    });

    // cheating attempts: all must be refused
    const cheaters = Array.from({ length: 8 }, () => pick(users));
    for (const c of cheaters) {
      const other = groups[(c.group + 1) % groups.length], mine = groups[c.group];
      const myWall = (await call(c, 'GET', `groups/${mine.id}/wall`)).j.members.find(m => m.me);
      const peer = users.find(x => x.group === c.group && x.i !== c.i);
      const peerWall = (await call(c, 'GET', `groups/${mine.id}/wall`)).j.members.find(m => m.id === userIdOf.get(peer.i));
      const attempts = [
        ['tick a friend\'s task', peerWall.tasks[0] && (() => call(c, 'POST', `tasks/${peerWall.tasks[0].id}/toggle`, {}, true))],
        ['read another group\'s wall', () => call(c, 'GET', `groups/${other.id}/wall`, undefined, true)],
        ['read another group\'s ledger', () => call(c, 'GET', `groups/${other.id}/ledger`, undefined, true)],
        ['post a task in another group', () => call(c, 'POST', `groups/${other.id}/tasks`, { title: 'x' }, true)],
        ['lower own stake after ticking', myWall.stake && myWall.done > 0 ? () => call(c, 'POST', `groups/${mine.id}/stake`, { amount: myWall.stake === 5 ? 2 : 0 }, true) : null],
        ['delete a task after staking and ticking', myWall.stake && myWall.done > 0 && myWall.tasks[0] ? () => call(c, 'POST', `tasks/${myWall.tasks[0].id}/delete`, {}, true) : null],
        ['$10 stake on a free group', () => call(c, 'POST', `groups/${mine.id}/stake`, { amount: 10 }, true)],
      ];
      for (const [name, f] of attempts) { if (!f) continue; const r = await f(); cheat.tried++; if (r.ok) cheat.leaked.push(`${c.name}: ${name}`); else cheat.blocked++; }
      const led = (await call(c, 'GET', `groups/${mine.id}/ledger`)).j;
      const own = led.debts.find(d => d.user_id === led.me && !d.paid);
      if (own) { const r = await call(c, 'POST', `debts/${own.id}/paid`, {}, true); cheat.tried++; r.ok ? cheat.leaked.push(`${c.name}: cleared own debt`) : cheat.blocked++; }
    }
    shiftDays(1); // the day ends
  }

  // close the final day
  await pool(users, u => call(u, 'GET', `groups/${groups[u.group].id}/wall`));
  const wallMs = performance.now();

  // ---- verification against the oracle, straight from the database ----
  const db = new DatabaseSync(DB);
  const mism = [];
  const dbRes = db.prepare('SELECT user_id,status FROM results WHERE user_id=? ORDER BY day').all.bind(db.prepare('SELECT 1'));
  const resBy = new Map(), debtBy = new Map();
  for (const r of db.prepare('SELECT user_id,day,status FROM results').all()) { (resBy.get(r.user_id) || resBy.set(r.user_id, []).get(r.user_id)).push(r); }
  let expectedDebt = 0, dbDebt = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM debts').get().s, expectedDebtCount = 0;
  for (const [k, e] of expect) {
    const [uid, d] = k.split('|'); const u = +uid;
    if (e.status === 'done') metrics.doneDays++; else metrics.missedDays++;
    if (e.status === 'missed' && e.stake) { expectedDebt += e.stake; expectedDebtCount++; }
  }
  // status per (user, dayIndex): results rows sorted by day; users who posted on day d must have that status at position d-1
  let checked = 0;
  for (const u of users) {
    const rows = (resBy.get(userIdOf.get(u.i)) || []).sort((a, b) => a.day < b.day ? -1 : 1);
    for (let d = 1; d <= DAYS; d++) {
      const e = expect.get(`${userIdOf.get(u.i)}|${d}`), got = rows[d - 1] && rows[d - 1].status;
      const want = e ? e.status : 'none'; checked++;
      if (got !== want) mism.push(`${u.name} day ${d}: expected ${want}, got ${got}`);
    }
  }
  const dbDebtCount = db.prepare('SELECT COUNT(*) c FROM debts').get().c;
  const dupDebts = db.prepare('SELECT COUNT(*) c FROM (SELECT 1 FROM debts GROUP BY group_id,user_id,day HAVING COUNT(*)>1)').get().c;
  const paidRows = db.prepare('SELECT COUNT(*) c FROM debts WHERE paid=1').get().c;
  const selfPaid = db.prepare('SELECT COUNT(*) c FROM debts WHERE paid=1 AND paid_by=user_id').get().c;

  // streak check via the API
  let streakBad = 0;
  await pool(users, async u => {
    const m = (await call(u, 'GET', `groups/${groups[u.group].id}/wall`)).j.members.find(x => x.me);
    let st = 0; for (let d = DAYS; d >= 1; d--) { const e = expect.get(`${userIdOf.get(u.i)}|${d}`); if (e && e.status === 'done') st++; else break; }
    if (m.streak !== st) streakBad++;
  });

  const sorted = [...lat].sort((a, b) => a - b), pc = p => sorted[Math.floor(sorted.length * p)].toFixed(1);
  const secs = (Date.now() - T0) / 1000;
  const totalDays = Array.from(expect.values()).length;
  const out = {
    setup: { users: USERS, groups: groups.length, days: DAYS },
    requests: { total: counts.total, unexpectedErrors: counts.unexpected, sample: unexpectedLog, perSecond: Math.round(counts.total / secs), p50ms: +pc(.5), p95ms: +pc(.95), p99ms: +pc(.99), maxMs: +sorted[sorted.length - 1].toFixed(1) },
    correctness: { userDaysChecked: checked, resultMismatches: mism.length, mismatchSample: mism.slice(0, 5), debtsExpected: expectedDebtCount, debtsInDb: dbDebtCount, debtDollarsExpected: expectedDebt, debtDollarsInDb: dbDebt, duplicateDebts: dupDebts, selfPaidDebts: selfPaid, streakMismatches: streakBad, freeCapRefusedFifthMember: capCheck.status === 402 },
    cheating: { attempts: cheat.tried, blocked: cheat.blocked, leaked: cheat.leaked },
    product: { plansPosted: totalDays, fullyDone: metrics.doneDays, missed: metrics.missedDays, completionRate: +(metrics.doneDays / totalDays).toFixed(2), activePostersByDay: metrics.postedDaysPerDay, dollarsLost: dbDebt, debtsConfirmedPaid: paidRows, nudgesSent: metrics.nudgesSent },
  };
  console.log(JSON.stringify(out, null, 2));
  db.close(); srv.kill();
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(out, null, 2));
  process.exit(mism.length || cheat.leaked.length || counts.unexpected || streakBad || dupDebts || selfPaid ? 1 : 0);
})();
