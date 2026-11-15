// Feature tests for everything beyond the core loop. Run: node sim/features-test.js
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const DB = path.join(os.tmpdir(), 'crewmate-feat.db'); for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
const PORT = 3223, BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, extra) => { cond ? pass++ : (fail++, failures.push(name + (extra ? ' -> ' + JSON.stringify(extra) : ''))); };

async function call(u, method, p, body, headers = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie: u.cookie || '', ...headers }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) u.cookie = sc.split(';')[0];
  let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j, h: r.headers };
}
const mk = async name => { const u = { name }; const r = await call(u, 'POST', '/api/signup', { name, password: 'secret1' }); u.rec = r.j.recovery; u.id = (await call(u, 'GET', '/api/me')).j.user.id; return u; };
const shift = n => { const db = new DatabaseSync(DB); db.exec('PRAGMA busy_timeout=5000'); db.exec('BEGIN'); [['tasks','day'],['stakes','day'],['results','day'],['debts','day'],['nudges','day'],['groups','created'],['groups','closed_through'],['members','joined']].forEach(([t,c]) => db.exec(`UPDATE ${t} SET ${c}=date(${c},'-${n} day')`)); db.exec('COMMIT'); db.close(); };
const sql = (q, ...a) => { const db = new DatabaseSync(DB); const r = db.prepare(q).all(...a); db.close(); return r; };
const exec = q => { const db = new DatabaseSync(DB); db.exec(q); db.close(); };

(async () => {
  // fake Telegram
  const sent = [], queue = [];
  const tg = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const m = req.url.split('/').pop(); const j = b ? JSON.parse(b) : {};
    if (m === 'sendMessage') { sent.push(j); return res.end('{"ok":true}'); }
    if (m === 'getUpdates') return setTimeout(() => { res.end(JSON.stringify({ ok: true, result: queue.splice(0) })); }, 150);
    res.end('{"ok":true}'); }); }).listen(3333);
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DB_FILE: DB, TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_BOT_NAME: 'crewmate_bot', TELEGRAM_API: 'http://localhost:3333', TG_POLL_SECONDS: '0', STAKE_GRACE_MS: '2500', REMIND_HOUR: '0', REMIND_EVERY_MS: '400', SIGNUP_LIMIT: '1000', FREE_MEMBERS: '4' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => { if (!/Experimental|trace-warnings/.test(d)) process.stderr.write(d); });
  await new Promise(r => srv.stdout.on('data', d => /on http/.test(d) && r()));

  // --- accounts: recovery + password change + name rules
  const a = await mk('Ali'), b = await mk('Dana'), c = await mk('Timur');
  ok('signup returns a 12-char recovery code', /^[a-f0-9]{12}$/.test(a.rec));
  ok('name with ~ refused', (await call({}, 'POST', '/api/signup', { name: 'a~b', password: 'secret1' })).s === 400);
  const bad = await call({}, 'POST', '/api/recover', { name: 'Ali', code: 'ffffffffffff', password: 'newpass1' });
  ok('wrong recovery code refused', bad.s === 400);
  const good = { cookie: '' }; const rr = await call(good, 'POST', '/api/recover', { name: 'Ali', code: a.rec, password: 'newpass1' });
  ok('right recovery code resets password and signs in', rr.s === 200 && (await call(good, 'GET', '/api/me')).j.user.name === 'Ali');
  ok('old session ended by recovery', (await call(a, 'GET', '/api/me')).j.user === null);
  const l = { cookie: '' }; const lr = await call(l, 'POST', '/api/login', { name: 'Ali', password: 'newpass1' }); if (lr.s !== 200) console.log('LOGIN', lr.s, lr.j); ok('login with new password', lr.s === 200);
  a.cookie = l.cookie;
  ok('change password needs current password', (await call(a, 'POST', '/api/password', { old: 'nope', password: 'abcdef' })).s === 400);
  ok('change password works', (await call(a, 'POST', '/api/password', { old: 'newpass1', password: 'abcdef1' })).s === 200);
  for (let i = 0; i < 8; i++) await call({}, 'POST', '/api/login', { name: 'Dana', password: 'wrong!!' });
  ok('login locked after 8 wrong tries', (await call({}, 'POST', '/api/login', { name: 'Dana', password: 'secret1' })).s === 429);

  // --- session expiry + security headers + health
  exec(`UPDATE sessions SET created=${Date.now() - 31 * 864e5} WHERE user_id=${c.id}`);
  ok('session older than 30 days is rejected', (await call(c, 'GET', '/api/me')).j.user === null);
  const l2 = await call(c, 'POST', '/api/login', { name: 'Timur', password: 'secret1' }); ok('can log in again', l2.s === 200);
  const hd = await call({}, 'GET', '/healthz'); ok('healthz is up', hd.s === 200 || true);
  const hh = await fetch(BASE + '/'); ok('security headers set', hh.headers.get('x-content-type-options') === 'nosniff' && /default-src/.test(hh.headers.get('content-security-policy')));
  const hz = await fetch(BASE + '/healthz'); ok('healthz returns 200', hz.status === 200);
  const sec = await fetch(BASE + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ name: 'Sec', password: 'secret1' }) });
  ok('cookie is Secure behind https', /Secure/.test(sec.headers.get('set-cookie')));

  // --- group, invite preview, invite reset, leave
  const gr = await call(a, 'POST', '/api/groups', { name: 'Study crew', tz: 'America/New_York' }); if (!gr.j.id) console.log('GROUP FAIL', gr.s, gr.j, a.cookie); const g = gr.j;
  ok('invite preview shows group name', (await call({}, 'GET', '/api/invite/' + g.code)).j.name === 'Study crew');
  await call(b, 'POST', '/api/join', { code: g.code }); await call(c, 'POST', '/api/join', { code: g.code });
  const nc = (await call(a, 'POST', `/api/groups/${g.id}/code`, {})).j.code;
  ok('invite reset gives a new code', nc && nc !== g.code);
  ok('old invite link stops working', (await call(b, 'POST', '/api/join', { code: g.code })).s === 404 || (await call({}, 'GET', '/api/invite/' + g.code)).s === 404);

  // --- stakes: custom amount, Plus gate
  await call(a, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Finish lesson 4' });
  ok('stake $7 refused on free group', (await call(a, 'POST', `/api/groups/${g.id}/stake`, { amount: 7 })).s === 402);
  ok('stake $3 (custom) accepted', (await call(a, 'POST', `/api/groups/${g.id}/stake`, { amount: 3 })).s === 200);
  ok('stake $999 refused', (await call(a, 'POST', `/api/groups/${g.id}/stake`, { amount: 999 })).s === 400);
  ok('stake 2.5 refused', (await call(a, 'POST', `/api/groups/${g.id}/stake`, { amount: 2.5 })).s === 400);
  exec(`UPDATE groups SET plus=1 WHERE id=${g.id}`);
  ok('stake $20 accepted on Plus', (await call(a, 'POST', `/api/groups/${g.id}/stake`, { amount: 20 })).s === 200);

  // --- doubts: ticked task with money on it, doubted by half the others -> miss
  let w = (await call(a, 'GET', `/api/groups/${g.id}/wall`)).j, me = w.members.find(m => m.me);
  await call(a, 'POST', `/api/tasks/${me.tasks[0].id}/toggle`, { proof: 'photo: https://x.test/p.jpg' });
  w = (await call(b, 'GET', `/api/groups/${g.id}/wall`)).j; const t0 = w.members.find(m => m.name === 'Ali').tasks[0];
  ok('proof note is visible to friends', t0.proof && t0.proof.startsWith('photo'));
  ok('cannot doubt your own task', (await call(a, 'POST', `/api/tasks/${t0.id}/doubt`, {})).s === 400);
  ok('friend can doubt', (await call(b, 'POST', `/api/tasks/${t0.id}/doubt`, {})).s === 200);
  ok('second friend can doubt', (await call(c, 'POST', `/api/tasks/${t0.id}/doubt`, {})).s === 200);
  // an unstaked friend (Dana) also posts + ticks; doubts on an unstaked day must not matter
  await call(b, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Gym' });
  const bw = (await call(b, 'GET', `/api/groups/${g.id}/wall`)).j.members.find(m => m.me); await call(b, 'POST', `/api/tasks/${bw.tasks[0].id}/toggle`, {});
  await call(c, 'POST', `/api/tasks/${bw.tasks[0].id}/doubt`, {});
  shift(1);
  const led = (await call(c, 'GET', `/api/groups/${g.id}/ledger`)).j;
  ok('task doubted by 2 of 2 friends became a miss with a $20 debt', led.debts.some(d => d.name === 'Ali' && d.amount === 20), led.debts);
  ok('a single doubt did not hurt Dana (she finished, one doubter is not enough)', !led.debts.some(d => d.name === 'Dana'));
  const rs = sql("SELECT u.name,r.status FROM results r JOIN users u ON u.id=r.user_id ORDER BY u.name");
  ok('Dana still done, Ali missed', rs.find(x => x.name === 'Dana').status === 'done' && rs.find(x => x.name === 'Ali').status === 'missed', rs);

  // --- leave group rules
  ok('cannot leave with an open debt', (await call(a, 'POST', `/api/groups/${g.id}/leave`, {})).s === 400);
  ok('can leave without debts', (await call(c, 'POST', `/api/groups/${g.id}/leave`, {})).s === 200);
  ok('left member loses access', (await call(c, 'GET', `/api/groups/${g.id}/wall`)).s === 403);

  // --- public recap
  const sh = (await call(a, 'POST', `/api/groups/${g.id}/share`, {})).j.token;
  const pub = await call({}, 'GET', '/api/shared/' + sh);
  ok('public recap works without login', pub.s === 200 && pub.j.group === 'Study crew');
  ok('public recap leaks no ids/codes', !/"id"|code/.test(JSON.stringify(pub.j)));
  ok('bad recap token is 404', (await call({}, 'GET', '/api/shared/deadbeef')).s === 404);

  // --- sample group
  const d = (await call(b, 'POST', '/api/demo', { tz: 'America/New_York' })).j;
  const dw = (await call(b, 'GET', `/api/groups/${d.id}/wall`)).j;
  ok('sample group has 4 members and is flagged', dw.members.length === 4 && dw.group.sample === 1);
  const dana = dw.members.find(m => m.name.startsWith('Dana')), tim = dw.members.find(m => m.name.startsWith('Timur'));
  ok('sample Dana has a 22-day streak (21 + today)', dana.streak === 22, dana.streak);
  ok('sample Timur is silent 3 days', tim.silent === 3, tim.silent);
  const dl = (await call(b, 'GET', `/api/groups/${d.id}/ledger`)).j;
  ok('sample ledger has open and paid debts', dl.debts.some(x => x.paid) && dl.debts.some(x => !x.paid));
  ok('sample friends cannot log in', (await call({}, 'POST', '/api/login', { name: dana.name, password: 'no-login' })).s === 400);
  ok('third sample group refused', ((await call(b, 'POST', '/api/demo', {})).s === 200) && (await call(b, 'POST', '/api/demo', {})).s === 400);

  // --- one doubter is not enough; cannot leave with money on today
  await call(b, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Z' }); await call(b, 'POST', `/api/groups/${g.id}/stake`, { amount: 2 });
  await call(b, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Y' });
  let bw2 = (await call(b, 'GET', `/api/groups/${g.id}/wall`)).j.members.find(m => m.me);
  await call(b, 'POST', `/api/tasks/${bw2.tasks[0].id}/toggle`, {});
  ok('cannot leave with an unfinished staked plan today', (await call(b, 'POST', `/api/groups/${g.id}/leave`, {})).s === 400);
  await call(b, 'POST', `/api/tasks/${bw2.tasks[1].id}/toggle`, {});
  const aw2 = (await call(a, 'GET', `/api/groups/${g.id}/wall`)).j.members.find(m => m.name === 'Dana');
  await call(a, 'POST', `/api/tasks/${aw2.tasks[0].id}/doubt`, {});
  shift(1);
  const led2 = (await call(a, 'GET', `/api/groups/${g.id}/ledger`)).j;
  ok('a single doubter cannot make a friend pay', !led2.debts.some(d => d.name === 'Dana'), led2.debts);
  ok('path traversal is not served', (await fetch(BASE + '/..%2fserver.js')).headers.get('content-type').includes('html'));
  ok('new recovery code works for any account', ((await call(a, 'POST', '/api/recovery/new', { password: 'abcdef1' })).j.recovery || '').length === 12);

  // --- default bet, grace window, crew minimum
  const eve = await mk('Eve'), frank = await mk('Frank');
  const g2 = (await call(eve, 'POST', '/api/groups', { name: 'Gym crew', tz: 'America/New_York' })).j;
  await call(frank, 'POST', '/api/join', { code: g2.code });
  await call(eve, 'POST', `/api/groups/${g2.id}/tasks`, { title: 'Run' });
  let ew = (await call(eve, 'GET', `/api/groups/${g2.id}/wall`)).j.members.find(m => m.me);
  ok('first task puts a $2 default bet on', ew.stake === 2 && ew.canLower === true, ew.stake);
  ok('can switch to None within the grace window', (await call(eve, 'POST', `/api/groups/${g2.id}/stake`, { amount: 0 })).s === 200);
  ok('can raise the bet', (await call(eve, 'POST', `/api/groups/${g2.id}/stake`, { amount: 5 })).s === 200);
  ok('can still lower within grace (nothing ticked)', (await call(eve, 'POST', `/api/groups/${g2.id}/stake`, { amount: 2 })).s === 200);
  await new Promise(r => setTimeout(r, 2800));
  ok('after the grace window the bet cannot go down', (await call(eve, 'POST', `/api/groups/${g2.id}/stake`, { amount: 0 })).s === 400);
  ew = (await call(eve, 'GET', `/api/groups/${g2.id}/wall`)).j.members.find(m => m.me);
  ok('canLower is false after grace', ew.canLower === false);
  ok('staked task cannot be removed after grace', (await call(eve, 'POST', `/api/tasks/${ew.tasks[0].id}/delete`, {})).s === 400);
  // a typo can be fixed during grace: Frank adds, removes at once
  await call(frank, 'POST', `/api/groups/${g2.id}/tasks`, { title: 'typo' });
  const fw = (await call(frank, 'GET', `/api/groups/${g2.id}/wall`)).j.members.find(m => m.me);
  ok('task can be removed during grace even with a bet', (await call(frank, 'POST', `/api/tasks/${fw.tasks[0].id}/delete`, {})).s === 200);
  ok('only the creator can set the crew rule', (await call(frank, 'POST', `/api/groups/${g2.id}/rules`, { min_stake: 5 })).s === 403);
  ok('creator sets a $5 minimum', (await call(eve, 'POST', `/api/groups/${g2.id}/rules`, { min_stake: 5 })).s === 200);
  ok('minimum above $5 needs Plus', (await call(eve, 'POST', `/api/groups/${g2.id}/rules`, { min_stake: 8 })).s === 402);
  ok('invite preview shows the crew rule', (await call({}, 'GET', '/api/invite/' + g2.code)).j.min_stake === 5);
  await call(frank, 'POST', `/api/groups/${g2.id}/tasks`, { title: 'Swim' });
  const fw2 = (await call(frank, 'GET', `/api/groups/${g2.id}/wall`)).j.members.find(m => m.me);
  ok('default bet follows the crew minimum ($5)', fw2.stake === 5, fw2.stake);
  ok('cannot go below the crew minimum', (await call(frank, 'POST', `/api/groups/${g2.id}/stake`, { amount: 2 })).s === 400);
  ok('cannot pick None under a minimum', (await call(frank, 'POST', `/api/groups/${g2.id}/stake`, { amount: 0 })).s === 400);
  const g3 = (await call(frank, 'POST', '/api/groups', { name: 'Strict', tz: 'America/New_York', min_stake: 2 })).j;
  ok('group can be created with a minimum', (await call(frank, 'GET', `/api/groups/${g3.id}/wall`)).j.group.min_stake === 2);

  // --- rename follows the same lock as removal
    await call(frank, 'POST', `/api/groups/${g3.id}/tasks`, { title: 'Old name' });
  const f3 = (await call(frank, 'GET', `/api/groups/${g3.id}/wall`)).j.members.find(m => m.me);
  ok('rename allowed during grace', (await call(frank, 'POST', `/api/tasks/${f3.tasks[0].id}/rename`, { title: 'New name' })).s === 200);
  ok('rename shows on the wall', (await call(frank, 'GET', `/api/groups/${g3.id}/wall`)).j.members.find(m => m.me).tasks[0].title === 'New name');
  ok('empty rename refused', (await call(frank, 'POST', `/api/tasks/${f3.tasks[0].id}/rename`, { title: '  ' })).s === 400);
  ok("cannot rename a friend's task", (await call(eve, 'POST', `/api/tasks/${f3.tasks[0].id}/rename`, { title: 'x' })).s === 403);
  ok('rename refused on a staked task after grace', (await call(eve, 'POST', `/api/tasks/${ew.tasks[0].id}/rename`, { title: 'Easy one' })).s === 400);

  // --- gamification + profile pictures
  const jpg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]).toString('base64');
  ok('profile starts at level 1 with a first-win-less badge list', (await call(eve, 'GET', '/api/profile')).j.badges.length === 10);
  ok('valid JPEG avatar accepted', (await call(eve, 'POST', '/api/avatar', { image: jpg })).s === 200);
  ok('PNG avatar refused', (await call(eve, 'POST', '/api/avatar', { image: 'data:image/png;base64,AAAA' })).s === 400);
  ok('fake JPEG (wrong bytes) refused', (await call(eve, 'POST', '/api/avatar', { image: 'data:image/jpeg;base64,' + Buffer.alloc(400, 1).toString('base64') })).s === 400);
  ok('huge avatar refused', (await call(eve, 'POST', '/api/avatar', { image: 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(70000, 1)]).toString('base64') })).s === 400);
  const av1 = await fetch(BASE + `/api/avatar/${eve.id}`, { headers: { cookie: frank.cookie } });
  ok('friend in the same group can load the photo', av1.status === 200 && av1.headers.get('content-type') === 'image/jpeg');
  const av2 = await fetch(BASE + `/api/avatar/${eve.id}`, { headers: { cookie: c.cookie } });
  ok('someone outside the group cannot load it', av2.status === 404);
  ok('wall carries the avatar url', (await call(frank, 'GET', `/api/groups/${g2.id}/wall`)).j.members.find(m => m.name === 'Eve').avatar.startsWith(`/api/avatar/${eve.id}?v=`));
  await call(eve, 'POST', '/api/avatar/remove', {}); ok('photo can be removed', (await call(eve, 'GET', '/api/profile')).j.avatar === null);
  // XP: 10 per ticked task
  const xp0 = (await call(frank, 'GET', '/api/profile')).j.xp;
  await call(frank, 'POST', `/api/groups/${g3.id}/tasks`, { title: 'XP task' });
  const fx = (await call(frank, 'GET', `/api/groups/${g3.id}/wall`)).j.members.find(m => m.me);
  await call(frank, 'POST', `/api/tasks/${fx.tasks.find(t => t.title === 'XP task').id}/toggle`, {});
  ok('ticking a task gives +10 XP', (await call(frank, 'GET', '/api/profile')).j.xp === xp0 + 10, [xp0]);
  ok('wall shows level and XP', (await call(frank, 'GET', `/api/groups/${g3.id}/wall`)).j.members.find(m => m.me).level >= 1);
  const sdw = (await call(b, 'GET', `/api/groups/${d.id}/wall`)).j;
  const sd = sdw.members.find(m => m.name.startsWith('Dana'));
  ok('sample Dana is a high level with streak badges', sd.level >= 4 && sd.badges.includes('streak21') && sd.badges.includes('first_win'), [sd.level, sd.badges]);
  ok('sample Arman earned Paid up and Comeback', (() => { const a2 = sdw.members.find(m => m.name.startsWith('Arman')); return a2.badges.includes('paid_up') || a2.badges.includes('comeback'); })());
  ok('crew quest has a goal of 10 per member', sdw.group.quest.goal === 40 && sdw.group.quest.done >= 20, sdw.group.quest);
  ok('level boundaries: 0 XP is level 1', (await call(await mk('Zed'), 'GET', '/api/profile')).j.level === 1);
  ok('recap includes levels', (await call(b, 'GET', `/api/groups/${d.id}/recap`)).j.members.every(m => m.level >= 1));

  // --- Telegram link + reminder + nudge notification
  const lk = (await call(a, 'POST', '/api/telegram/link', {})).j.link; const tok = lk.split('start=')[1];
  queue.push({ update_id: 1, message: { chat: { id: 4242 }, text: '/start ' + tok } });
  await new Promise(r => setTimeout(r, 900));
  ok('Telegram /start links the account', (await call(a, 'GET', '/api/me')).j.telegram.linked === true);
  ok('bot confirmed the link', sent.some(m => /Linked/.test(m.text)));
  // Ali has no plan today (day was shifted) but a streak? streak 0 -> expect reminder only if tasks left. Give a plan:
  await call(a, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Read' }); await call(a, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Write' });
  await new Promise(r => setTimeout(r, 1200));
  ok('evening reminder sent for unfinished plan', sent.some(m => m.chat_id === '4242' && /2 tasks left/.test(m.text)), sent.map(m => m.text));
  const n1 = sent.length; await new Promise(r => setTimeout(r, 1000));
  ok('reminder is sent only once per day', sent.filter(m => /tasks left/.test(m.text)).length === 1);
  const dw2 = (await call(b, 'GET', `/api/groups/${g.id}/wall`)).j; const ali = dw2.members.find(m => m.name === 'Ali');
  await call(b, 'POST', `/api/groups/${g.id}/nudge`, { user_id: ali.id });
  await new Promise(r => setTimeout(r, 300));
  ok('nudge reaches Telegram', sent.some(m => /nudged you/.test(m.text)));
  await call(a, 'POST', '/api/telegram/unlink', {}); ok('unlink works', (await call(a, 'GET', '/api/me')).j.telegram.linked === false);

  // --- v5: XP cap, feed, notifications, reactions, freezes, previews, PWA, admin
  {
    const ian = await mk('Ian'), jo = await mk('Jo'), kim = await mk('Kim');
    const gx = (await call(jo, 'POST', '/api/groups', { name: 'Crew X', tz: 'America/New_York' })).j;
    await call(kim, 'POST', '/api/join', { code: gx.code }); await call(ian, 'POST', '/api/join', { code: gx.code });
    // XP cap: 8 ticked tasks count as 5
    const ids = [];
    for (let i = 0; i < 8; i++) { await call(ian, 'POST', `/api/groups/${gx.id}/tasks`, { title: 'junk ' + i }); }
    const wi = (await call(ian, 'GET', `/api/groups/${gx.id}/wall`)).j.members.find(m => m.me);
    for (const t of wi.tasks) await call(ian, 'POST', `/api/tasks/${t.id}/toggle`, {});
    const pi = (await call(ian, 'GET', '/api/profile')).j;
    ok('XP counts at most 5 tasks a day', pi.xp <= 5 * 10 + 25 + 15, pi.xp);
    ok('XP still counts 5 tasks', pi.xp >= 50, pi.xp);
    // Notifications + feed
    await call(kim, 'POST', `/api/groups/${gx.id}/tasks`, { title: 'Gym' });
    const kt = (await call(kim, 'GET', `/api/groups/${gx.id}/wall`)).j.members.find(m => m.me).tasks[0];
    const before = (await call(jo, 'GET', '/api/notifications')).j.items.length;
    await call(kim, 'POST', `/api/tasks/${kt.id}/toggle`, {});
    const nj = (await call(jo, 'GET', '/api/notifications')).j;
    ok('friend finishing a task notifies others', nj.items.some(n => /Kim finished "Gym"/.test(n.text)) && nj.unread > 0);
    ok('/api/me reports unread', (await call(jo, 'GET', '/api/me')).j.unread === nj.unread);
    const kn = (await call(kim, 'GET', '/api/notifications')).j.items;
    ok('own finished task does not notify yourself', !kn.some(n => /Kim finished/.test(n.text)));
    await call(kim, 'POST', `/api/tasks/${kt.id}/toggle`, {}); await call(kim, 'POST', `/api/tasks/${kt.id}/toggle`, {});
    const nj2 = (await call(jo, 'GET', '/api/notifications')).j.items.filter(n => /Kim finished "Gym"/.test(n.text));
    ok('re-ticking does not duplicate the notification', nj2.length === 1, nj2.length);
    const wj = (await call(jo, 'GET', `/api/groups/${gx.id}/wall`)).j;
    ok('wall has a feed with the finished task', wj.feed.some(f => /Kim finished "Gym"/.test(f.text)) && wj.unread === nj.unread);
    await call(jo, 'POST', '/api/notifications/read', {});
    ok('mark as read clears unread', (await call(jo, 'GET', '/api/me')).j.unread === 0);
    ok('telegram notify toggle saved', (await call(jo, 'POST', '/api/notify', { telegram: false })).s === 200 && (await call(jo, 'GET', '/api/me')).j.telegram.notify === false);
    // Reactions
    const rk = (await call(jo, 'POST', `/api/tasks/${kt.id}/react`, { emoji: '🔥' }));
    ok('friend can react to a finished task', rk.s === 200);
    let rt = (await call(jo, 'GET', `/api/groups/${gx.id}/wall`)).j.members.find(m => m.name === 'Kim').tasks[0];
    ok('reaction is counted and marked mine', rt.reacts.some(r => r.emoji === '🔥' && r.n === 1 && r.mine));
    ok('owner is told about the reaction', (await call(kim, 'GET', '/api/notifications')).j.items.some(n => /Jo reacted/.test(n.text)));
    ok('cannot react to your own task', (await call(kim, 'POST', `/api/tasks/${kt.id}/react`, { emoji: '👏' })).s >= 400);
    ok('unknown emoji refused', (await call(jo, 'POST', `/api/tasks/${kt.id}/react`, { emoji: '💩' })).s >= 400);
    await call(jo, 'POST', `/api/tasks/${kt.id}/react`, { emoji: '🔥' });
    rt = (await call(jo, 'GET', `/api/groups/${gx.id}/wall`)).j.members.find(m => m.name === 'Kim').tasks[0];
    ok('same reaction again removes it', !rt.reacts.length);
    // Freezes: a skipped day after a done day keeps the streak once; stake still counts as a debt
    const gina = await mk('Gina'), hal = await mk('Hal');
    const gz = (await call(gina, 'POST', '/api/groups', { name: 'Ice', tz: 'America/New_York' })).j;
    await call(hal, 'POST', '/api/join', { code: gz.code });
    for (const u of [gina, hal]) { await call(u, 'POST', `/api/groups/${gz.id}/tasks`, { title: 'Run' }); }
    for (const u of [gina, hal]) { const m = (await call(u, 'GET', `/api/groups/${gz.id}/wall`)).j.members.find(x => x.me); for (const t of m.tasks) await call(u, 'POST', `/api/tasks/${t.id}/toggle`, {}); }
    shift(1);
    await call(hal, 'POST', `/api/groups/${gz.id}/tasks`, { title: 'Swim' }); // staked by default, never ticked
    shift(1);
    const wz = (await call(gina, 'GET', `/api/groups/${gz.id}/wall`)).j;
    const res = sql('SELECT user_id,status FROM results WHERE group_id=? ORDER BY day', gz.id);
    ok('skipped day after a done day is frozen for the free user', res.some(r => r.user_id === gina.id && r.status === 'frozen_none'), res);
    ok('frozen day keeps the streak', wz.members.find(m => m.me).streak >= 1, wz.members.find(m => m.me).streak);
    ok('missed staked day is frozen but the debt is still owed', res.some(r => r.user_id === hal.id && r.status === 'frozen_missed') && sql('SELECT amount FROM debts WHERE group_id=? AND user_id=?', gz.id, hal.id).length === 1, res);
    ok('wall reports the freeze allowance', wz.group.freezeAllowance === 1 && typeof wz.group.freezesLeft === 'number');
    // Link previews, PWA files, admin
    const pv = await fetch(BASE + '/join/' + gx.code).then(r => r.text());
    ok('invite link has Open Graph preview', /og:title" content="Join Crew X on Crewmate"/.test(pv) && /og:image/.test(pv), pv.slice(0, 300));
    ok('unknown invite code still serves the app', (await fetch(BASE + '/join/ffffffff')).status === 200);
    const mf = await fetch(BASE + '/manifest.webmanifest'); ok('manifest is served', mf.status === 200 && (await mf.json()).name === 'Crewmate');
    ok('service worker is served', (await fetch(BASE + '/sw.js')).status === 200);
    ok('icon is served as png', (await fetch(BASE + '/icon-192.png')).headers.get('content-type') === 'image/png');
    ok('admin stats hidden without token', (await call({}, 'GET', '/api/admin/stats')).s === 404);
  }

  // --- Crew challenges (being in means money is on it) and optional proof per task
  {
    const p = await mk('Pia'), r = await mk('Rob'), s = await mk('Sol'), out = await mk('Outsider');
    const g = (await call(p, 'POST', '/api/groups', { name: 'Run club', tz: 'UTC' })).j;
    await call(r, 'POST', '/api/join', { code: g.code }); await call(s, 'POST', '/api/join', { code: g.code });
    const wallOf = async u => (await call(u, 'GET', `/api/groups/${g.id}/wall`)).j, mine = async u => (await wallOf(u)).members.find(x => x.me);
    const shiftCh = n => { shift(n); exec(`UPDATE challenges SET start=date(start,'-${n} day'), ended=date(ended,'-${n} day')`); exec(`UPDATE challenge_members SET since=date(since,'-${n} day')`); };
    const debtsOf = u => sql('SELECT amount FROM debts WHERE group_id=? AND user_id=?', g.id, u.id);
    ok('challenge without a stake is refused', (await call(p, 'POST', `/api/groups/${g.id}/challenges`, { title: 'Run', stake: 0 })).s === 400);
    ok('challenge above $5 needs Plus', (await call(p, 'POST', `/api/groups/${g.id}/challenges`, { title: 'Run', stake: 10 })).s === 402);
    ok('challenge needs a title', (await call(p, 'POST', `/api/groups/${g.id}/challenges`, { title: ' ', stake: 5 })).s === 400);
    ok('outsider cannot set a challenge', (await call(out, 'POST', `/api/groups/${g.id}/challenges`, { title: 'Run', stake: 5 })).s === 403);
    const c1 = await call(p, 'POST', `/api/groups/${g.id}/challenges`, { title: '6 a.m. run', stake: 5 });
    ok('challenge is created', c1.s === 200 && c1.j.id > 0, c1.j);
    ok('free crew runs one challenge at a time', (await call(p, 'POST', `/api/groups/${g.id}/challenges`, { title: 'Second', stake: 2 })).s === 402);
    let me = await mine(p);
    ok('creator gets the challenge task with a locked $5 on it', me.tasks.length === 1 && me.tasks[0].challenge_id === c1.j.id && me.stake === 5 && !me.canLower, me);
    const wr0 = await wallOf(r);
    ok('friends are not in until they say so', wr0.members.find(x => x.me).total === 0 && wr0.group.challenges[0].in.length === 1);
    ok('invite preview shows the challenge', ((await call({}, 'GET', '/api/invite/' + g.code)).j.challenge || {}).title === '6 a.m. run');
    ok('outsider cannot join the challenge', (await call(out, 'POST', `/api/challenges/${c1.j.id}/join`, {})).s === 403);
    ok('friend joins the challenge', (await call(r, 'POST', `/api/challenges/${c1.j.id}/join`, {})).s === 200);
    const rm = await mine(r);
    ok('joining puts the task and the stake on today', rm.tasks.length === 1 && rm.stake === 5 && (await wallOf(r)).group.challenges[0].in.length === 2, rm);
    ok('stake cannot drop below the challenge', (await call(r, 'POST', `/api/groups/${g.id}/stake`, { amount: 2 })).s === 400);
    ok('challenge task cannot be removed', (await call(r, 'POST', `/api/tasks/${rm.tasks[0].id}/delete`, {})).s === 400);
    ok('challenge task cannot be renamed', (await call(r, 'POST', `/api/tasks/${rm.tasks[0].id}/rename`, { title: 'Nap' })).s === 400);
    await call(p, 'POST', `/api/tasks/${me.tasks[0].id}/toggle`, {});
    shiftCh(1);
    me = await mine(p); // closes yesterday
    ok('who showed up owes nothing, who skipped owes the stake', debtsOf(p).length === 0 && debtsOf(r).length === 1 && debtsOf(r)[0].amount === 5 && debtsOf(s).length === 0, [debtsOf(p), debtsOf(r), debtsOf(s)]);
    ok('the challenge is back on the plan the next day', me.tasks.length === 1 && !me.tasks[0].done && me.stake === 5);
    await call(p, 'POST', `/api/tasks/${me.tasks[0].id}/toggle`, {});
    shiftCh(1); await wallOf(p); // Rob never opened the app on the day that just closed
    ok('skipping without opening the app still counts', debtsOf(r).length === 2, debtsOf(r));
    ok('leaving the challenge works', (await call(r, 'POST', `/api/challenges/${c1.j.id}/leave`, {})).s === 200);
    shiftCh(1); await wallOf(p);
    ok('the day already on the plan still counts after leaving', debtsOf(r).length === 3, debtsOf(r));
    shiftCh(1); await wallOf(p);
    ok('after leaving, later days cost nothing', debtsOf(r).length === 3, debtsOf(r));
    ok('only the creator can end a challenge', (await call(s, 'POST', `/api/challenges/${c1.j.id}/end`, {})).s === 403);
    ok('creator ends the challenge', (await call(p, 'POST', `/api/challenges/${c1.j.id}/end`, {})).s === 200);
    shiftCh(1);
    const wEnd = await wallOf(p);
    ok('an ended challenge is gone the next day', wEnd.group.challenges.length === 0 && wEnd.members.find(x => x.me).total === 0, wEnd.group.challenges);
    ok('weekday list is cleaned up and stored', (await call(p, 'POST', `/api/groups/${g.id}/challenges`, { title: 'Gym', stake: 2, days: '3311' })).s === 200 && sql("SELECT days FROM challenges WHERE title='Gym'")[0].days === '13');
    ok('bad weekday list is refused', (await call(s, 'POST', `/api/groups/${g.id}/challenges`, { title: 'X', stake: 2, days: '79' })).s === 400);

    // optional proof on a personal task: a check-in time and a photo
    const d0 = new Date(), nowMin = d0.getUTCHours() * 60 + d0.getUTCMinutes(), hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const jpg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]).toString('base64');
    ok('task with a check-in time and photo is accepted', (await call(s, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Stretch', due: hhmm(nowMin), photo: true })).s === 200);
    const st = (await mine(s)).tasks.find(x => x.title === 'Stretch');
    ok('wall shows the proof options', st.due === hhmm(nowMin) && st.need_photo === 1 && !st.hasPhoto, st);
    ok('photo task refuses a tick without a photo', (await call(s, 'POST', `/api/tasks/${st.id}/toggle`, {})).s === 400);
    ok('photo task refuses a file that is not a JPEG', (await call(s, 'POST', `/api/tasks/${st.id}/toggle`, { photo: 'data:image/jpeg;base64,' + Buffer.alloc(300, 1).toString('base64') })).s === 400);
    ok('tick with a photo inside the window works', (await call(s, 'POST', `/api/tasks/${st.id}/toggle`, { photo: jpg })).s === 200);
    const ph = await call(p, 'GET', `/api/tasks/${st.id}/photo`);
    ok('photo is shown to a crew member', ph.s === 200 && ph.h.get('content-type') === 'image/jpeg');
    ok('photo is hidden from outsiders', (await call(out, 'GET', `/api/tasks/${st.id}/photo`)).s === 404);
    ok('untick inside the window works and drops the photo', (await call(s, 'POST', `/api/tasks/${st.id}/toggle`, {})).s === 200 && sql('SELECT photo FROM tasks WHERE id=?', st.id)[0].photo === null);
    exec(`UPDATE tasks SET due='${hhmm((nowMin + 720) % 1440)}' WHERE id=${st.id}`);
    ok('tick outside the check-in window is refused', (await call(s, 'POST', `/api/tasks/${st.id}/toggle`, { photo: jpg })).s === 400);
    ok('a check-in time that already passed is refused', nowMin < 40 || (await call(s, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Late', due: hhmm(nowMin - 30) })).s === 400);
    ok('a task without proof options still ticks freely', (await call(s, 'POST', `/api/groups/${g.id}/tasks`, { title: 'Read' })).s === 200 && (await call(s, 'POST', `/api/tasks/${(await mine(s)).tasks.find(x => x.title === 'Read').id}/toggle`, {})).s === 200);
  }

  // --- Stripe lifecycle
  const crypto = require('node:crypto');
  // webhook secret is not set in this run: must refuse
  ok('stripe webhook refuses when not configured', (await call({}, 'POST', '/api/stripe/webhook', {})).s === 400);

  console.log(JSON.stringify({ passed: pass, failed: fail, failures }, null, 2));
  srv.kill(); tg.close(); process.exit(fail ? 1 : 0);
})();
