// Crewmate: zero-dependency server (Node 22+). Run: node server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'data.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER);
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT, code TEXT UNIQUE, created TEXT, closed_through TEXT);
CREATE TABLE IF NOT EXISTS members(group_id INTEGER, user_id INTEGER, joined TEXT, PRIMARY KEY(group_id,user_id));
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, group_id INTEGER, user_id INTEGER, day TEXT, title TEXT, done INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS stakes(group_id INTEGER, user_id INTEGER, day TEXT, amount INTEGER, PRIMARY KEY(group_id,user_id,day));
CREATE TABLE IF NOT EXISTS results(group_id INTEGER, user_id INTEGER, day TEXT, status TEXT, PRIMARY KEY(group_id,user_id,day));
CREATE TABLE IF NOT EXISTS nudges(group_id INTEGER, from_id INTEGER, to_id INTEGER, day TEXT, PRIMARY KEY(group_id,from_id,to_id,day));
CREATE TABLE IF NOT EXISTS doubts(task_id INTEGER, user_id INTEGER, PRIMARY KEY(task_id,user_id));
CREATE TABLE IF NOT EXISTS reminders(user_id INTEGER, group_id INTEGER, day TEXT, PRIMARY KEY(user_id,group_id,day));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, group_id INTEGER, user_id INTEGER, kind TEXT, task_id INTEGER, day TEXT, text TEXT, at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS events_task_once ON events(task_id) WHERE kind='task_done';
CREATE UNIQUE INDEX IF NOT EXISTS events_day_once ON events(group_id,user_id,day) WHERE kind='day_done';
CREATE INDEX IF NOT EXISTS events_by_group ON events(group_id,id);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, group_id INTEGER, text TEXT, at INTEGER, read INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS notif_by_user ON notifications(user_id,read);
CREATE TABLE IF NOT EXISTS reactions(task_id INTEGER, user_id INTEGER, emoji TEXT, PRIMARY KEY(task_id,user_id));
CREATE TABLE IF NOT EXISTS freezes(group_id INTEGER, user_id INTEGER, day TEXT, PRIMARY KEY(group_id,user_id,day));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS pings(task_id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS challenges(id INTEGER PRIMARY KEY, group_id INTEGER, title TEXT, stake INTEGER, at TEXT, days TEXT DEFAULT '', photo INTEGER DEFAULT 0, start TEXT, ended TEXT, created_by INTEGER);
CREATE TABLE IF NOT EXISTS challenge_members(challenge_id INTEGER, user_id INTEGER, since TEXT, PRIMARY KEY(challenge_id,user_id));
CREATE TABLE IF NOT EXISTS debts(id INTEGER PRIMARY KEY, group_id INTEGER, user_id INTEGER, day TEXT, amount INTEGER, paid INTEGER DEFAULT 0, paid_by INTEGER);
`);
// Migrations for databases created before timezones, Plus and the debt key existed.
for (const sql of [
  "ALTER TABLE groups ADD COLUMN tz TEXT DEFAULT 'UTC'",
  "ALTER TABLE groups ADD COLUMN plus INTEGER DEFAULT 0",
  "CREATE UNIQUE INDEX IF NOT EXISTS debts_once ON debts(group_id,user_id,day)",
  "ALTER TABLE users ADD COLUMN rec_hash TEXT",
  "ALTER TABLE users ADD COLUMN tg_chat TEXT",
  "ALTER TABLE users ADD COLUMN tg_token TEXT",
  "ALTER TABLE sessions ADD COLUMN created INTEGER DEFAULT 0",
  "ALTER TABLE groups ADD COLUMN plus_sub TEXT",
  "ALTER TABLE groups ADD COLUMN recap_token TEXT",
  "ALTER TABLE groups ADD COLUMN sample INTEGER DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN proof TEXT",
  "ALTER TABLE groups ADD COLUMN min_stake INTEGER DEFAULT 0",
  "ALTER TABLE groups ADD COLUMN owner INTEGER",
  "ALTER TABLE stakes ADD COLUMN set_at INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN created INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN notify_tg INTEGER DEFAULT 1",
  "ALTER TABLE users ADD COLUMN avatar TEXT",
  "ALTER TABLE users ADD COLUMN avatar_v INTEGER DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS tasks_by_day ON tasks(group_id,user_id,day)",
  "CREATE INDEX IF NOT EXISTS debts_by_group ON debts(group_id,user_id)",
  "CREATE INDEX IF NOT EXISTS results_by_user ON results(user_id,group_id)",
  "ALTER TABLE tasks ADD COLUMN challenge_id INTEGER",
  "ALTER TABLE tasks ADD COLUMN due TEXT",
  "ALTER TABLE tasks ADD COLUMN need_photo INTEGER DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN photo TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS tasks_challenge_once ON tasks(challenge_id,user_id,day) WHERE challenge_id IS NOT NULL",
]) { try { db.exec(sql); } catch { /* already applied */ } }

try { db.exec('UPDATE groups SET owner=(SELECT user_id FROM members WHERE group_id=groups.id ORDER BY rowid LIMIT 1) WHERE owner IS NULL'); } catch {}

const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

// ---- Browser notifications (Web Push), no dependencies.
// The push carries no payload, so nothing needs encrypting: it only wakes the service worker, which then asks
// /api/push/latest what to show. The signing key pair is made on first start and kept in the database.
const b64u = x => Buffer.from(x).toString('base64url');
const VAPID = (() => {
  const row = one("SELECT value FROM settings WHERE key='vapid'");
  let jwk = row && JSON.parse(row.value);
  if (!jwk) { jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }); run("INSERT INTO settings VALUES('vapid',?)", JSON.stringify(jwk)); }
  return { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), pub: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])) };
})();
function vapidJwt(aud) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' }));
  return `${head}.${body}.${b64u(crypto.sign('sha256', Buffer.from(head + '.' + body), { key: VAPID.key, dsaEncoding: 'ieee-p1363' }))}`;
}
// Only real browser push services are accepted, so the server can never be pointed at an arbitrary address.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
const pushUrlOk = s => { try { const u = new URL(s); return (u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname)) || (!!process.env.PUSH_TEST_HOST && u.host === process.env.PUSH_TEST_HOST); } catch { return false; } };
function pushSend(uid) {
  for (const s of q('SELECT endpoint FROM push_subs WHERE user_id=?', uid)) {
    let aud; try { aud = new URL(s.endpoint).origin; } catch { continue; }
    fetch(s.endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: `vapid t=${vapidJwt(aud)}, k=${VAPID.pub}` } })
      .then(r => { if ([403, 404, 410].includes(r.status)) run('DELETE FROM push_subs WHERE endpoint=?', s.endpoint); }) // the browser dropped this subscription
      .catch(e => console.error('push', e.message));
  }
}

const FREEZES_OFF = process.env.FREEZES_OFF === '1'; // used by the simulation, which models plain results only
const GRACE_MS = Number(process.env.STAKE_GRACE_MS || 600000); // a new stake (and its tasks) can be changed for 10 minutes if nothing is ticked yet
const DEFAULT_STAKE = 2;
const FREE_MEMBERS = Number(process.env.FREE_MEMBERS || 3); // free crews hold this many people (you and two friends); Plus removes the cap
const DEFAULT_TZ = 'America/New_York';
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
// Test-only clock: sim/month.js sets SIM_CLOCK_FILE and writes a number of days into it to move "today" forward.
// Unset in normal use, so the real date applies.
const SIM_CLOCK = process.env.SIM_CLOCK_FILE;
const simDays = () => { if (!SIM_CLOCK) return 0; try { return Number(fs.readFileSync(SIM_CLOCK, 'utf8')) || 0; } catch { return 0; } };
const fmts = {};
// Calendar date (YYYY-MM-DD) right now in the given IANA timezone.
const today = tz => {
  const f = fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const p = Object.fromEntries(f.formatToParts(new Date(Date.now() + simDays() * 864e5)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const groupDay = gid => today((one('SELECT tz FROM groups WHERE id=?', gid) || {}).tz || 'UTC');
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function hash(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

const weekStartOf = d => { const dow = (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; return addDays(d, -dow); }; // Monday
const freezeAllowance = plus => (plus ? 3 : 1); // streak freezes per week: 1 free, 3 on Plus
function freezesUsedThisWeek(gid, uid, upToDay) { return one('SELECT COUNT(*) c FROM freezes WHERE group_id=? AND user_id=? AND day>=? AND day<=?', gid, uid, weekStartOf(upToDay), upToDay).c; }
function notifyUser(uid, gid, text) {
  run('INSERT INTO notifications(user_id,group_id,text,at) VALUES(?,?,?,?)', uid, gid, text, Date.now());
  const r = one('SELECT notify_tg FROM users WHERE id=?', uid);
  if (r && r.notify_tg) tgSend(uid, text);
  pushSend(uid);
}
function notifyOthers(gid, fromUid, text) { for (const m of q('SELECT user_id FROM members WHERE group_id=? AND user_id<>?', gid, fromUid)) notifyUser(m.user_id, gid, text); }
function pushEvent(gid, uid, kind, taskId, day, text) { return run('INSERT OR IGNORE INTO events(group_id,user_id,kind,task_id,day,text,at) VALUES(?,?,?,?,?,?,?)', gid, uid, kind, taskId, day, text, Date.now()); }

// Lazy day close: runs whenever a group is read. Closes every finished day exactly once.
function closeDays(gid) {
  const g = one('SELECT * FROM groups WHERE id=?', gid);
  const t = today(g.tz || 'UTC');
  let d = addDays(g.closed_through, 1);
  while (d < t) {
    const skipped = [];
    db.exec('BEGIN'); // one day closes fully or not at all
    try {
    ensureChallengeTasks(gid, d); // someone who never opened the app that day still gets the challenge task, and so the miss
    const ms = q('SELECT user_id, joined FROM members WHERE group_id=?', gid), others = ms.filter(x => x.joined <= d).length - 1;
    for (const m of ms) {
      if (m.joined > d) continue;
      const tasks = q('SELECT id,done FROM tasks WHERE group_id=? AND user_id=? AND day=?', gid, m.user_id, d);
      const s = one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', gid, m.user_id, d);
      const staked = !!(s && s.amount > 0);
      let status = staked ? 'missed' : 'none'; // money on a day with no plan is a miss
      // Friends can doubt a ticked task. With money on the day, a miss needs MORE than half of the others and at least two people,
      // so one grumpy friend can never make you pay.
      const disputed = staked && tasks.some(x => { if (!x.done) return false; const n = one('SELECT COUNT(*) c FROM doubts WHERE task_id=?', x.id).c; return n >= 2 && n * 2 > others; });
      if (tasks.length) status = tasks.every(x => x.done) && !disputed ? 'done' : 'missed';
      const wasMissed = status === 'missed';
      // Streak freeze: a bad day does not break a running streak while freezes are left this week. It never cancels a stake.
      if (!FREEZES_OFF && (status === 'missed' || status === 'none')) {
        const prev = one('SELECT status FROM results WHERE group_id=? AND user_id=? AND day=?', gid, m.user_id, addDays(d, -1));
        if (prev && (prev.status === 'done' || prev.status.startsWith('frozen')) && freezesUsedThisWeek(gid, m.user_id, d) < freezeAllowance(g.plus)) {
          run('INSERT OR IGNORE INTO freezes VALUES(?,?,?)', gid, m.user_id, d);
          status = 'frozen_' + status;
        }
      }
      run('INSERT OR IGNORE INTO results VALUES(?,?,?,?)', gid, m.user_id, d, status);
      if (wasMissed && staked && run('INSERT OR IGNORE INTO debts(group_id,user_id,day,amount) VALUES(?,?,?,?)', gid, m.user_id, d, s.amount).changes && !g.sample && d === addDays(t, -1)) skipped.push([m.user_id, s.amount]);
    }
    run('UPDATE groups SET closed_through=? WHERE id=?', d, gid);
    db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    // Tell the crew who skipped yesterday (older days are closed quietly, so a long absence does not flood anyone).
    for (const [uid, amount] of skipped) {
      const who = (one('SELECT name FROM users WHERE id=?', uid) || {}).name || 'Someone';
      notifyUser(uid, gid, `You skipped yesterday in ${g.name}. You owe the crew $${amount}.`);
      notifyOthers(gid, uid, `${who} skipped yesterday and owes the crew $${amount}.`);
    }
    d = addDays(d, 1);
  }
}

function streakOf(gid, uid, t) {
  const rows = q("SELECT day,status FROM results WHERE group_id=? AND user_id=? ORDER BY day DESC", gid, uid);
  let n = 0;
  for (const r of rows) { if (r.status === 'done') n++; else if (r.status.startsWith('frozen')) continue; else break; }
  // Today counts as soon as everything on today's plan is ticked.
  const td = q('SELECT done FROM tasks WHERE group_id=? AND user_id=? AND day=?', gid, uid, t);
  if (td.length && td.every(x => x.done)) n++;
  return n;
}
function silentDays(gid, uid) {
  const rows = q("SELECT status FROM results WHERE group_id=? AND user_id=? ORDER BY day DESC", gid, uid);
  let n = 0;
  for (const r of rows) { if (r.status !== 'none' && r.status !== 'frozen_none') break; n++; }
  return n;
}

const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('error', () => r({})); req.on('data', c => { b += c; if (b.length > 2.5e5) { r({}); req.destroy(); } }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

function authUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = one('SELECT user_id,created FROM sessions WHERE token=?', m[1]);
  if (s && s.created && Date.now() - s.created > 30 * 864e5) { run('DELETE FROM sessions WHERE token=?', m[1]); return null; }
  return s ? one('SELECT id,name FROM users WHERE id=?', s.user_id) : null;
}
function startSession(req, res, uid) {
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)', token, uid, Date.now());
  return { 'set-cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` };
}
// May the person still lower/remove today's stake or remove tasks? Only briefly, and only before ticking anything.
function inGrace(gid, uid, day) {
  const row = one('SELECT set_at FROM stakes WHERE group_id=? AND user_id=? AND day=?', gid, uid, day);
  if (!row) return true;
  if (!row.set_at || Date.now() - row.set_at > GRACE_MS) return false;
  return !one('SELECT 1 FROM tasks WHERE group_id=? AND user_id=? AND day=? AND done=1', gid, uid, day);
}
const isMember = (gid, uid) => !!one('SELECT 1 FROM members WHERE group_id=? AND user_id=?', gid, uid);

// Real client address. Behind a host's proxy (Render, Railway, Fly) the socket address is the proxy itself, so every
// visitor would share one rate limit. When the socket is a private address, use the address the proxy reports.
const isPrivateIp = ip => /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^(::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip);
const ipOf = req => {
  const sock = req.socket.remoteAddress || '';
  if (!isPrivateIp(sock)) return sock;
  const h = req.headers, xff = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return String(h['cf-connecting-ip'] || h['fly-client-ip'] || h['x-real-ip'] || xff || sock).slice(0, 64);
};

// ---- Crew challenges: one shared commitment ("6 a.m. run, Tue and Thu, $5 each"). Being in means money is on it.
// A challenge turns into an ordinary task plus a stake for each person who is in, on every day it applies,
// so scoring, debts, streaks and doubts all work exactly as they do for a personal plan.
const WINDOW_MIN = Number(process.env.CHECKIN_WINDOW_MIN || 15); // a timed task can be ticked this many minutes before/after its time
const FREE_CHALLENGES = 1; // free crews run one challenge at a time; Plus removes the cap
const validAt = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const toMin = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const fmtMin = m => { m = Math.max(0, Math.min(1439, m)); const h = Math.floor(m / 60); return `${(h + 11) % 12 + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const dowOf = d => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0
const tzOf = gid => (one('SELECT tz FROM groups WHERE id=?', gid) || {}).tz || 'UTC';
const localMinutes = tz => { const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()); const g = k => Number(p.find(x => x.type === k).value); return (g('hour') % 24) * 60 + g('minute'); };
const windowOpen = (tz, due) => { const now = localMinutes(tz), d = toMin(due); return now >= d - WINDOW_MIN && now <= d + WINDOW_MIN; };
// days: '' = every day, 'YYYY-MM-DD' = once, or weekday digits such as '13' (Tue, Thu).
const challengeOn = (c, day) => day >= c.start && (!c.ended || day < c.ended) && (isDate(c.days) ? c.days === day : !c.days || c.days.includes(String(dowOf(day))));
// The first day a new commitment can fairly count: today, unless today's check-in window is already over.
const firstFairDay = (tz, at) => { const t = today(tz); return at && localMinutes(tz) > toMin(at) + WINDOW_MIN ? addDays(t, 1) : t; };
const jpegOf = (dataUrl, max) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length >= 100 && buf.length <= max && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? m[1] : null;
};
function ensureChallengeTasks(gid, day) {
  for (const c of q('SELECT * FROM challenges WHERE group_id=? AND start<=?', gid, day)) {
    if (!challengeOn(c, day)) continue;
    for (const m of q('SELECT cm.user_id FROM challenge_members cm JOIN members m ON m.group_id=? AND m.user_id=cm.user_id WHERE cm.challenge_id=? AND cm.since<=? AND m.joined<=?', gid, c.id, day, day)) {
      if (!run('INSERT OR IGNORE INTO tasks(group_id,user_id,day,title,challenge_id,due,need_photo) VALUES(?,?,?,?,?,?,?)', gid, m.user_id, day, c.title, c.id, c.at, c.photo).changes) continue;
      const have = one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', gid, m.user_id, day);
      // set_at 0 = no grace window: a challenge stake cannot be lowered
      if (!have) run('INSERT INTO stakes(group_id,user_id,day,amount,set_at) VALUES(?,?,?,?,0)', gid, m.user_id, day, c.stake);
      else if (have.amount < c.stake) run('UPDATE stakes SET amount=?, set_at=0 WHERE group_id=? AND user_id=? AND day=?', c.stake, gid, m.user_id, day);
    }
  }
}
// The least a person may have on a day because of the challenges they are in.
const challengeFloor = (gid, uid, day) => one('SELECT COALESCE(MAX(c.stake),0) m FROM tasks t JOIN challenges c ON c.id=t.challenge_id WHERE t.group_id=? AND t.user_id=? AND t.day=?', gid, uid, day).m;
const challengeList = (gid, t) => q('SELECT id,title,stake,at,days,photo,start,created_by FROM challenges WHERE group_id=? AND (ended IS NULL OR ended>?) ORDER BY id', gid, t)
  .filter(c => !isDate(c.days) || c.days >= t)
  .map(c => ({ ...c, today: challengeOn(c, t), in: q('SELECT cm.user_id FROM challenge_members cm JOIN members m ON m.user_id=cm.user_id AND m.group_id=? WHERE cm.challenge_id=?', gid, c.id).map(x => x.user_id) }));

const fails = new Map(); // key -> [timestamps] inside the last 10 minutes
const tooMany = (k, max = 8) => { const now = Date.now(), a = (fails.get(k) || []).filter(t => now - t < 600000); fails.set(k, a); return a.length >= max; };
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:\w+/g, '(\\d+)') + '$'), fn });

route('POST', '/api/signup', async (req, res, u, b) => {
  const name = String(b.name || '').trim(), pw = String(b.password || '');
  if (name.length < 2 || name.length > 24 || name.includes('~')) return json(res, 400, { error: 'Name must be 2-24 characters, no ~' });
  const sk = 'su|' + ipOf(req);
  if (tooMany(sk, Number(process.env.SIGNUP_LIMIT || 20))) return json(res, 429, { error: 'Too many sign-ups from here. Try again later.' });
  fails.get(sk).push(Date.now());
  if (pw.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
  if (one('SELECT 1 FROM users WHERE name=?', name)) return json(res, 400, { error: 'That name is taken' });
  const salt = crypto.randomBytes(8).toString('hex');
  const recovery = crypto.randomBytes(6).toString('hex'); // shown once; lets the user reset a forgotten password
  const r = run('INSERT INTO users(name,salt,hash,rec_hash,created) VALUES(?,?,?,?,?)', name, salt, hash(pw, salt), hash(recovery, salt), Date.now());
  json(res, 200, { ok: true, recovery }, startSession(req, res, Number(r.lastInsertRowid)));
});
route('POST', '/api/login', async (req, res, u, b) => {
  const fk = ipOf(req) + '|' + String(b.name || '').toLowerCase(), nk = 'n|' + String(b.name || '').trim().toLowerCase();
  // The per-name cap is a backstop in case the reported client address is forged.
  if (tooMany(fk) || tooMany(nk, 40)) return json(res, 429, { error: 'Too many tries. Wait 10 minutes.' });
  const row = one('SELECT * FROM users WHERE name=?', String(b.name || '').trim());
  if (!row || hash(String(b.password || ''), row.salt) !== row.hash) { fails.get(fk).push(Date.now()); fails.get(nk).push(Date.now()); return json(res, 400, { error: 'Wrong name or password' }); }
  json(res, 200, { ok: true }, startSession(req, res, row.id));
});
route('POST', '/api/recover', async (req, res, u, b) => {
  const fk = 'rc|' + ipOf(req) + '|' + String(b.name || '').toLowerCase();
  if (tooMany(fk)) return json(res, 429, { error: 'Too many tries. Wait 10 minutes.' });
  const row = one('SELECT * FROM users WHERE name=?', String(b.name || '').trim()), pw = String(b.password || '');
  const code = String(b.code || '').trim().toLowerCase();
  const good = row && row.rec_hash && code.length === 12 && crypto.timingSafeEqual(Buffer.from(hash(code, row.salt)), Buffer.from(row.rec_hash));
  if (!good) { fails.get(fk).push(Date.now()); return json(res, 400, { error: 'Name or recovery code is wrong' }); }
  if (pw.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
  run('UPDATE users SET hash=? WHERE id=?', hash(pw, row.salt), row.id);
  run('DELETE FROM sessions WHERE user_id=?', row.id);
  json(res, 200, { ok: true }, startSession(req, res, row.id));
});
route('POST', '/api/password', async (req, res, u, b) => {
  const row = one('SELECT * FROM users WHERE id=?', u.id), pw = String(b.password || '');
  if (hash(String(b.old || ''), row.salt) !== row.hash) return json(res, 400, { error: 'Current password is wrong' });
  if (pw.length < 6) return json(res, 400, { error: 'New password must be at least 6 characters' });
  run('UPDATE users SET hash=? WHERE id=?', hash(pw, row.salt), u.id);
  const keep = /sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', u.id, keep ? keep[1] : '');
  json(res, 200, { ok: true });
});
route('POST', '/api/recovery/new', async (req, res, u, b) => {
  const row = one('SELECT * FROM users WHERE id=?', u.id);
  if (hash(String(b.password || ''), row.salt) !== row.hash) return json(res, 400, { error: 'Password is wrong' });
  const recovery = crypto.randomBytes(6).toString('hex');
  run('UPDATE users SET rec_hash=? WHERE id=?', hash(recovery, row.salt), u.id);
  json(res, 200, { recovery });
});
route('POST', '/api/logout', async (req, res) => {
  const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) run('DELETE FROM sessions WHERE token=?', m[1]);
  json(res, 200, { ok: true });
});
route('GET', '/api/me', async (req, res, u) => {
  if (!u) return json(res, 200, { user: null });
  const ur = one('SELECT tg_chat,notify_tg FROM users WHERE id=?', u.id) || {};
  json(res, 200, { user: u, unread: one('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', u.id).c, telegram: { enabled: !!TG_TOKEN, linked: !!ur.tg_chat, notify: ur.notify_tg !== 0 }, groups: q('SELECT g.id,g.name,g.code,g.sample FROM groups g JOIN members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.id', u.id) });
});

route('POST', '/api/groups', async (req, res, u, b) => {
  const name = String(b.name || '').trim().slice(0, 30);
  if (!name) return json(res, 400, { error: 'Give the group a name' });
  const code = crypto.randomBytes(4).toString('hex');
  const tz = validTz(String(b.tz || '')) ? String(b.tz) : DEFAULT_TZ; // fixed at creation so nobody can shift the deadline later
  const t = today(tz);
  const min = Number.isInteger(b.min_stake) && b.min_stake >= 0 && b.min_stake <= 5 ? b.min_stake : 0;
  const r = run('INSERT INTO groups(name,code,created,closed_through,tz,min_stake,owner) VALUES(?,?,?,?,?,?,?)', name, code, t, addDays(t, -1), tz, min, u.id);
  run('INSERT INTO members VALUES(?,?,?)', Number(r.lastInsertRowid), u.id, t);
  json(res, 200, { id: Number(r.lastInsertRowid), code });
});
route('POST', '/api/join', async (req, res, u, b) => {
  const g = one('SELECT * FROM groups WHERE code=?', String(b.code || ''));
  if (!g) return json(res, 404, { error: 'Invite link not found' });
  if (!isMember(g.id, u.id) && !g.plus && one('SELECT COUNT(*) c FROM members WHERE group_id=?', g.id).c >= FREE_MEMBERS)
    return json(res, 402, { error: `This crew is full. Free crews hold ${FREE_MEMBERS} people. Ask the friend who invited you to upgrade the crew to Plus.` });
  const had = isMember(g.id, u.id);
  run('INSERT OR IGNORE INTO members VALUES(?,?,?)', g.id, u.id, today(g.tz || 'UTC'));
  if (!had) { pushEvent(g.id, u.id, 'joined', null, null, `${u.name} joined the crew`); notifyOthers(g.id, u.id, `${u.name} joined ${g.name}`); }
  json(res, 200, { id: g.id });
});

function guard(res, u, gid) { if (!isMember(gid, u.id)) { json(res, 403, { error: 'Not in this group' }); return false; } return true; }

route('GET', '/api/groups/:id/wall', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  closeDays(gid);
  const g = one('SELECT id,name,code,tz,plus,sample,min_stake,owner FROM groups WHERE id=?', gid), t = today(g.tz || 'UTC');
  ensureChallengeTasks(gid, t);
  const link = process.env.STRIPE_LINK;
  g.isOwner = g.owner === u.id; delete g.owner;
  g.checkout = link ? link + (link.includes('?') ? '&' : '?') + 'client_reference_id=' + gid : null;
  g.price = process.env.PLUS_PRICE || null; g.freeMembers = FREE_MEMBERS;
  const members = q('SELECT u.id,u.name,u.avatar_v FROM members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY m.rowid', gid).map(m => {
    const tasks = q('SELECT id,title,done,proof,due,need_photo,challenge_id,(photo IS NOT NULL) hasPhoto,(SELECT COUNT(*) FROM doubts d WHERE d.task_id=tasks.id) doubts,(SELECT COUNT(*) FROM doubts d WHERE d.task_id=tasks.id AND d.user_id=?) doubtedByMe FROM tasks WHERE group_id=? AND user_id=? AND day=? ORDER BY id', u.id, gid, m.id, t);
    for (const tk of tasks) tk.reacts = q('SELECT emoji, COUNT(*) n, SUM(user_id=?) mine FROM reactions WHERE task_id=? GROUP BY emoji', u.id, tk.id);
    const stake = (one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', gid, m.id, t) || {}).amount || 0;
    const week = [];
    for (let i = 6; i >= 1; i--) { const d = addDays(t, -i); const r = one('SELECT status FROM results WHERE group_id=? AND user_id=? AND day=?', gid, m.id, d); week.push({ day: d, status: r ? r.status : 'none' }); }
    const done = tasks.filter(x => x.done).length;
    week.push({ day: t, status: tasks.length && done === tasks.length ? 'done' : 'today' });
    const nudges = one('SELECT COUNT(*) c FROM nudges WHERE group_id=? AND to_id=? AND day=?', gid, m.id, t).c, nudgedByMe = !!one('SELECT 1 FROM nudges WHERE group_id=? AND from_id=? AND to_id=? AND day=?', gid, u.id, m.id, t);
    const gs = gameStats(m.id);
    return { id: m.id, name: m.name, avatar: m.avatar_v ? `/api/avatar/${m.id}?v=${m.avatar_v}` : null, xp: gs.xp, level: gs.level, levelName: gs.levelName, xpFloor: gs.floor, xpNext: gs.next, badges: gs.badges, me: m.id === u.id, canLower: m.id === u.id && stake > 0 && inGrace(gid, u.id, t), nudges, nudgedByMe, tasks, stake, done, total: tasks.length, streak: streakOf(gid, m.id, t), silent: silentDays(gid, m.id), week };
  });
  // Weekly crew quest: together, tick 10 tasks per member over the last 7 days.
  g.quest = { goal: members.length * 10, done: one('SELECT COUNT(*) c FROM tasks WHERE group_id=? AND done=1 AND day>=?', gid, addDays(t, -6)).c };
  g.challenges = challengeList(gid, t); g.freeChallenges = FREE_CHALLENGES;
  g.stakeFloor = challengeFloor(gid, u.id, t); g.window = WINDOW_MIN;
  g.badgeCatalog = BADGES.map(b => ({ id: b.id, emoji: b.emoji, name: b.name }));
  g.reactionSet = REACTIONS;
  g.freezesLeft = FREEZES_OFF ? 0 : Math.max(0, freezeAllowance(g.plus) - freezesUsedThisWeek(gid, u.id, t));
  g.freezeAllowance = freezeAllowance(g.plus);
  const feed = q('SELECT id,kind,text,at,user_id FROM events WHERE group_id=? ORDER BY id DESC LIMIT 8', gid);
  const unread = one('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', u.id).c;
  json(res, 200, { group: g, today: t, members, feed, unread });
});
route('POST', '/api/groups/:id/nudge', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  const to = +b.user_id, t = groupDay(gid);
  if (to === u.id || !isMember(gid, to)) return json(res, 400, { error: 'Pick a friend in this group' });
  const tk = q('SELECT done FROM tasks WHERE group_id=? AND user_id=? AND day=?', gid, to, t);
  if (tk.length && tk.every(x => x.done)) return json(res, 400, { error: 'They already finished today' });
  run('INSERT OR IGNORE INTO nudges VALUES(?,?,?,?)', gid, u.id, to, t);
  notifyUser(to, gid, `${u.name} nudged you in ${one('SELECT name FROM groups WHERE id=?', gid).name}. Finish today's plan!`);
  json(res, 200, { ok: true });
});
route('POST', '/api/groups/:id/rules', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  const g = one('SELECT owner,plus FROM groups WHERE id=?', gid);
  if (g.owner !== u.id) return json(res, 403, { error: 'Only the person who made the group can change its rules' });
  if (!Number.isInteger(b.min_stake) || b.min_stake < 0 || b.min_stake > 50) return json(res, 400, { error: 'Minimum stake must be $0 to $50' });
  if (b.min_stake > 5 && !g.plus) return json(res, 402, { error: 'A minimum above $5 is part of Crewmate Plus.' });
  run('UPDATE groups SET min_stake=? WHERE id=?', b.min_stake, gid);
  json(res, 200, { ok: true });
});
route('POST', '/api/groups/:id/leave', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  closeDays(gid); ensureChallengeTasks(gid, groupDay(gid)); // today's challenge counts even if the wall was never opened
  if (one('SELECT 1 FROM debts WHERE group_id=? AND user_id=? AND paid=0', gid, u.id)) return json(res, 400, { error: 'Settle your open stakes before leaving.' });
  const t = groupDay(gid), st = one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', gid, u.id, t);
  const todays = q('SELECT done FROM tasks WHERE group_id=? AND user_id=? AND day=?', gid, u.id, t);
  if (st && st.amount > 0 && !(todays.length && todays.every(x => x.done))) return json(res, 400, { error: 'You have money on today. Finish your plan before leaving.' });
  run('DELETE FROM challenge_members WHERE user_id=? AND challenge_id IN (SELECT id FROM challenges WHERE group_id=?)', u.id, gid);
  run('DELETE FROM members WHERE group_id=? AND user_id=?', gid, u.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/groups/:id/code', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  const code = crypto.randomBytes(4).toString('hex'); // old invite link stops working
  run('UPDATE groups SET code=? WHERE id=?', code, gid);
  json(res, 200, { code });
});
route('POST', '/api/groups/:id/share', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  let tok = (one('SELECT recap_token FROM groups WHERE id=?', gid) || {}).recap_token;
  if (!tok) { tok = crypto.randomBytes(8).toString('hex'); run('UPDATE groups SET recap_token=? WHERE id=?', tok, gid); }
  json(res, 200, { token: tok });
});
// A clearly labelled sample group so a new visitor sees a full wall. The three friends are not real people and cannot log in.
route('POST', '/api/demo', async (req, res, u, b) => {
  if (one('SELECT COUNT(*) c FROM members m JOIN groups g ON g.id=m.group_id WHERE m.user_id=? AND g.sample=1', u.id).c >= 2) return json(res, 400, { error: 'You already have a sample group' });
  const tz = validTz(String(b.tz || '')) ? String(b.tz) : DEFAULT_TZ, t = today(tz), code = crypto.randomBytes(4).toString('hex');
  const gid = Number(run('INSERT INTO groups(name,code,created,closed_through,tz,sample) VALUES(?,?,?,?,?,1)', 'Sample crew', code, addDays(t, -21), addDays(t, -1), tz).lastInsertRowid);
  const bot = n => Number(run('INSERT INTO users(name,salt,hash) VALUES(?,?,?)', n + '~' + code.slice(0, 6), 'x', 'no-login').lastInsertRowid);
  const dana = bot('Dana'), arman = bot('Marcus'), timur = bot('Jess');
  for (const id of [dana, arman, timur, u.id]) run('INSERT INTO members VALUES(?,?,?)', gid, id, id === u.id ? t : addDays(t, -21));
  const res_ = (id, i, st) => run('INSERT INTO results VALUES(?,?,?,?)', gid, id, addDays(t, -i), st);
  const debt = (id, i, amt, paid, by) => run('INSERT INTO debts(group_id,user_id,day,amount,paid,paid_by) VALUES(?,?,?,?,?,?)', gid, id, addDays(t, -i), amt, paid, by);
  for (let i = 21; i >= 1; i--) {
    res_(dana, i, 'done');
    res_(arman, i, [14, 9, 2].includes(i) ? 'missed' : i === 1 ? 'done' : (i % 5 === 0 ? 'none' : 'done'));
    res_(timur, i, i >= 5 ? 'done' : i === 4 ? 'missed' : 'none');
  }
  debt(arman, 14, 5, 1, dana); debt(arman, 9, 2, 1, timur); debt(arman, 2, 5, 0, null); debt(timur, 4, 5, 0, null);
  const task = (id, title, done) => run('INSERT INTO tasks(group_id,user_id,day,title,done) VALUES(?,?,?,?,?)', gid, id, t, title, done);
  // a week of ticked tasks so the crew quest and XP look alive
  const pastTask = (id, i, title, done) => run('INSERT INTO tasks(group_id,user_id,day,title,done) VALUES(?,?,?,?,?)', gid, id, addDays(t, -i), title, done);
  for (let i = 1; i <= 6; i++) { for (const n of ['Gym', 'Read', 'Plan tomorrow']) pastTask(dana, i, n, 1); for (const n of ['Lesson', 'Practice']) pastTask(arman, i, n, [2, 9, 14].includes(i) ? 0 : 1); if (i >= 5) pastTask(timur, i, 'Study', 1); }
  task(dana, 'Gym: legs', 1); task(dana, 'Read 20 pages', 1); task(dana, 'Plan tomorrow', 1);
  task(arman, 'Finish lesson 4', 1); task(arman, 'Practice 30 min', 0);
  run('INSERT INTO stakes(group_id,user_id,day,amount) VALUES(?,?,?,?)', gid, arman, t, 5);
  const ago = m => Date.now() - m * 60000;
  for (const [id, text, mins] of [[dana, 'Dana finished "Plan tomorrow"', 6], [dana, 'Dana finished everything today 🎉', 6], [arman, 'Marcus finished "Finish lesson 4"', 41], [dana, 'Dana finished "Gym: legs"', 95]]) run('INSERT INTO events(group_id,user_id,kind,day,text,at) VALUES(?,?,?,?,?,?)', gid, id, 'sample', t, text, ago(mins));
  json(res, 200, { id: gid });
});
route('POST', '/api/groups/:id/tasks', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  const title = String(b.title || '').trim().slice(0, 80);
  if (!title) return json(res, 400, { error: 'Write a task' });
  const t = groupDay(gid);
  const n = one('SELECT COUNT(*) c FROM tasks WHERE group_id=? AND user_id=? AND day=?', gid, u.id, t).c;
  if (n >= 10) return json(res, 400, { error: 'Max 10 tasks a day' });
  // Optional proof, chosen per task: a check-in time (the tick only works near that time) and/or a photo.
  const due = validAt(String(b.due || '')) ? String(b.due) : null;
  if (due && localMinutes(tzOf(gid)) > toMin(due) + WINDOW_MIN) return json(res, 400, { error: 'That check-in time has already passed today.' });
  run('INSERT INTO tasks(group_id,user_id,day,title,due,need_photo) VALUES(?,?,?,?,?,?)', gid, u.id, t, title, due, b.photo ? 1 : 0);
  // Pre-selected bet: the first task of the day puts the default (or the crew minimum) on it. "None" is one tap away for 10 minutes.
  const g = one('SELECT min_stake FROM groups WHERE id=?', gid), min = g.min_stake || 0;
  const have = one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', gid, u.id, t);
  if (!have) run('INSERT INTO stakes(group_id,user_id,day,amount,set_at) VALUES(?,?,?,?,?)', gid, u.id, t, Math.max(DEFAULT_STAKE, min), Date.now());
  else if (have.amount < min) run('UPDATE stakes SET amount=? WHERE group_id=? AND user_id=? AND day=?', min, gid, u.id, t); // crew rule was raised after the bet was set
  json(res, 200, { ok: true });
});
route('POST', '/api/tasks/:id/toggle', async (req, res, u, b, [id]) => {
  const t = one('SELECT * FROM tasks WHERE id=?', +id);
  if (!t || t.user_id !== u.id || t.day !== groupDay(t.group_id)) return json(res, 403, { error: 'Only your own tasks for today' });
  const nowDone = t.done ? 0 : 1, proof = nowDone ? String(b.proof || '').trim().slice(0, 120) || null : null;
  if (t.due && !windowOpen(tzOf(t.group_id), t.due)) {
    const d = toMin(t.due);
    return json(res, 400, { error: nowDone ? `Check-in for this is open from ${fmtMin(d - WINDOW_MIN)} to ${fmtMin(d + WINDOW_MIN)}.` : 'The check-in window is closed, so this stays ticked.' });
  }
  let photo = null;
  if (nowDone && t.need_photo) { photo = jpegOf(b.photo, 120000); if (!photo) return json(res, 400, { error: 'This task needs a photo as proof.' }); }
  run('UPDATE tasks SET done=?, proof=?, photo=? WHERE id=?', nowDone, proof, photo, t.id);
  if (!nowDone) { run('DELETE FROM doubts WHERE task_id=?', t.id); run('DELETE FROM reactions WHERE task_id=?', t.id); }
  if (nowDone) {
    // Tell the friends once per task (un-ticking and re-ticking does not spam them).
    const text = `${u.name} finished "${t.title}"`;
    if (pushEvent(t.group_id, u.id, 'task_done', t.id, t.day, text).changes) notifyOthers(t.group_id, u.id, text);
    const todays = q('SELECT done FROM tasks WHERE group_id=? AND user_id=? AND day=?', t.group_id, u.id, t.day);
    if (todays.every(x => x.done) && pushEvent(t.group_id, u.id, 'day_done', null, t.day, `${u.name} finished everything today 🎉`).changes) notifyOthers(t.group_id, u.id, `${u.name} finished everything today 🎉`);
  }
  json(res, 200, { ok: true });
});
const REACTIONS = ['👏', '🔥', '💪', '😮'];
route('POST', '/api/tasks/:id/react', async (req, res, u, b, [id]) => {
  const t = one('SELECT * FROM tasks WHERE id=?', +id);
  if (!t || !isMember(t.group_id, u.id)) return json(res, 403, { error: 'Not in this group' });
  if (t.user_id === u.id) return json(res, 400, { error: 'Cheer for your friends, not yourself' });
  if (!t.done || t.day !== groupDay(t.group_id)) return json(res, 400, { error: 'You can cheer a task ticked today' });
  if (!REACTIONS.includes(b.emoji)) return json(res, 400, { error: 'Pick one of the reactions' });
  const have = one('SELECT emoji FROM reactions WHERE task_id=? AND user_id=?', t.id, u.id);
  if (have && have.emoji === b.emoji) run('DELETE FROM reactions WHERE task_id=? AND user_id=?', t.id, u.id);
  else { run('INSERT OR REPLACE INTO reactions VALUES(?,?,?)', t.id, u.id, b.emoji); notifyUser(t.user_id, t.group_id, `${u.name} reacted ${b.emoji} to "${t.title}"`); }
  json(res, 200, { ok: true });
});
route('GET', '/api/notifications', async (req, res, u) => {
  json(res, 200, { unread: one('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', u.id).c,
    items: q('SELECT n.id,n.text,n.at,n.read,g.name AS group_name FROM notifications n LEFT JOIN groups g ON g.id=n.group_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 40', u.id) });
});
route('POST', '/api/notifications/read', async (req, res, u) => { run('UPDATE notifications SET read=1 WHERE user_id=?', u.id); json(res, 200, { ok: true }); });
route('POST', '/api/notify', async (req, res, u, b) => { run('UPDATE users SET notify_tg=? WHERE id=?', b.telegram ? 1 : 0, u.id); json(res, 200, { ok: true }); });
route('POST', '/api/tasks/:id/rename', async (req, res, u, b, [id]) => {
  const t = one('SELECT * FROM tasks WHERE id=?', +id);
  if (!t || t.user_id !== u.id || t.day !== groupDay(t.group_id)) return json(res, 403, { error: 'Only your own tasks for today' });
  const title = String(b.title || '').trim().slice(0, 80);
  if (!title) return json(res, 400, { error: 'Write a task' });
  if (t.challenge_id) return json(res, 400, { error: 'This task comes from a crew challenge, so it cannot be renamed.' });
  // Renaming a task with money on it could swap a hard task for an easy one, so it follows the same lock as removing.
  const st = one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', t.group_id, u.id, t.day);
  if (st && st.amount > 0 && !inGrace(t.group_id, u.id, t.day)) return json(res, 400, { error: 'You have money on today, so tasks cannot be renamed. Add a new one instead.' });
  run('UPDATE tasks SET title=? WHERE id=?', title, t.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/tasks/:id/doubt', async (req, res, u, b, [id]) => {
  const t = one('SELECT * FROM tasks WHERE id=?', +id);
  if (!t || !isMember(t.group_id, u.id)) return json(res, 403, { error: 'Not in this group' });
  if (t.user_id === u.id) return json(res, 400, { error: 'You cannot doubt your own task' });
  if (t.day !== groupDay(t.group_id) || !t.done) return json(res, 400, { error: 'You can only doubt a task ticked today' });
  if (one('SELECT 1 FROM doubts WHERE task_id=? AND user_id=?', t.id, u.id)) run('DELETE FROM doubts WHERE task_id=? AND user_id=?', t.id, u.id);
  else run('INSERT INTO doubts VALUES(?,?)', t.id, u.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/tasks/:id/delete', async (req, res, u, b, [id]) => {
  const t = one('SELECT * FROM tasks WHERE id=?', +id);
  if (!t || t.user_id !== u.id || t.day !== groupDay(t.group_id)) return json(res, 403, { error: 'Only your own tasks for today' });
  if (t.challenge_id) return json(res, 400, { error: 'This task comes from a crew challenge, so it cannot be removed.' });
  // Once money is on the day the plan is locked: no removing what you did not do.
  const st = one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', t.group_id, u.id, t.day);
  if (st && st.amount > 0 && !inGrace(t.group_id, u.id, t.day)) return json(res, 400, { error: 'You have money on today, so the plan is locked. Tasks can be added, not removed.' });
  run('DELETE FROM tasks WHERE id=?', t.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/groups/:id/stake', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  if (!Number.isInteger(b.amount) || b.amount < 0 || b.amount > 50) return json(res, 400, { error: 'Pick a stake from $1 to $50' });
  const amount = b.amount, t = groupDay(gid);
  const row = one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', gid, u.id, t), cur = row ? row.amount : 0;
  const g = one('SELECT plus,min_stake FROM groups WHERE id=?', gid);
  if (amount < (g.min_stake || 0)) return json(res, 400, { error: `This crew requires at least $${g.min_stake} a day.` });
  const floor = challengeFloor(gid, u.id, t);
  if (amount < floor) return json(res, 400, { error: `You are in a crew challenge today, so at least $${floor} is on it.` });
  // A stake is a promise: it can go up any time, and down only in the first minutes before anything is ticked.
  if (amount < cur && !inGrace(gid, u.id, t)) return json(res, 400, { error: 'A stake is a promise. After the first minutes, or once you tick something, it can only go up.' });
  if (amount === cur) return json(res, 200, { ok: true });
  if (amount > 5 && !g.plus) return json(res, 402, { error: 'Stakes above $5 are part of Crewmate Plus.' });
  if (!one('SELECT 1 FROM tasks WHERE group_id=? AND user_id=? AND day=?', gid, u.id, t)) return json(res, 400, { error: 'Post your plan first, then put money on it.' });
  if (row) run('UPDATE stakes SET amount=? WHERE group_id=? AND user_id=? AND day=?', amount, gid, u.id, t);
  else run('INSERT INTO stakes(group_id,user_id,day,amount,set_at) VALUES(?,?,?,?,?)', gid, u.id, t, amount, Date.now());
  json(res, 200, { ok: true });
});
route('GET', '/api/groups/:id/ledger', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  closeDays(gid);
  const debts = q('SELECT d.id,d.day,d.amount,d.paid,d.user_id,us.name,pb.name AS paid_by FROM debts d JOIN users us ON us.id=d.user_id LEFT JOIN users pb ON pb.id=d.paid_by WHERE d.group_id=? ORDER BY d.paid, d.day DESC', gid);
  json(res, 200, { me: u.id, debts, openTotal: debts.filter(d => !d.paid).reduce((s, d) => s + d.amount, 0) });
});
route('POST', '/api/debts/:id/paid', async (req, res, u, b, [id]) => {
  const d = one('SELECT * FROM debts WHERE id=?', +id);
  const mem = d && one('SELECT joined FROM members WHERE group_id=? AND user_id=?', d.group_id, u.id);
  if (!mem) return json(res, 403, { error: 'Not in this group' });
  if (d.user_id === u.id) return json(res, 400, { error: 'A friend has to confirm your payment' });
  // Stops a second account made after the miss from clearing the debt.
  if (mem.joined > d.day) return json(res, 400, { error: 'Only friends who were in the group that day can confirm.' });
  run('UPDATE debts SET paid=1, paid_by=? WHERE id=?', u.id, d.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/groups/:id/challenges', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  const g = one('SELECT name,tz,plus FROM groups WHERE id=?', gid), tz = g.tz || 'UTC', t = today(tz);
  const title = String(b.title || '').trim().slice(0, 60);
  if (!title) return json(res, 400, { error: 'Say what the challenge is, e.g. "6 a.m. run"' });
  if (!Number.isInteger(b.stake) || b.stake < 1 || b.stake > 50) return json(res, 400, { error: 'Everyone in a crew challenge puts money on it: $1 to $50.' });
  if (b.stake > 5 && !g.plus) return json(res, 402, { error: 'Stakes above $5 are part of Crewmate Plus.' });
  const at = b.at ? String(b.at) : null;
  if (at && !validAt(at)) return json(res, 400, { error: 'Check-in time must look like 06:00' });
  let days = String(b.days || '');
  if (isDate(days)) { if (Number.isNaN(Date.parse(days + 'T00:00:00Z')) || days > addDays(t, 90)) return json(res, 400, { error: 'Pick a day in the next 90 days' }); }
  else { if (!/^[0-6]{0,7}$/.test(days)) return json(res, 400, { error: 'Pick the days of the week' }); days = [...new Set(days)].sort().join(''); if (days.length === 7) days = ''; }
  if (!g.plus && challengeList(gid, t).length >= FREE_CHALLENGES) return json(res, 402, { error: 'Free crews run one challenge at a time. End the current one, or upgrade the crew to Plus.' });
  const start = firstFairDay(tz, at);
  if (isDate(days) && days < start) return json(res, 400, { error: 'That day, or its check-in time, has already passed.' });
  const id = Number(run('INSERT INTO challenges(group_id,title,stake,at,days,photo,start,created_by) VALUES(?,?,?,?,?,?,?,?)', gid, title, b.stake, at, days, b.photo ? 1 : 0, start, u.id).lastInsertRowid);
  run('INSERT INTO challenge_members VALUES(?,?,?)', id, u.id, start);
  ensureChallengeTasks(gid, t);
  pushEvent(gid, u.id, 'challenge', null, null, `${u.name} set a crew challenge: "${title}" · $${b.stake} each`);
  notifyOthers(gid, u.id, `${u.name} set a crew challenge in ${g.name}: "${title}", $${b.stake} each. Are you in?`);
  json(res, 200, { id });
});
route('POST', '/api/challenges/:id/join', async (req, res, u, b, [id]) => {
  const c = one('SELECT * FROM challenges WHERE id=?', +id);
  if (!c || !isMember(c.group_id, u.id)) return json(res, 403, { error: 'Not in this group' });
  const tz = tzOf(c.group_id), t = today(tz), since = firstFairDay(tz, c.at);
  if ((c.ended && c.ended <= t) || (isDate(c.days) && c.days < since)) return json(res, 400, { error: 'This challenge is over.' });
  if (run('INSERT OR IGNORE INTO challenge_members VALUES(?,?,?)', c.id, u.id, since).changes) {
    ensureChallengeTasks(c.group_id, t);
    pushEvent(c.group_id, u.id, 'challenge_in', null, null, `${u.name} is in for "${c.title}" · $${c.stake} on it`);
    notifyOthers(c.group_id, u.id, `${u.name} is in for "${c.title}"`);
  }
  json(res, 200, { ok: true, since });
});
// Leaving stops future days. A day that already has the challenge task on it still counts.
route('POST', '/api/challenges/:id/leave', async (req, res, u, b, [id]) => {
  const c = one('SELECT * FROM challenges WHERE id=?', +id);
  if (!c || !isMember(c.group_id, u.id)) return json(res, 403, { error: 'Not in this group' });
  // Settle everything up to today first, so leaving cannot erase a day that was already owed.
  closeDays(c.group_id); ensureChallengeTasks(c.group_id, today(tzOf(c.group_id)));
  run('DELETE FROM challenge_members WHERE challenge_id=? AND user_id=?', c.id, u.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/challenges/:id/end', async (req, res, u, b, [id]) => {
  const c = one('SELECT * FROM challenges WHERE id=?', +id);
  if (!c || !isMember(c.group_id, u.id)) return json(res, 403, { error: 'Not in this group' });
  if (c.created_by !== u.id && one('SELECT owner FROM groups WHERE id=?', c.group_id).owner !== u.id) return json(res, 403, { error: 'Only the person who set the challenge can end it' });
  run('UPDATE challenges SET ended=? WHERE id=? AND ended IS NULL', addDays(today(tzOf(c.group_id)), 1), c.id); // today still counts
  json(res, 200, { ok: true });
});
route('GET', '/api/tasks/:id/photo', async (req, res, u, b, [id]) => {
  const t = one('SELECT group_id,photo FROM tasks WHERE id=?', +id);
  if (!t || !t.photo || !isMember(t.group_id, u.id)) return json(res, 404, { error: 'No photo' });
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' });
  res.end(Buffer.from(t.photo, 'base64'));
});
route('GET', '/api/push/key', async (req, res) => json(res, 200, { key: VAPID.pub }));
route('POST', '/api/push/subscribe', async (req, res, u, b) => {
  const ep = String(b.endpoint || '');
  if (ep.length > 1000 || !pushUrlOk(ep)) return json(res, 400, { error: 'That browser cannot receive notifications from here.' });
  run('INSERT OR REPLACE INTO push_subs(endpoint,user_id,created) VALUES(?,?,?)', ep, u.id, Date.now());
  // keep the 10 newest devices per person
  run('DELETE FROM push_subs WHERE user_id=? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id=? ORDER BY created DESC LIMIT 10)', u.id, u.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/push/unsubscribe', async (req, res, u, b) => { run('DELETE FROM push_subs WHERE endpoint=? AND user_id=?', String(b.endpoint || ''), u.id); json(res, 200, { ok: true }); });
// What the service worker shows when a push wakes it: the newest unread notification of the signed-in person.
route('GET', '/api/push/latest', async (req, res, u) => {
  const n = one('SELECT n.text,g.name AS grp FROM notifications n LEFT JOIN groups g ON g.id=n.group_id WHERE n.user_id=? AND n.read=0 AND n.at>? ORDER BY n.id DESC LIMIT 1', u.id, Date.now() - 600000);
  json(res, 200, n ? { text: n.text, group: n.grp || null } : {});
});
// ---- Gamification: everything is computed from the data, so XP and badges can never drift out of sync.
const LEVELS = [0, 50, 150, 300, 500, 800, 1200, 1800, 2600, 3600];
const LEVEL_NAMES = ['Rookie', 'Regular', 'Grinder', 'Machine', 'Veteran', 'Beast', 'Legend', 'Mythic', 'Immortal', 'Mastermind'];
const BADGES = [
  { id: 'first_win', emoji: '🏁', name: 'First win', desc: 'Finish every task on a day' },
  { id: 'streak3', emoji: '🔥', name: 'Three in a row', desc: 'A 3-day streak' },
  { id: 'streak7', emoji: '⚡', name: 'Week warrior', desc: 'A 7-day streak' },
  { id: 'streak21', emoji: '💎', name: 'Habit built', desc: 'A 21-day streak' },
  { id: 'streak30', emoji: '👑', name: 'Unstoppable', desc: 'A 30-day streak' },
  { id: 'comeback', emoji: '🔄', name: 'Comeback', desc: 'Finish a day after 3 or more days off' },
  { id: 'high_roller', emoji: '🎲', name: 'High roller', desc: 'Finish a day with $5 or more on it' },
  { id: 'skin', emoji: '🛡️', name: 'Skin in the game', desc: 'Finish 5 days with money on them' },
  { id: 'paid_up', emoji: '💸', name: 'Paid up', desc: 'Settle a missed stake' },
  { id: 'hype', emoji: '📣', name: 'Hype man', desc: 'Nudge or cheer friends 5 times' },
];
// XP: 10 per ticked task, 25 per fully finished day, 15 more when money was on that day, 3 per nudge sent (max 30).
function gameStats(uid) {
  // At most 5 ticked tasks a day count toward XP, so padding a plan with junk tasks earns nothing extra.
  const tasksDone = one('SELECT COALESCE(SUM(MIN(c,5)),0) c FROM (SELECT COUNT(*) c FROM tasks WHERE user_id=? AND done=1 GROUP BY group_id,day)', uid).c;
  const rows = q('SELECT group_id,day,status FROM results WHERE user_id=? ORDER BY group_id,day', uid);
  const stakedDone = q("SELECT s.amount FROM results r JOIN stakes s ON s.group_id=r.group_id AND s.user_id=r.user_id AND s.day=r.day WHERE r.user_id=? AND r.status='done' AND s.amount>0", uid);
  const nudges = one('SELECT COUNT(*) c FROM nudges WHERE from_id=?', uid).c + one('SELECT COUNT(*) c FROM reactions WHERE user_id=?', uid).c;
  const paid = one('SELECT COUNT(*) c FROM debts WHERE user_id=? AND paid=1', uid).c;
  let best = 0, run = 0, gap = 0, comeback = false, doneDays = 0, lastGroup = null;
  for (const r of rows) {
    if (r.group_id !== lastGroup) { run = 0; gap = 0; lastGroup = r.group_id; }
    if (r.status === 'done') { doneDays++; if (gap >= 3) comeback = true; run++; gap = 0; best = Math.max(best, run); }
    else if (r.status.startsWith('frozen')) { /* a frozen day keeps the streak alive */ }
    else { run = 0; gap++; }
  }
  const xp = tasksDone * 10 + doneDays * 25 + stakedDone.length * 15 + Math.min(nudges, 10) * 3;
  let level = 0; while (level < LEVELS.length && xp >= LEVELS[level]) level++;
  const got = new Set();
  if (doneDays) got.add('first_win');
  for (const [n, id] of [[3, 'streak3'], [7, 'streak7'], [21, 'streak21'], [30, 'streak30']]) if (best >= n) got.add(id);
  if (comeback) got.add('comeback');
  if (stakedDone.some(x => x.amount >= 5)) got.add('high_roller');
  if (stakedDone.length >= 5) got.add('skin');
  if (paid) got.add('paid_up');
  if (nudges >= 5) got.add('hype');
  return { xp, level, levelName: LEVEL_NAMES[Math.min(level, LEVEL_NAMES.length) - 1], floor: LEVELS[level - 1], next: LEVELS[level] ?? null, bestStreak: best, badges: BADGES.filter(b => got.has(b.id)).map(b => b.id) };
}
route('GET', '/api/profile', async (req, res, u) => {
  const g = gameStats(u.id), a = one('SELECT avatar_v FROM users WHERE id=?', u.id);
  json(res, 200, { ...g, avatar: a.avatar_v ? `/api/avatar/${u.id}?v=${a.avatar_v}` : null, badges: BADGES.map(b => ({ ...b, earned: g.badges.includes(b.id) })) });
});
// Profile pictures: the browser shrinks the photo to a small JPEG; the server only accepts a small real JPEG.
route('POST', '/api/avatar', async (req, res, u, b) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
  if (!m) return json(res, 400, { error: 'Send a JPEG photo' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 60000 || buf.length < 100) return json(res, 400, { error: 'Photo is too big. Pick a smaller one.' });
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return json(res, 400, { error: 'That is not a JPEG' });
  run('UPDATE users SET avatar=?, avatar_v=avatar_v+1 WHERE id=?', m[1], u.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/avatar/remove', async (req, res, u) => { run('UPDATE users SET avatar=NULL, avatar_v=0 WHERE id=?', u.id); json(res, 200, { ok: true }); });
route('GET', '/api/avatar/:id', async (req, res, u, b, [id]) => {
  id = +id;
  const ok = id === u.id || one('SELECT 1 FROM members a JOIN members b2 ON a.group_id=b2.group_id WHERE a.user_id=? AND b2.user_id=?', u.id, id);
  const row = ok && one('SELECT avatar FROM users WHERE id=?', id);
  if (!row || !row.avatar) return json(res, 404, { error: 'No photo' });
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' });
  res.end(Buffer.from(row.avatar, 'base64'));
});

function recapData(gid) {
  const t = groupDay(gid), since = addDays(t, -7);
  const members = q('SELECT u.id,u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.group_id=?', gid).map(m => {
    const rs = q('SELECT status FROM results WHERE group_id=? AND user_id=? AND day>=?', gid, m.id, since);
    const lost = (one('SELECT COALESCE(SUM(amount),0) s FROM debts WHERE group_id=? AND user_id=? AND day>=?', gid, m.id, since)).s;
    const gs = gameStats(m.id);
    return { name: m.name, level: gs.level, levelName: gs.levelName, xp: gs.xp, done: rs.filter(r => r.status === 'done').length, missed: rs.filter(r => r.status === 'missed' || r.status === 'frozen_missed').length, days: rs.length, lost, streak: streakOf(gid, m.id, t) };
  }).sort((a, b) => b.done - a.done);
  const totalDone = members.reduce((s, m) => s + m.done, 0), totalDays = members.reduce((s, m) => s + m.days, 0);
  return { group: one('SELECT name FROM groups WHERE id=?', gid).name, members, totalDone, totalDays, pot: members.reduce((s, m) => s + m.lost, 0) };
}
route('GET', '/api/groups/:id/recap', async (req, res, u, b, [gid]) => {
  gid = +gid; if (!guard(res, u, gid)) return;
  closeDays(gid);
  json(res, 200, recapData(gid));
});

// ---- Telegram: optional reminders. Set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_NAME to switch on.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN, TG_API = process.env.TELEGRAM_API || 'https://api.telegram.org';
async function tgCall(method, body) {
  const r = await fetch(`${TG_API}/bot${TG_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
function tgSend(uid, text) {
  if (!TG_TOKEN) return;
  const row = one('SELECT tg_chat FROM users WHERE id=?', uid);
  if (row && row.tg_chat) tgCall('sendMessage', { chat_id: row.tg_chat, text }).catch(e => console.error('telegram', e.message));
}
route('POST', '/api/telegram/link', async (req, res, u) => {
  if (!TG_TOKEN) return json(res, 400, { error: 'Telegram is not set up on this server' });
  const tok = crypto.randomBytes(8).toString('hex');
  run('UPDATE users SET tg_token=? WHERE id=?', tok, u.id);
  json(res, 200, { link: `https://t.me/${process.env.TELEGRAM_BOT_NAME || 'your_bot'}?start=${tok}` });
});
route('POST', '/api/telegram/unlink', async (req, res, u) => { run('UPDATE users SET tg_chat=NULL, tg_token=NULL WHERE id=?', u.id); json(res, 200, { ok: true }); });
const localHour = tz => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date())) % 24;
function sendReminders() {
  const hourFrom = Number(process.env.REMIND_HOUR ?? 19);
  for (const m of q("SELECT m.user_id,m.group_id,g.name gname,g.tz FROM members m JOIN groups g ON g.id=m.group_id JOIN users u ON u.id=m.user_id WHERE (u.tg_chat IS NOT NULL OR EXISTS(SELECT 1 FROM push_subs p WHERE p.user_id=u.id)) AND g.sample=0")) {
    const tz = m.tz || 'UTC';
    if (localHour(tz) < hourFrom) continue;
    const t = today(tz);
    if (one('SELECT 1 FROM reminders WHERE user_id=? AND group_id=? AND day=?', m.user_id, m.group_id, t)) continue;
    closeDays(m.group_id); ensureChallengeTasks(m.group_id, t);
    const tasks = q('SELECT done FROM tasks WHERE group_id=? AND user_id=? AND day=?', m.group_id, m.user_id, t), left = tasks.filter(x => !x.done).length;
    const stake = (one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', m.group_id, m.user_id, t) || {}).amount || 0;
    let text = null;
    if (tasks.length && left) text = `${m.gname}: ${left} task${left > 1 ? 's' : ''} left today${stake ? `, $${stake} on the line` : ''}.`;
    else if (!tasks.length) { const st = streakOf(m.group_id, m.user_id, t); if (st) text = `${m.gname}: you have no plan today. Don't lose your ${st}-day streak.`; }
    if (text) { run('INSERT OR IGNORE INTO reminders VALUES(?,?,?)', m.user_id, m.group_id, t); remind(m.user_id, m.group_id, text); } // marked only once actually sent
  }
  sendCheckinPings();
}
// A reminder lands in the inbox and goes out on every channel the person has switched on.
function remind(uid, gid, text) { run('INSERT INTO notifications(user_id,group_id,text,at) VALUES(?,?,?,?)', uid, gid, text, Date.now()); tgSend(uid, text); pushSend(uid); }
// "It's time": one message shortly before a timed task's check-in opens (or as it opens, if the server was late).
const PING_MIN = Number(process.env.CHECKIN_PING_MIN || 30);
function sendCheckinPings() {
  // Put today's timed challenge tasks on the plan even if nobody has opened the app yet today.
  for (const g of q('SELECT DISTINCT g.id,g.tz FROM groups g JOIN challenges c ON c.group_id=g.id WHERE c.at IS NOT NULL AND g.sample=0')) { closeDays(g.id); ensureChallengeTasks(g.id, today(g.tz || 'UTC')); }
  const from = addDays(new Date().toISOString().slice(0, 10), -1);
  for (const x of q('SELECT t.id,t.user_id,t.group_id,t.title,t.due,t.day,g.tz FROM tasks t JOIN groups g ON g.id=t.group_id JOIN members m ON m.group_id=t.group_id AND m.user_id=t.user_id WHERE t.due IS NOT NULL AND t.done=0 AND g.sample=0 AND t.day>=? AND NOT EXISTS(SELECT 1 FROM pings p WHERE p.task_id=t.id)', from)) {
    const tz = x.tz || 'UTC';
    if (x.day !== today(tz)) continue;
    const left = toMin(x.due) - localMinutes(tz);
    if (left > PING_MIN || left < -WINDOW_MIN) continue;
    run('INSERT OR IGNORE INTO pings VALUES(?)', x.id);
    const stake = (one('SELECT amount FROM stakes WHERE group_id=? AND user_id=? AND day=?', x.group_id, x.user_id, x.day) || {}).amount || 0;
    const money = stake ? ` $${stake} on it.` : '';
    remind(x.user_id, x.group_id, left > WINDOW_MIN ? `"${x.title}" in ${left} minutes.${money}` : `Check-in for "${x.title}" is open until ${fmtMin(toMin(x.due) + WINDOW_MIN)}.${money}`);
  }
}
async function tgPoll() {
  let offset = 0;
  for (;;) {
    try {
      const j = await tgCall('getUpdates', { offset, timeout: Number(process.env.TG_POLL_SECONDS ?? 25) });
      for (const up of j.result || []) {
        offset = up.update_id + 1;
        const msg = up.message; if (!msg || !msg.text) continue;
        const m = /^\/start\s+([a-f0-9]+)/.exec(msg.text);
        if (m) {
          const r = run('UPDATE users SET tg_chat=?, tg_token=NULL WHERE tg_token=?', String(msg.chat.id), m[1]);
          await tgCall('sendMessage', { chat_id: msg.chat.id, text: r.changes ? 'Linked. I will remind you when a plan is unfinished.' : 'That link has expired. Open Crewmate and press Connect Telegram again.' });
        } else if (/^\/stop/.test(msg.text)) { run('UPDATE users SET tg_chat=NULL WHERE tg_chat=?', String(msg.chat.id)); await tgCall('sendMessage', { chat_id: msg.chat.id, text: 'Reminders off.' }); }
      }
    } catch (e) { console.error('telegram poll', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}
if (TG_TOKEN) tgPoll();
setInterval(() => { try { sendReminders(); } catch (e) { console.error(e); } }, Number(process.env.REMIND_EVERY_MS || 60000));

// Private numbers for the pitch. Off unless ADMIN_TOKEN is set; the page asks for the token.
function adminStats() {
  const real = "u.name NOT LIKE '%~%'", day0 = new Date().toISOString().slice(0, 10);
  const c = (sql, ...a) => one(sql, ...a).c;
  const since = n => addDays(day0, -n);
  return {
    users: c(`SELECT COUNT(*) c FROM users u WHERE ${real}`), usersLast24h: c(`SELECT COUNT(*) c FROM users u WHERE ${real} AND created>?`, Date.now() - 864e5),
    groups: c('SELECT COUNT(*) c FROM groups WHERE sample=0'), groupsWith3Plus: c('SELECT COUNT(*) c FROM (SELECT g.id FROM groups g JOIN members m ON m.group_id=g.id WHERE g.sample=0 GROUP BY g.id HAVING COUNT(*)>=3)'),
    plusGroups: c('SELECT COUNT(*) c FROM groups WHERE plus=1 AND sample=0'),
    activeToday: c(`SELECT COUNT(DISTINCT t.user_id) c FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.day>=? AND ${real}`, since(1)),
    active7d: c(`SELECT COUNT(DISTINCT t.user_id) c FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.day>=? AND ${real}`, since(7)),
    returning3Days: c(`SELECT COUNT(*) c FROM (SELECT t.user_id FROM tasks t JOIN users u ON u.id=t.user_id WHERE ${real} GROUP BY t.user_id HAVING COUNT(DISTINCT t.day)>=3)`),
    tasksPosted: c(`SELECT COUNT(*) c FROM tasks t JOIN users u ON u.id=t.user_id WHERE ${real}`), tasksTicked: c(`SELECT COUNT(*) c FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.done=1 AND ${real}`),
    fullDays: c(`SELECT COUNT(*) c FROM results r JOIN users u ON u.id=r.user_id WHERE r.status='done' AND ${real}`),
    dollarsStaked: c(`SELECT COALESCE(SUM(s.amount),0) c FROM stakes s JOIN users u ON u.id=s.user_id WHERE ${real}`),
    dollarsLost: c(`SELECT COALESCE(SUM(d.amount),0) c FROM debts d JOIN users u ON u.id=d.user_id WHERE ${real}`), dollarsSettled: c(`SELECT COALESCE(SUM(d.amount),0) c FROM debts d JOIN users u ON u.id=d.user_id WHERE d.paid=1 AND ${real}`),
    reactions: c('SELECT COUNT(*) c FROM reactions'), nudges: c('SELECT COUNT(*) c FROM nudges'), telegramLinked: c('SELECT COUNT(*) c FROM users WHERE tg_chat IS NOT NULL'),
    perDay: q(`SELECT t.day, COUNT(DISTINCT t.user_id) people, COUNT(*) tasks, SUM(t.done) ticked FROM tasks t JOIN users u ON u.id=t.user_id WHERE ${real} AND t.day>=? GROUP BY t.day ORDER BY t.day`, since(13)),
  };
}

// Public, read-only weekly recap for sharing (no login, no ids).
const sharedRecap = token => { const g = one('SELECT id FROM groups WHERE recap_token=?', token); if (!g) return null; closeDays(g.id); return recapData(g.id); };

// Stripe tells us a group paid. The Payment Link carries the group id as client_reference_id.
// Nothing is unlocked without a signed event, so Plus cannot be switched on from the browser.
const readRaw = req => new Promise(r => { const c = []; let n = 0; req.on('error', () => r(null)); req.on('data', d => { n += d.length; if (n > 1e6) { r(null); req.destroy(); } else c.push(d); }); req.on('end', () => r(Buffer.concat(c))); });
async function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET, raw = await readRaw(req);
  if (!secret || !raw) return json(res, 400, { error: 'Webhook not configured' });
  const parts = String(req.headers['stripe-signature'] || '').split(',').map(p => p.trim().split('='));
  const ts = (parts.find(p => p[0] === 't') || [])[1];
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(ts + '.').update(raw).digest('hex'));
  const ok = ts && Math.abs(Date.now() / 1000 - Number(ts)) < 300 &&
    parts.some(p => p[0] === 'v1' && p[1] && p[1].length === want.length && crypto.timingSafeEqual(Buffer.from(p[1]), want));
  if (!ok) return json(res, 400, { error: 'Bad signature' });
  let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'Bad payload' }); }
  const o = (ev && ev.data && ev.data.object) || {};
  if (ev.type === 'checkout.session.completed' && o.payment_status === 'paid') {
    const gid = parseInt(o.client_reference_id, 10);
    if (gid) run('UPDATE groups SET plus=1, plus_sub=? WHERE id=?', o.subscription || null, gid);
  } else if (ev.type === 'customer.subscription.deleted' && o.id) run('UPDATE groups SET plus=0 WHERE plus_sub=?', o.id);
  json(res, 200, { received: true });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const escHtml = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Messengers read these tags to draw a preview card when someone pastes an invite link.
function pageWithPreview(req, title, desc, path_) {
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const tags = `<meta property="og:type" content="website"><meta property="og:site_name" content="Crewmate"><meta property="og:title" content="${escHtml(title)}"><meta property="og:description" content="${escHtml(desc)}"><meta property="og:url" content="${escHtml(origin + path_)}"><meta property="og:image" content="${origin}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escHtml(title)}"><meta name="twitter:description" content="${escHtml(desc)}"><meta name="twitter:image" content="${origin}/og.png"><meta name="description" content="${escHtml(desc)}">`;
  return fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace(/<title>.*?<\/title>/, `<title>${escHtml(title)}</title>`).replace('</head>', tags + '</head>');
}
http.createServer(async (req, res) => {
 try {
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('Bad request'); }
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  if (url.pathname === '/api/admin/stats') {
    const tok = process.env.ADMIN_TOKEN, given = String(req.headers['x-admin-token'] || '');
    const okTok = tok && given.length === tok.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok));
    return okTok ? json(res, 200, adminStats()) : json(res, 404, { error: 'Not found' });
  }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const sh = /^\/api\/shared\/([a-f0-9]+)$/.exec(url.pathname);
  if (sh && req.method === 'GET') { const d = sharedRecap(sh[1]); return d ? json(res, 200, d) : json(res, 404, { error: 'Recap not found' }); }
  if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') return await stripeWebhook(req, res);
  const iv = /^\/api\/invite\/([a-f0-9]+)$/.exec(url.pathname);
  if (iv && req.method === 'GET') { const g = one('SELECT id,name,min_stake,tz FROM groups WHERE code=?', iv[1]); const ch = g && challengeList(g.id, today(g.tz || 'UTC'))[0]; return g ? json(res, 200, { name: g.name, min_stake: g.min_stake || 0, challenge: ch ? { title: ch.title, stake: ch.stake, at: ch.at } : null, members: one('SELECT COUNT(*) c FROM members m JOIN groups g ON g.id=m.group_id WHERE g.code=?', iv[1]).c }) : json(res, 404, { error: 'Invite link not found' }); }
  if (url.pathname.startsWith('/api/')) {
    let u; try { u = authUser(req); } catch (e) { console.error(e); return json(res, 500, { error: 'Server error' }); }
    const open = ['/api/signup', '/api/login', '/api/logout', '/api/me', '/api/recover'];
    if (!u && !open.includes(url.pathname)) return json(res, 401, { error: 'Sign in first' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) { try { return await r.fn(req, res, u, body, m.slice(1)); } catch (e) { console.error(e); return json(res, 500, { error: 'Server error' }); } }
    }
    return json(res, 404, { error: 'Not found' });
  }
  const jm = /^\/join\/([a-f0-9]+)$/.exec(url.pathname), rm = /^\/r\/([a-f0-9]+)$/.exec(url.pathname);
  if (jm || rm) {
    let title = 'Crewmate: show up for your friends', desc = 'Post your plan, tick it off, and your friends see whether you showed up.';
    if (jm) { const g = one('SELECT name,min_stake,(SELECT COUNT(*) FROM members m WHERE m.group_id=groups.id) n FROM groups WHERE code=?', jm[1]); if (g) { title = `Join ${g.name} on Crewmate`; desc = `${g.n} ${g.n === 1 ? 'friend is' : 'friends are'} already keeping each other on track.${g.min_stake ? ` Crew rule: at least $${g.min_stake} a day.` : ''} Post your plan, tick it off, and see who shows up.`; } }
    else { const g = one('SELECT name FROM groups WHERE recap_token=?', rm[1]); if (g) { title = `${g.name}: the week on Crewmate`; desc = 'Who showed up, who skipped, and who owes the group.'; } }
    res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(pageWithPreview(req, title, desc, url.pathname));
  }
  const root = path.join(__dirname, 'public'), file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); return fs.createReadStream(file).pipe(res); }
  res.writeHead(200, { 'content-type': MIME['.html'] }); fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res); // SPA fallback
 } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); }
}).listen(PORT, () => console.log('Crewmate on http://localhost:' + PORT));
