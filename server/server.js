// Healthy Fit — сервер (Node 22+, без внешних зависимостей).
// Отдаёт сайт из ../public, проксирует фото в ProxyAPI (ключ только на сервере),
// хранит аккаунты, друзей, сообщения, медиа и данные «Здоровья» в SQLite.
import http from 'node:http';
import { readFile, writeFile, stat, mkdir, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const DATA = process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const MEDIA = join(DATA, 'media');
const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.PROXYAPI_KEY || '';
const LIMIT = Number(process.env.RATE_LIMIT || 30);
const SECURE = process.env.COOKIE_SECURE !== '0';
await mkdir(MEDIA, { recursive: true });

/* ---------------- DB ---------------- */
const db = new DatabaseSync(join(DATA, 'healthy.db'));
db.exec(`
PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  pass TEXT NOT NULL, avatar TEXT, bio TEXT DEFAULT '', health_token TEXT UNIQUE, created INTEGER NOT NULL,
  stats TEXT DEFAULT '{}', sync TEXT, sync_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS friends (a INTEGER NOT NULL, b INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, sender INTEGER NOT NULL, recipient INTEGER NOT NULL, kind TEXT NOT NULL,
  body TEXT, media TEXT, meta TEXT, created INTEGER NOT NULL, read_at INTEGER);
CREATE INDEX IF NOT EXISTS msg_pair ON messages (sender, recipient, id);
CREATE INDEX IF NOT EXISTS msg_rcpt ON messages (recipient, id);
CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, owner INTEGER NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, media TEXT, caption TEXT, meta TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id, id);
CREATE TABLE IF NOT EXISTS likes (post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id, id);
CREATE TABLE IF NOT EXISTS flame_restores (a INTEGER NOT NULL, b INTEGER NOT NULL, day TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE IF NOT EXISTS health (user_id INTEGER NOT NULL, date TEXT NOT NULL, steps INTEGER, active_kcal INTEGER, source TEXT, updated INTEGER NOT NULL,
  PRIMARY KEY (user_id, date));
`);
const q = sql => db.prepare(sql);
const now = () => Date.now();

/* ---------------- helpers ---------------- */
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const fail = (code, error) => Object.assign(new Error(error), { code, public: true });
async function readBody(req, max) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw fail(413, 'Слишком большой файл'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const json = async (req, max = 64_000) => { try { return JSON.parse((await readBody(req, max)).toString('utf8') || '{}'); } catch (e) { if (e.public) throw e; throw fail(400, 'Неверный запрос'); } };
const buckets = new Map();
function rate(key, max, windowMs) {
  const t = now(), a = (buckets.get(key) || []).filter(x => t - x < windowMs); a.push(t); buckets.set(key, a);
  if (a.length > max) throw fail(429, 'Слишком часто. Подождите немного.');
}
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const sha = s => createHash('sha256').update(s).digest('hex');

function hashPass(p) { const salt = randomBytes(16); return 'scrypt$' + salt.toString('hex') + '$' + scryptSync(p, salt, 64).toString('hex'); }
function checkPass(p, stored) {
  const [, salt, hash] = String(stored).split('$'); if (!salt) return false;
  const a = scryptSync(p, Buffer.from(salt, 'hex'), 64), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookieToken(req) { const m = /(?:^|;\s*)hf=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || ''); return m && m[1]; }
function userOf(req) {
  const t = cookieToken(req); if (!t) return null;
  return q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(sha(t)) || null;
}
function need(req) { const u = userOf(req); if (!u) throw fail(401, 'Войдите в аккаунт'); return u; }
function startSession(res, userId) {
  const t = randomBytes(32).toString('base64url');
  q('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(sha(t), userId, now());
  res.setHeader('Set-Cookie', `hf=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${SECURE ? '; Secure' : ''}`);
}
const withFlame = (me, u) => u && ({ ...pub(u), flame: flame(me, u.id) });
const pub = u => u && { id: u.id, username: u.username, name: u.name, avatar: u.avatar ? `/media/${u.avatar}` : '', bio: u.bio || '', stats: JSON.parse(u.stats || '{}') };
const friendState = (me, other) => {
  const f = q('SELECT * FROM friends WHERE a = ? AND b = ?').get(Math.min(me, other), Math.max(me, other));
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  const [from] = f.status.split(':').slice(1).map(Number);
  return from === me ? 'sent' : 'incoming';
};
const areFriends = (a, b) => friendState(a, b) === 'friends';
const canSee = (me, author) => me === author || areFriends(me, author);

/* ---------------- публикации ---------------- */
function shapePost(p, me) {
  const author = q('SELECT * FROM users WHERE id = ?').get(p.user_id);
  return { id: p.id, author: pub(author), media: p.media ? `/media/${p.media}` : '', caption: p.caption || '',
    meta: p.meta ? JSON.parse(p.meta) : null, created: p.created,
    likes: q('SELECT COUNT(*) n FROM likes WHERE post_id = ?').get(p.id).n,
    liked: Boolean(q('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(p.id, me)),
    comments: q('SELECT COUNT(*) n FROM comments WHERE post_id = ?').get(p.id).n, mine: p.user_id === me };
}
function visiblePost(id, me) {
  const p = q('SELECT * FROM posts WHERE id = ?').get(id);
  if (!p || !canSee(me, p.user_id)) throw fail(404, 'Публикация не найдена');
  return p;
}
const shapeComment = c => ({ id: c.id, body: c.body, created: c.created, author: pub(q('SELECT * FROM users WHERE id = ?').get(c.user_id)) });
const USERNAME = /^[a-z0-9_.]{3,20}$/i;

/* ---------------- огонёк дружбы ---------------- */
// День засчитывается, если оба написали друг другу хотя бы по одному сообщению.
// 3+ дня подряд — огонёк горит. Пропущен один день — гаснет; восстановить можно один раз на пару.
const TZ = process.env.APP_TZ || 'Europe/Moscow';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = t => dayFmt.format(new Date(t));
const prevDay = k => { const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
function flame(me, other) {
  const rows = q(`SELECT sender, created FROM messages WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) AND created > ?`)
    .all(me, other, other, me, now() - 400 * 864e5);
  const mine = new Set(), theirs = new Set();
  for (const r of rows) (r.sender === me ? mine : theirs).add(dayKey(r.created));
  const restored = q('SELECT day FROM flame_restores WHERE a = ? AND b = ?').get(Math.min(me, other), Math.max(me, other));
  const mutual = d => (mine.has(d) && theirs.has(d)) || restored?.day === d;
  const run = from => { let n = 0, d = from; while (mutual(d)) { n++; d = prevDay(d); } return n; };
  const today = dayKey(now()), yest = prevDay(today);
  const todayDone = mutual(today), count = todayDone ? run(today) : run(yest);
  if (count >= 3) return { count, state: todayDone ? 'active' : 'risk', canRestore: false, todayMine: mine.has(today), todayTheirs: theirs.has(today) };
  const lost = !mutual(yest) ? run(prevDay(yest)) : 0;
  if (lost >= 3) return { count: lost, state: 'out', canRestore: !restored, restoreDay: yest };
  return { count, state: 'none', canRestore: false, todayMine: mine.has(today), todayTheirs: theirs.has(today) };
}

/* ---------------- AI analyze (ProxyAPI) ---------------- */
const MODELS = {
  fast:    { id: 'openai/gpt-6-luna',           label: 'GPT-6 Luna' },
  precise: { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  gemini:  { id: 'google/gemini-3.5-flash',     label: 'Gemini 3.5 Flash' },
};
const PROMPT = await readFile(fileURLToPath(new URL('./prompt.txt', import.meta.url)), 'utf8');
const num = v => (Number.isFinite(+v) ? +v : 0);
const pick = (v, allowed, dflt) => { v = String(v || '').toLowerCase(); return allowed.includes(v) ? v : dflt; };
function clean(j) {
  const items = Array.isArray(j.items) ? j.items : [];
  return {
    items: items.slice(0, 20).map(i => ({
      name: String(i.name_ru || i.name_en || 'Блюдо').slice(0, 60),
      role: pick(i.role, ['food', 'drink', 'sauce'], 'food'), fat: pick(i.fat, ['none', 'light', 'heavy', 'included'], 'none'),
      grams: Math.max(0, Math.min(2000, num(i.grams))), grams_low: num(i.grams_low), grams_high: num(i.grams_high),
      kcal_100: Math.max(0, Math.min(900, num(i.kcal_100))), p_100: Math.max(0, Math.min(100, num(i.p_100))),
      f_100: Math.max(0, Math.min(100, num(i.f_100))), c_100: Math.max(0, Math.min(100, num(i.c_100))),
    })).filter(i => i.grams > 0),
    confidence: pick(j.confidence, ['low', 'medium', 'high'], 'medium'),
    question: String(j.question || '').slice(0, 120),
    options: (Array.isArray(j.options) ? j.options : []).slice(0, 4).map(o => String(o).slice(0, 40)),
  };
}
async function analyze(req, res) {
  if (!KEY) throw fail(500, 'Сервер не настроен: нет ключа нейросети');
  rate('ai:' + ipOf(req), LIMIT, 600_000);
  const body = await json(req, 4_000_000);
  const image = String(body.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 3_000_000) throw fail(400, 'Нужна фотография JPEG/PNG до ~2 МБ');
  const model = MODELS[body.model] || MODELS.fast;
  const caption = String(body.caption || '').replace(/[<>]/g, '').slice(0, 300);
  const t0 = now(), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 50_000);
  let r;
  try {
    r = await fetch('https://api.proxyapi.ru/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.id, max_completion_tokens: 4000, messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT.replace('{caption}', caption) }, { type: 'image_url', image_url: { url: image } }] }] }),
    });
  } catch { throw fail(504, 'Нейросеть не ответила. Попробуйте ещё раз.'); } finally { clearTimeout(timer); }
  // 4xx не повторяем: ProxyAPI ставит ключ на паузу после 20 ошибок в минуту
  if (r.status === 402) { console.error('proxyapi 402: пополните баланс'); throw fail(503, 'Сервис временно недоступен. Попробуйте позже.'); }
  if (r.status === 429) throw fail(429, 'Очередь занята. Попробуйте через минуту.');
  if (!r.ok) { console.error('proxyapi', r.status, (await r.text()).slice(0, 300)); throw fail(502, 'Не получилось распознать. Попробуйте ещё раз.'); }
  const data = await r.json().catch(() => null);
  const m = String(data?.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
  let parsed = null; try { parsed = m ? JSON.parse(m[0]) : null; } catch {}
  if (!parsed) throw fail(502, 'Нейросеть ответила непонятно. Попробуйте ещё раз.');
  console.log(`analyze ${model.id} ${now() - t0}ms tokens=${data?.usage?.total_tokens ?? '?'}`);
  send(res, 200, { ...clean(parsed), model: model.label, ms: now() - t0 });
}

/* ---------------- media ---------------- */
const MEDIA_TYPES = {
  'image/jpeg': { ext: '.jpg', max: 3e6 }, 'image/webp': { ext: '.webp', max: 3e6 },
  'audio/webm': { ext: '.webm', max: 3e6 }, 'audio/mp4': { ext: '.m4a', max: 3e6 }, 'audio/ogg': { ext: '.ogg', max: 3e6 },
  'video/webm': { ext: '.webm', max: 25e6 }, 'video/mp4': { ext: '.mp4', max: 25e6 },
};
async function upload(req, res, me) {
  rate('up:' + me.id, 60, 600_000);
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const spec = MEDIA_TYPES[type]; if (!spec) throw fail(415, 'Неподдерживаемый формат');
  const buf = await readBody(req, spec.max);
  if (buf.length < 100) throw fail(400, 'Пустой файл');
  const id = randomBytes(16).toString('hex') + spec.ext;
  await writeFile(join(MEDIA, id), buf);
  q('INSERT INTO media (id, owner, type, size, created) VALUES (?, ?, ?, ?, ?)').run(id, me.id, type, buf.length, now());
  send(res, 200, { id, url: `/media/${id}` });
}
async function serveMedia(req, res, id) {
  const m = q('SELECT * FROM media WHERE id = ?').get(id);
  if (!m) { res.writeHead(404); return res.end(); }
  const me = userOf(req);
  const isAvatar = q('SELECT 1 FROM users WHERE avatar = ?').get(id);
  const allowed = isAvatar || (me && (m.owner === me.id ||
    q('SELECT 1 FROM messages WHERE media = ? AND (sender = ? OR recipient = ?)').get(id, me.id, me.id) ||
    q('SELECT user_id FROM posts WHERE media = ?').all(id).some(p => canSee(me.id, p.user_id))));
  if (!allowed) { res.writeHead(403); return res.end(); }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const headers = { 'Content-Type': m.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
  if (range) {
    const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], m.size - 1) : m.size - 1;
    if (start > end || start >= m.size) { res.writeHead(416, { 'Content-Range': `bytes */${m.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${m.size}`, 'Content-Length': end - start + 1 });
    return createReadStream(join(MEDIA, id), { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': m.size });
  createReadStream(join(MEDIA, id)).pipe(res);
}

/* ---------------- health ingest ---------------- */
// Принимает JSON из «Быстрых команд» iOS и из Android-приложений-вебхуков (Health Connect).
// Ищет шаги и активные калории по ключам, поддерживает массивы записей и вложенные объекты.
function harvest(obj, date0) {
  const days = new Map();
  const add = (date, k, v) => { const d = days.get(date) || {}; d[k] = (d[k] || 0) + v; days.set(date, d); };
  const walk = (o, ctxDate, keyPath) => {
    if (o == null) return;
    if (Array.isArray(o)) { o.forEach(x => walk(x, ctxDate, keyPath)); return; }
    if (typeof o === 'object') {
      const d = String(o.date || o.day || o.startTime || o.start_time || o.start || o.time || ctxDate || '').slice(0, 10);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ctxDate;
      for (const [k, v] of Object.entries(o)) walk(v, date, (keyPath + '.' + k).toLowerCase());
      return;
    }
    const n = typeof o === 'string' ? parseFloat(o.replace(',', '.')) : o;
    if (!Number.isFinite(n) || n < 0) return;
    const leaf = keyPath.split('.').pop();
    if (/step/.test(keyPath) && /(count|steps?|value|total|sum)$/.test(leaf)) add(ctxDate, 'steps', n);
    else if (/(active|burn)/.test(keyPath) && /(cal|energy|kcal)/.test(keyPath) && /(kcal|calories|value|total|sum|energy|inkilocalories|kilocalories)$/.test(leaf))
      add(ctxDate, 'active_kcal', /joule/.test(keyPath) ? n / 4184 : n);
  };
  walk(obj, date0, '');
  return days;
}
async function healthIngest(req, res, url) {
  const token = url.searchParams.get('t') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const u = token && q('SELECT * FROM users WHERE health_token = ?').get(token);
  if (!u) throw fail(401, 'Неверный ключ');
  rate('health:' + u.id, 120, 3_600_000);
  let body; try { body = JSON.parse((await readBody(req, 2_000_000)).toString('utf8')); } catch { throw fail(400, 'Нужен JSON'); }
  const today = String(url.searchParams.get('date') || body.date || new Date().toISOString()).slice(0, 10);
  const days = harvest(body, today);
  let saved = 0;
  for (const [date, v] of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const steps = v.steps != null ? Math.min(150000, Math.round(v.steps)) : null;
    const kcal = v.active_kcal != null ? Math.min(6000, Math.round(v.active_kcal)) : null;
    q(`INSERT INTO health (user_id, date, steps, active_kcal, source, updated) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET steps = COALESCE(excluded.steps, steps), active_kcal = COALESCE(excluded.active_kcal, active_kcal),
       source = excluded.source, updated = excluded.updated`).run(u.id, date, steps, kcal, String(req.headers['user-agent'] || '').slice(0, 60), now());
    saved++;
  }
  send(res, 200, { ok: true, days: saved });
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const p = url.pathname, M = req.method;
  if (p === '/api/analyze' && M === 'POST') return analyze(req, res);
  if (p === '/api/health/ingest' && M === 'POST') return healthIngest(req, res, url);

  if (p === '/api/auth/register' && M === 'POST') {
    rate('reg:' + ipOf(req), 10, 3_600_000);
    const b = await json(req);
    const username = String(b.username || '').trim(), name = String(b.name || '').trim().slice(0, 30), pass = String(b.password || '');
    if (!USERNAME.test(username)) throw fail(400, 'Логин: 3–20 символов, латиница, цифры, точка или _');
    if (!name) throw fail(400, 'Укажите имя');
    if (pass.length < 6) throw fail(400, 'Пароль — минимум 6 символов');
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw fail(409, 'Такой логин уже занят');
    const r = q('INSERT INTO users (username, name, pass, health_token, created) VALUES (?, ?, ?, ?, ?)')
      .run(username, name, hashPass(pass), randomBytes(18).toString('base64url'), now());
    startSession(res, Number(r.lastInsertRowid));
    return send(res, 200, { me: pub(q('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
  }
  if (p === '/api/auth/check' && M === 'GET') {
    rate('check:' + ipOf(req), 120, 60_000);
    const u = String(url.searchParams.get('username') || '').trim();
    if (!USERNAME.test(u)) return send(res, 200, { available: false, reason: 'Только латиница, цифры, точка и _, 3–20 символов' });
    return send(res, 200, { available: !q('SELECT 1 FROM users WHERE username = ?').get(u) });
  }
  if (p === '/api/auth/login' && M === 'POST') {
    rate('login:' + ipOf(req), 20, 900_000);
    const b = await json(req);
    const u = q('SELECT * FROM users WHERE username = ?').get(String(b.username || '').trim());
    if (!u || !checkPass(String(b.password || ''), u.pass)) throw fail(401, 'Неверный логин или пароль');
    startSession(res, u.id);
    return send(res, 200, { me: pub(u) });
  }
  if (p === '/api/auth/logout' && M === 'POST') {
    const t = cookieToken(req); if (t) q('DELETE FROM sessions WHERE token = ?').run(sha(t));
    return send(res, 200, { ok: true }, { 'Set-Cookie': `hf=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? '; Secure' : ''}` });
  }

  const me = need(req);
  if (p === '/api/me' && M === 'GET') return send(res, 200, { me: { ...pub(me), healthToken: me.health_token } });
  if (p === '/api/me' && M === 'PATCH') {
    const b = await json(req, 32_000);
    const name = b.name != null ? String(b.name).trim().slice(0, 30) : me.name;
    const bio = b.bio != null ? String(b.bio).trim().slice(0, 140) : me.bio;
    let avatar = me.avatar;
    if (b.avatar !== undefined) {
      const m = b.avatar && q('SELECT * FROM media WHERE id = ? AND owner = ?').get(String(b.avatar), me.id);
      if (b.avatar && (!m || !m.type.startsWith('image/'))) throw fail(400, 'Аватар не найден');
      avatar = b.avatar || null;
    }
    const stats = b.stats && typeof b.stats === 'object' ? JSON.stringify({
      streak: Math.max(0, Math.min(10000, +b.stats.streak || 0)), workouts30: Math.max(0, Math.min(100, +b.stats.workouts30 || 0)),
      goal: String(b.stats.goal || '').slice(0, 20) }) : me.stats;
    let username = me.username;
    if (b.username != null && String(b.username).trim().toLowerCase() !== me.username.toLowerCase()) {
      username = String(b.username).trim();
      if (!USERNAME.test(username)) throw fail(400, 'Логин: 3–20 символов, латиница, цифры, точка или _');
      if (q('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, me.id)) throw fail(409, 'Такой логин уже занят');
    }
    q('UPDATE users SET username = ?, name = ?, bio = ?, avatar = ?, stats = ? WHERE id = ?').run(username, name || me.name, bio, avatar, stats, me.id);
    return send(res, 200, { me: pub(q('SELECT * FROM users WHERE id = ?').get(me.id)) });
  }
  if (p === '/api/me/health-token' && M === 'POST') {
    const t = randomBytes(18).toString('base64url'); q('UPDATE users SET health_token = ? WHERE id = ?').run(t, me.id);
    return send(res, 200, { healthToken: t });
  }
  if (p === '/api/sync' && M === 'PUT') {
    rate('sync:' + me.id, 120, 600_000);
    const raw = (await readBody(req, 6_000_000)).toString('utf8');
    try { JSON.parse(raw); } catch { throw fail(400, 'Неверные данные'); }
    q('UPDATE users SET sync = ?, sync_at = ? WHERE id = ?').run(raw, now(), me.id);
    return send(res, 200, { ok: true, at: now() });
  }
  if (p === '/api/sync' && M === 'GET') {
    const r = q('SELECT sync, sync_at FROM users WHERE id = ?').get(me.id);
    return send(res, 200, { data: r.sync ? JSON.parse(r.sync) : null, at: r.sync_at });
  }
  if (p === '/api/health' && M === 'GET') {
    const rows = q('SELECT date, steps, active_kcal, updated FROM health WHERE user_id = ? AND date >= ? ORDER BY date').all(me.id, String(url.searchParams.get('from') || '2000-01-01'));
    return send(res, 200, { days: rows });
  }
  if (p === '/api/media' && M === 'POST') return upload(req, res, me);

  const um = /^\/api\/users\/(\d+)$/.exec(p);
  if (um && M === 'GET') {
    const u = q('SELECT * FROM users WHERE id = ?').get(Number(um[1])); if (!u) throw fail(404, 'Пользователь не найден');
    const visible = canSee(me.id, u.id);
    const posts = visible ? q('SELECT * FROM posts WHERE user_id = ? ORDER BY id DESC LIMIT 120').all(u.id).map(p => shapePost(p, me.id)) : [];
    const friendsCount = q(`SELECT COUNT(*) n FROM friends WHERE (a = ? OR b = ?) AND status = 'accepted'`).get(u.id, u.id).n;
    return send(res, 200, { user: { ...pub(u), state: u.id === me.id ? 'self' : friendState(me.id, u.id), flame: u.id === me.id ? null : flame(me.id, u.id),
      postsCount: q('SELECT COUNT(*) n FROM posts WHERE user_id = ?').get(u.id).n, friendsCount }, posts, visible });
  }
  if (p === '/api/posts' && M === 'POST') {
    rate('post:' + me.id, 30, 3_600_000);
    const b = await json(req, 16_000);
    const m = b.media && q('SELECT * FROM media WHERE id = ? AND owner = ?').get(String(b.media), me.id);
    if (!m || !m.type.startsWith('image/')) throw fail(400, 'Нужна фотография');
    const x = b.meta && typeof b.meta === 'object' ? b.meta : {};
    const meta = JSON.stringify({ title: String(x.title || '').slice(0, 80), kcal: num(x.kcal), p: num(x.p), f: num(x.f), c: num(x.c),
      items: (Array.isArray(x.items) ? x.items : []).slice(0, 12).map(i => ({ name: String(i.name || '').slice(0, 40), grams: num(i.grams) })) });
    const r = q('INSERT INTO posts (user_id, media, caption, meta, created) VALUES (?, ?, ?, ?, ?)').run(me.id, m.id, String(b.caption || '').slice(0, 500), meta, now());
    return send(res, 200, { post: shapePost(q('SELECT * FROM posts WHERE id = ?').get(r.lastInsertRowid), me.id) });
  }
  if (p === '/api/feed' && M === 'GET') {
    const before = Number(url.searchParams.get('before') || 9e15);
    const rows = q(`SELECT * FROM posts WHERE id < ? AND (user_id = ? OR user_id IN (
        SELECT CASE WHEN a = ? THEN b ELSE a END FROM friends WHERE (a = ? OR b = ?) AND status = 'accepted')) ORDER BY id DESC LIMIT 20`)
      .all(before, me.id, me.id, me.id, me.id);
    return send(res, 200, { posts: rows.map(p => shapePost(p, me.id)) });
  }
  const pm = /^\/api\/posts\/(\d+)(\/like|\/comments)?$/.exec(p);
  if (pm) {
    const post = visiblePost(Number(pm[1]), me.id);
    if (!pm[2] && M === 'GET') {
      const comments = q('SELECT * FROM comments WHERE post_id = ? ORDER BY id LIMIT 300').all(post.id).map(shapeComment);
      return send(res, 200, { post: shapePost(post, me.id), comments });
    }
    if (!pm[2] && M === 'DELETE') {
      if (post.user_id !== me.id) throw fail(403, 'Можно удалить только свою публикацию');
      q('DELETE FROM likes WHERE post_id = ?').run(post.id); q('DELETE FROM comments WHERE post_id = ?').run(post.id);
      q('DELETE FROM posts WHERE id = ?').run(post.id);
      return send(res, 200, { ok: true });
    }
    if (pm[2] === '/like') {
      rate('like:' + me.id, 300, 3_600_000);
      if (M === 'POST') q('INSERT OR IGNORE INTO likes (post_id, user_id, created) VALUES (?, ?, ?)').run(post.id, me.id, now());
      else if (M === 'DELETE') q('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(post.id, me.id);
      return send(res, 200, { likes: q('SELECT COUNT(*) n FROM likes WHERE post_id = ?').get(post.id).n, liked: M === 'POST' });
    }
    if (pm[2] === '/comments' && M === 'POST') {
      rate('comment:' + me.id, 120, 3_600_000);
      const body = String((await json(req, 8_000)).body || '').trim().slice(0, 500);
      if (!body) throw fail(400, 'Пустой комментарий');
      const r = q('INSERT INTO comments (post_id, user_id, body, created) VALUES (?, ?, ?, ?)').run(post.id, me.id, body, now());
      return send(res, 200, { comment: shapeComment(q('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid)) });
    }
  }
  const dc = /^\/api\/comments\/(\d+)$/.exec(p);
  if (dc && M === 'DELETE') {
    const c = q('SELECT c.*, p.user_id AS owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?').get(Number(dc[1]));
    if (!c || (c.user_id !== me.id && c.owner !== me.id)) throw fail(404, 'Комментарий не найден');
    q('DELETE FROM comments WHERE id = ?').run(c.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/users' && M === 'GET') {
    rate('search:' + me.id, 60, 60_000);
    const term = String(url.searchParams.get('q') || '').trim().replace(/[%_]/g, '').slice(0, 30);
    if (term.length < 2) return send(res, 200, { users: [] });
    const rows = q(`SELECT * FROM users WHERE id != ? AND (username LIKE ? OR name LIKE ?) ORDER BY username = ? DESC, username LIMIT 20`)
      .all(me.id, term + '%', '%' + term + '%', term);
    return send(res, 200, { users: rows.map(u => ({ ...pub(u), state: friendState(me.id, u.id) })) });
  }
  if (p === '/api/friends' && M === 'GET') {
    const rows = q(`SELECT u.*, f.status FROM friends f JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END WHERE f.a = ? OR f.b = ?`).all(me.id, me.id, me.id);
    const friends = [], incoming = [], sent = [];
    for (const r of rows) {
      if (r.status === 'accepted') friends.push(withFlame(me.id, r));
      else (Number(r.status.split(':')[1]) === me.id ? sent : incoming).push(pub(r));
    }
    return send(res, 200, { friends, incoming, sent });
  }
  const fm = /^\/api\/friends\/(\d+)$/.exec(p);
  if (fm) {
    const other = Number(fm[1]); if (other === me.id || !q('SELECT 1 FROM users WHERE id = ?').get(other)) throw fail(404, 'Пользователь не найден');
    const a = Math.min(me.id, other), b = Math.max(me.id, other), st = friendState(me.id, other);
    if (M === 'POST') {
      rate('friend:' + me.id, 60, 3_600_000);
      if (st === 'none') q('INSERT INTO friends (a, b, status, created) VALUES (?, ?, ?, ?)').run(a, b, `pending:${me.id}`, now());
      else if (st === 'incoming') q(`UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?`).run(a, b);
      return send(res, 200, { state: friendState(me.id, other) });
    }
    if (M === 'DELETE') { q('DELETE FROM friends WHERE a = ? AND b = ?').run(a, b); return send(res, 200, { state: 'none' }); }
  }
  const rm = /^\/api\/friends\/(\d+)\/restore$/.exec(p);
  if (rm && M === 'POST') {
    const other = Number(rm[1]);
    if (!areFriends(me.id, other)) throw fail(403, 'Только для друзей');
    const f = flame(me.id, other);
    if (f.state !== 'out') throw fail(400, 'Огонёк не погас');
    if (!f.canRestore) throw fail(409, 'Огонёк уже восстанавливали — второй раз нельзя');
    q('INSERT INTO flame_restores (a, b, day, created) VALUES (?, ?, ?, ?)').run(Math.min(me.id, other), Math.max(me.id, other), f.restoreDay, now());
    return send(res, 200, { flame: flame(me.id, other) });
  }

  if (p === '/api/chats' && M === 'GET') {
    const rows = q(`SELECT m.*, CASE WHEN m.sender = ? THEN m.recipient ELSE m.sender END AS peer FROM messages m
      JOIN (SELECT CASE WHEN sender = ? THEN recipient ELSE sender END AS peer, MAX(id) AS mid FROM messages WHERE sender = ? OR recipient = ? GROUP BY peer) t ON t.mid = m.id
      ORDER BY m.id DESC LIMIT 100`).all(me.id, me.id, me.id, me.id);
    const unread = Object.fromEntries(q('SELECT sender, COUNT(*) n FROM messages WHERE recipient = ? AND read_at IS NULL GROUP BY sender').all(me.id).map(r => [r.sender, r.n]));
    const chats = rows.map(m => ({ peer: withFlame(me.id, q('SELECT * FROM users WHERE id = ?').get(m.peer)), last: shapeMsg(m), unread: unread[m.peer] || 0 })).filter(c => c.peer);
    return send(res, 200, { chats, unreadTotal: Object.values(unread).reduce((a, b) => a + b, 0) });
  }
  const cm = /^\/api\/chats\/(\d+)$/.exec(p);
  if (cm) {
    const other = Number(cm[1]);
    if (M === 'GET') {
      const after = Number(url.searchParams.get('after') || 0);
      const rows = q(`SELECT * FROM messages WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) AND id > ? ORDER BY id DESC LIMIT 200`)
        .all(me.id, other, other, me.id, after).reverse();
      q('UPDATE messages SET read_at = ? WHERE sender = ? AND recipient = ? AND read_at IS NULL').run(now(), other, me.id);
      const peerRead = q('SELECT MAX(id) id FROM messages WHERE sender = ? AND recipient = ? AND read_at IS NOT NULL').get(me.id, other)?.id || 0;
      return send(res, 200, { messages: rows.map(shapeMsg), peer: withFlame(me.id, q('SELECT * FROM users WHERE id = ?').get(other)), peerRead, friends: areFriends(me.id, other) });
    }
    if (M === 'POST') {
      if (!areFriends(me.id, other)) throw fail(403, 'Писать можно только друзьям');
      rate('msg:' + me.id, 120, 60_000);
      const b = await json(req, 16_000);
      const kind = pick(b.kind, ['text', 'meal', 'voice', 'video', 'photo'], 'text');
      const body = String(b.body || '').slice(0, 2000);
      let media = null;
      if (['voice', 'video', 'photo', 'meal'].includes(kind) && b.media) {
        const m = q('SELECT * FROM media WHERE id = ? AND owner = ?').get(String(b.media), me.id);
        if (!m) throw fail(400, 'Файл не найден');
        media = m.id;
      }
      if (kind === 'text' && !body.trim()) throw fail(400, 'Пустое сообщение');
      if ((kind === 'voice' || kind === 'video') && !media) throw fail(400, 'Нет записи');
      let meta = null;
      if (b.meta && typeof b.meta === 'object') {
        const x = b.meta;
        meta = JSON.stringify({ title: String(x.title || '').slice(0, 80), kcal: num(x.kcal), p: num(x.p), f: num(x.f), c: num(x.c),
          items: (Array.isArray(x.items) ? x.items : []).slice(0, 12).map(i => ({ name: String(i.name || '').slice(0, 40), grams: num(i.grams) })),
          dur: Math.min(600, num(x.dur)) });
      }
      const r = q('INSERT INTO messages (sender, recipient, kind, body, media, meta, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(me.id, other, kind, body, media, meta, now());
      return send(res, 200, { message: shapeMsg(q('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid)) });
    }
  }
  const dm = /^\/api\/messages\/(\d+)$/.exec(p);
  if (dm && M === 'DELETE') {
    const m = q('SELECT * FROM messages WHERE id = ? AND sender = ?').get(Number(dm[1]), me.id);
    if (!m) throw fail(404, 'Сообщение не найдено');
    q('DELETE FROM messages WHERE id = ?').run(m.id);
    if (m.media && !q('SELECT 1 FROM messages WHERE media = ?').get(m.media) && !q('SELECT 1 FROM posts WHERE media = ?').get(m.media)) {
      q('DELETE FROM media WHERE id = ?').run(m.media); await unlink(join(MEDIA, m.media)).catch(() => {});
    }
    return send(res, 200, { ok: true });
  }
  throw fail(404, 'Не найдено');
}
function shapeMsg(m) {
  return { id: m.id, from: m.sender, to: m.recipient, kind: m.kind, body: m.body || '', media: m.media ? `/media/${m.media}` : '',
    meta: m.meta ? JSON.parse(m.meta) : null, created: m.created, read: Boolean(m.read_at) };
}

/* ---------------- static ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const st = await stat(file); if (!st.isFile()) throw 0;
    const ext = extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(await readFile(file));
  } catch {
    // SPA: неизвестные пути без расширения → index.html
    if (!extname(p)) { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' }); return res.end(await readFile(join(ROOT, 'index.html'))); }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено');
  }
}

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, key: Boolean(KEY) });
    if (url.pathname.startsWith('/api/')) {
      // CSRF: изменяющие запросы только со своего сайта (кроме вебхука «Здоровья»)
      if (req.method !== 'GET' && url.pathname !== '/api/health/ingest') {
        const origin = req.headers.origin; if (origin && new URL(origin).host !== req.headers.host) throw fail(403, 'Чужой источник');
      }
      return await api(req, res, url);
    }
    const mm = /^\/media\/([a-f0-9]{32}\.[a-z0-9]{2,4})$/.exec(url.pathname);
    if (mm) return await serveMedia(req, res, mm[1]);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    await serveStatic(req, res, url);
  } catch (e) {
    if (!e.public) console.error(e);
    if (!res.headersSent) send(res, e.code && e.public ? e.code : 500, { error: e.public ? e.message : 'Ошибка сервера' });
    else res.end();
  }
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`healthy on :${PORT}, key ${KEY ? 'set' : 'MISSING'}, data ${DATA}`));
