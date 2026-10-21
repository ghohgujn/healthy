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
import { loadVapid, sendPush } from './push.js';
import { createRequire } from 'node:module';
// те же формулы, что в приложении; в пакете "type": "module" файл грузится как ESM и кладёт HFCalc в globalThis
const calcMod = createRequire(import.meta.url)('../public/calc.js');
const HFCalc = calcMod?.dayBonus ? calcMod : globalThis.HFCalc;
if (!HFCalc?.dayBonus) throw new Error('calc.js не загрузился');

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
PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000; PRAGMA mmap_size = 134217728;
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
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, user_id INTEGER, created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new',
  reasons TEXT, comment TEXT, title TEXT, model TEXT, confidence TEXT, caption TEXT, ai TEXT, final TEXT, media TEXT, ua TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS push_user ON push_subs (user_id);
CREATE TABLE IF NOT EXISTS health (user_id INTEGER NOT NULL, date TEXT NOT NULL, steps INTEGER, active_kcal INTEGER, source TEXT, updated INTEGER NOT NULL,
  PRIMARY KEY (user_id, date));
`);
// подготовленные запросы кэшируем: компиляция SQL на каждый вызов — лишняя работа
const stmts = new Map();
const q = sql => { let st = stmts.get(sql); if (!st) { st = db.prepare(sql); stmts.set(sql, st); } return st; };
// миграции: добавляем колонки, если их ещё нет
for (const [t, c, def] of [['posts', 'vis', "TEXT NOT NULL DEFAULT 'friends'"], ['comments', 'parent_id', 'INTEGER'], ['comments', 'reply_to', 'INTEGER'], ['users', 'health_last', 'TEXT'], ['messages', 'reply_to', 'INTEGER'], ['users', 'share_summary', 'INTEGER NOT NULL DEFAULT 1']])
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
db.exec(`CREATE TABLE IF NOT EXISTS comment_likes (comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (comment_id, user_id));
CREATE INDEX IF NOT EXISTS posts_vis ON posts (vis, id);
CREATE INDEX IF NOT EXISTS friends_b ON friends (b, status);
CREATE INDEX IF NOT EXISTS friends_a ON friends (a, status);
CREATE INDEX IF NOT EXISTS posts_media ON posts (media);
CREATE INDEX IF NOT EXISTS msg_media ON messages (media);
CREATE INDEX IF NOT EXISTS msg_unread ON messages (recipient, read_at, sender);
CREATE INDEX IF NOT EXISTS users_avatar ON users (avatar);
CREATE INDEX IF NOT EXISTS comments_parent ON comments (parent_id);
CREATE INDEX IF NOT EXISTS reports_status ON reports (status, id);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);`);
db.exec('PRAGMA optimize');
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
const json = async (req, max = 64_000) => { try { return JSON.parse((await readBody(req, max)).toString('utf8') || '{}'); } catch (e) { if (e.code === 413) throw fail(413, 'Слишком большой запрос'); if (e.public) throw e; throw fail(400, 'Неверный запрос'); } };
const buckets = new Map();
function rate(key, max, windowMs) {
  const t = now(), a = (buckets.get(key) || []).filter(x => t - x < windowMs); a.push(t); buckets.set(key, a);
  if (a.length > max) throw fail(429, 'Слишком часто. Подождите немного.');
}
// За Caddy верим только последнему адресу в X-Forwarded-For (его дописывает сам Caddy); первый клиент может подделать.
const ipOf = req => {
  const remote = String(req.socket.remoteAddress || '');
  if (!/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(remote)) return remote;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return xff[xff.length - 1] || remote;
};
setInterval(() => { const t = now(); for (const [k, a] of buckets) if (!a.length || t - a[a.length - 1] > 3_600_000) buckets.delete(k); }, 600_000).unref();
// общий дневной потолок запросов к нейросети — защита баланса ProxyAPI
const AI_DAILY = Number(process.env.AI_DAILY_LIMIT || 1500);
let aiDay = '', aiCount = 0;
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

/* ---------------- заявки «посчитано неверно» ---------------- */
// администратор по умолчанию — @papa; в /etc/healthy.env можно добавить других через запятую
// пустое ADMIN_USERS= отключает админов
const ADMINS = new Set(String(process.env.ADMIN_USERS ?? 'papa').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const isAdmin = u => Boolean(u && ADMINS.has(String(u.username).toLowerCase()));
const REASONS = ['dish', 'weight', 'missing', 'extra', 'macros', 'other'];
const cleanItems = a => JSON.stringify((Array.isArray(a) ? a : []).slice(0, 20).map(i => ({ name: String(i?.name || '').slice(0, 60), grams: num(i?.grams),
  kcal_100: num(i?.kcal_100), p_100: num(i?.p_100), f_100: num(i?.f_100), c_100: num(i?.c_100), fat: String(i?.fat || '').slice(0, 10) })));
async function saveReport(req, res) {
  rate('report:' + ipOf(req), 20, 3_600_000);
  const u = userOf(req), b = await json(req, 6_000_000);
  const reasons = (Array.isArray(b.reasons) ? b.reasons : []).filter(r => REASONS.includes(r));
  const comment = String(b.comment || '').trim().slice(0, 600);
  if (!reasons.length && !comment) throw fail(400, 'Отметьте, что не так, или напишите пару слов');
  let media = null;
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(String(b.image || ''));
  if (m) {
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 100 && buf.length <= 3e6) {
      media = randomBytes(16).toString('hex') + (m[1] === 'png' ? '.png' : m[1] === 'webp' ? '.webp' : '.jpg');
      await writeFile(join(MEDIA, media), buf);
      q('INSERT INTO media (id, owner, type, size, created) VALUES (?, ?, ?, ?, ?)').run(media, u ? u.id : 0, 'image/' + m[1], buf.length, now());
    }
  }
  const r = q(`INSERT INTO reports (user_id, created, reasons, comment, title, model, confidence, caption, ai, final, media, ua)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(u ? u.id : null, now(), JSON.stringify(reasons), comment, String(b.title || '').slice(0, 120),
    String(b.model || '').slice(0, 60), String(b.confidence || '').slice(0, 10), String(b.caption || '').slice(0, 300),
    b.ai ? cleanItems(b.ai) : null, cleanItems(b.final), media, String(req.headers['user-agent'] || '').slice(0, 160));
  console.log(`report #${r.lastInsertRowid} ${reasons.join(',')} ${comment.slice(0, 60)}`);
  send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}

/* ---------------- пуш-уведомления ---------------- */
const VAPID = loadVapid(DATA);
const PUSH_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:healthyfit.app@gmail.com';
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const chatOpen = new Map();   // "кто:с кем" → когда последний раз опрашивал открытый чат
function notify(userId, data, skipIfChat) {
  if (skipIfChat && now() - (chatOpen.get(`${userId}:${skipIfChat}`) || 0) < 8000) return;   // чат открыт — пуш не нужен
  for (const sub of q('SELECT * FROM push_subs WHERE user_id = ?').all(userId)) {
    sendPush(VAPID, sub, data, PUSH_SUBJECT).then(code => {
      if (code === 404 || code === 410 || code === 403) q('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
    });
  }
}
const msgText = (kind, body, meta) => kind === 'text' ? body.slice(0, 120) : kind === 'post' ? `📌 Публикация: ${meta?.title || 'блюдо'}${body ? ` — ${body.slice(0, 80)}` : ''}` : kind === 'meal' ? `🍽 ${meta?.title || 'Блюдо'}${meta?.kcal ? ` · ${Math.round(meta.kcal)} ккал` : ''}`
  : kind === 'voice' ? '🎤 Голосовое сообщение' : kind === 'video' ? '📹 Видеосообщение' : '📷 Фото';

/* ---------------- сводка дня для друзей ----------------
   Берём облачную копию дневника (её присылает телефон) и считаем «сегодня» теми же формулами, что и приложение. */
const syncCache = new Map();   // user_id → { at, data }
function syncOf(u) {
  if (!u.sync) return null;
  const hit = syncCache.get(u.id); if (hit && hit.at === u.sync_at) return hit.data;
  let data = null; try { data = JSON.parse(u.sync); } catch {}
  if (syncCache.size > 2000) syncCache.clear();
  syncCache.set(u.id, { at: u.sync_at, data }); return data;
}
const FAT_SHARE = { none: 0, light: 0.03, heavy: 0.08, included: 0 };
function itemTotals(it) {
  const g = (+it.grams || 0) / 100, kcal100 = +it.kcal_100 > 0 ? +it.kcal_100 : 4 * (+it.p_100 || 0) + 4 * (+it.c_100 || 0) + 9 * (+it.f_100 || 0);
  const addFat = (+it.grams || 0) * (FAT_SHARE[it.fat] || 0);
  return { kcal: kcal100 * g + addFat * 9, p: (+it.p_100 || 0) * g, f: (+it.f_100 || 0) * g + addFat, c: (+it.c_100 || 0) * g };
}
function daySummary(u) {
  const db = syncOf(u); if (!db || !db.days) return null;
  const date = dayKey(now()), day = db.days[date] || {}, s = db.settings || {}, prof = db.profile || {};
  const t = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const m of day.meals || []) for (const it of m.items || []) { const x = itemTotals(it); t.kcal += x.kcal; t.p += x.p; t.f += x.f; t.c += x.c; }
  const h = (db.health || {})[date] || {};
  let bonus = 0; try { bonus = HFCalc.dayBonus({ ...prof, weight: +prof.weight || 75 }, day.acts || [], day.steps || h.steps || 0, h.active_kcal || 0).kcal; } catch {}
  const r = Math.round;
  return { date, kcal: r(t.kcal), p: r(t.p), f: r(t.f), c: r(t.c), goal: r((+s.goal || 2000) + bonus), pGoal: r(+s.p || 120), fGoal: r(+s.f || 65), cGoal: r((+s.c || 230) + bonus / 4),
    water: r(+day.water || 0), waterGoal: r(+s.waterGoal || 2000), meals: (day.meals || []).length, workouts: (day.acts || []).length, bonus: r(bonus), updated: u.sync_at || null };
}
// сводку видят только друзья и только если человек её не скрыл
const summaryFor = (me, u) => u.id !== me && u.share_summary !== 0 && areFriends(me, u.id) ? daySummary(u) : null;

/* ---------------- публикации ---------------- */
function shapePost(p, me) {
  const author = q('SELECT * FROM users WHERE id = ?').get(p.user_id);
  return { id: p.id, author: pub(author), media: p.media ? `/media/${p.media}` : '', caption: p.caption || '',
    meta: p.meta ? JSON.parse(p.meta) : null, created: p.created,
    likes: q('SELECT COUNT(*) n FROM likes WHERE post_id = ?').get(p.id).n,
    liked: Boolean(q('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(p.id, me)),
    comments: q('SELECT COUNT(*) n FROM comments WHERE post_id = ?').get(p.id).n, mine: p.user_id === me, vis: p.vis || 'friends' };
}
// открытые публикации видят все; закрытые — автор и его друзья
const canSeePost = (me, p) => p.vis === 'public' || canSee(me, p.user_id);
function visiblePost(id, me) {
  const p = q('SELECT * FROM posts WHERE id = ?').get(id);
  if (!p || !canSeePost(me, p)) throw fail(404, 'Публикация не найдена');
  return p;
}
const shapeComment = (c, me) => {
  const to = c.reply_to ? q('SELECT id, name, username FROM users WHERE id = ?').get(c.reply_to) : null;
  return { id: c.id, body: c.body, created: c.created, parent: c.parent_id || null, replyTo: to ? { id: to.id, name: to.name, username: to.username } : null,
    author: pub(q('SELECT * FROM users WHERE id = ?').get(c.user_id)),
    likes: q('SELECT COUNT(*) n FROM comment_likes WHERE comment_id = ?').get(c.id).n,
    liked: Boolean(me && q('SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?').get(c.id, me)) };
};
const USERNAME = /^[a-z0-9_.]{3,20}$/i;

/* ---------------- огонёк дружбы ---------------- */
// День засчитывается, если оба написали друг другу хотя бы по одному сообщению.
// 3+ дня подряд — огонёк горит. Пропущен один день — гаснет; восстановить можно один раз на пару.
const TZ = process.env.APP_TZ || 'Europe/Moscow';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = t => dayFmt.format(new Date(t));
const prevDay = k => { const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
// огонёк считаем по истории переписки — результат кэшируем на 30 с и сбрасываем при новом сообщении
const flameCache = new Map();
const dropFlame = (a, b) => { flameCache.delete(`${a}:${b}`); flameCache.delete(`${b}:${a}`); };
function flame(me, other) {
  const key = `${me}:${other}`, hit = flameCache.get(key);
  if (hit && now() - hit.at < 30_000) return hit.v;
  const v = flameCalc(me, other);
  if (flameCache.size > 20000) flameCache.clear();
  flameCache.set(key, { at: now(), v });
  return v;
}
function flameCalc(me, other) {
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
// Скорость: модель «рассуждает» перед ответом — для оценки еды по фото хватает низкого уровня.
// Если ProxyAPI/модель не примет параметр, один раз откатываемся без него и запоминаем (без серии 4xx).
let REASONING = (process.env.AI_REASONING || 'low').toLowerCase();   // low | medium | high | off
const AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 2500);
const AI_BASE = (process.env.AI_BASE_URL || 'https://api.proxyapi.ru/v1').replace(/\/$/, '');
const aiStats = [];   // последние 200 распознаваний: время, размер фото, токены — для админа
function aiBody(model, caption, image, withReasoning) {
  const b = { model: model.id, max_completion_tokens: AI_MAX_TOKENS, messages: [{ role: 'user', content: [
    { type: 'text', text: PROMPT.replace('{caption}', caption) }, { type: 'image_url', image_url: /^openai\//.test(model.id) ? { url: image, detail: 'auto' } : { url: image } }] }] };
  if (withReasoning && REASONING !== 'off' && /^openai\//.test(model.id)) b.reasoning_effort = REASONING;
  return JSON.stringify(b);
}
async function callAI(body, signal) {
  return fetch(`${AI_BASE}/chat/completions`, { method: 'POST', signal, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body });
}
async function analyze(req, res) {
  if (!KEY) throw fail(500, 'Сервер не настроен: нет ключа нейросети');
  rate('ai:' + ipOf(req), LIMIT, 600_000);
  const me = userOf(req); if (me) rate('aiu:' + me.id, LIMIT, 600_000);
  const d = new Date().toISOString().slice(0, 10); if (d !== aiDay) { aiDay = d; aiCount = 0; }
  if (++aiCount > AI_DAILY) { console.error('AI daily limit reached'); throw fail(503, 'Сегодня лимит распознаваний исчерпан. Попробуйте завтра.'); }
  const tIn = now();
  const failStat = (why, ms) => { aiStats.push({ at: now(), model: String(body?.model || ''), ms, ok: false, why, kb: 0, upload_ms: 0, prompt: 0, out: 0, reasoning: 0, effort: REASONING }); if (aiStats.length > 200) aiStats.shift(); };
  let body;
  body = await json(req, 4_000_000);
  const image = String(body.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 3_000_000) throw fail(400, 'Нужна фотография JPEG/PNG до ~2 МБ');
  const model = MODELS[body.model] || MODELS.fast;
  const caption = String(body.caption || '').replace(/[<>]/g, '').slice(0, 300);
  const t0 = now(), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 50_000);
  let r, usedReasoning = REASONING !== 'off' && /^openai\//.test(model.id);   // параметр уходит только моделям OpenAI
  try {
    r = await callAI(aiBody(model, caption, image, true), ctrl.signal);
    if (r.status === 400 && usedReasoning) {
      const txt = await r.text();
      if (/reasoning/i.test(txt)) { console.error('reasoning_effort не поддерживается — выключаю'); REASONING = 'off'; usedReasoning = false; r = await callAI(aiBody(model, caption, image, false), ctrl.signal); }
      else { console.error('proxyapi 400', txt.slice(0, 300)); throw fail(502, 'Не получилось распознать. Попробуйте ещё раз.'); }
    }
  } catch (e) { failStat(e.public ? 'http 400' : 'timeout', now() - t0); if (e.public) throw e; throw fail(504, 'Нейросеть не ответила. Попробуйте ещё раз.'); } finally { clearTimeout(timer); }
  if (!r.ok) failStat('http ' + r.status, now() - t0);
  // 4xx не повторяем: ProxyAPI ставит ключ на паузу после 20 ошибок в минуту
  if (r.status === 402) { console.error('proxyapi 402: пополните баланс'); throw fail(503, 'Сервис временно недоступен. Попробуйте позже.'); }
  if (r.status === 429) throw fail(429, 'Очередь занята. Попробуйте через минуту.');
  if (!r.ok) { console.error('proxyapi', r.status, (await r.text()).slice(0, 300)); throw fail(502, 'Не получилось распознать. Попробуйте ещё раз.'); }
  const data = await r.json().catch(() => null);
  const m = String(data?.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
  let parsed = null; try { parsed = m ? JSON.parse(m[0]) : null; } catch {}
  const u = data?.usage || {}, stat = { at: now(), model: model.id, ms: now() - t0, upload_ms: t0 - tIn, kb: Math.round(image.length * 0.75 / 1024),
    prompt: u.prompt_tokens || 0, out: u.completion_tokens || 0, reasoning: u.completion_tokens_details?.reasoning_tokens || 0, effort: usedReasoning ? REASONING : 'off', ok: Boolean(parsed) };
  aiStats.push(stat); if (aiStats.length > 200) aiStats.shift();
  console.log(`analyze ${model.id} ${stat.ms}ms upload=${stat.upload_ms}ms ${stat.kb}KB tokens in=${stat.prompt} out=${stat.out} reasoning=${stat.reasoning} effort=${stat.effort}`);
  if (!parsed) throw fail(502, 'Нейросеть ответила непонятно. Попробуйте ещё раз.');
  send(res, 200, { ...clean(parsed), model: model.label, ms: stat.ms });
}

/* ---------------- media ---------------- */
const MEDIA_TYPES = {
  'image/jpeg': { ext: '.jpg', max: 3e6 }, 'image/webp': { ext: '.webp', max: 3e6 }, 'image/png': { ext: '.png', max: 3e6 },
  'audio/webm': { ext: '.webm', max: 3e6 }, 'audio/mp4': { ext: '.m4a', max: 3e6 }, 'audio/ogg': { ext: '.ogg', max: 3e6 }, 'audio/aac': { ext: '.aac', max: 3e6 },
  'video/webm': { ext: '.webm', max: 25e6 }, 'video/mp4': { ext: '.mp4', max: 25e6 },
};
async function upload(req, res, me) {
  rate('up:' + me.id, 60, 600_000);
  let type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), buf;
  if (type === 'application/json') {
    // картинки с телефона приходят data:URL в JSON — так надёжнее в Safari, чем Blob в теле запроса
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/s.exec(String((await json(req, 6_000_000)).data || ''));
    if (!m) throw fail(400, 'Нужен файл');
    type = m[1].toLowerCase(); buf = Buffer.from(m[2], 'base64');
    if (!MEDIA_TYPES[type]) throw fail(415, 'Неподдерживаемый формат');
    if (buf.length > MEDIA_TYPES[type].max) throw fail(413, 'Слишком большой файл');
  }
  const spec = MEDIA_TYPES[type]; if (!spec) throw fail(415, 'Неподдерживаемый формат');
  if (!buf) buf = await readBody(req, spec.max);
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
  const allowed = isAvatar || isAdmin(me) || (me && (m.owner === me.id ||
    q('SELECT 1 FROM messages WHERE media = ? AND (sender = ? OR recipient = ?)').get(id, me.id, me.id) ||
    q('SELECT user_id, vis FROM posts WHERE media = ?').all(id).some(p => canSeePost(me.id, p))));
  if (!allowed) { res.writeHead(403); return res.end(); }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  // имена файлов случайные и никогда не меняются — браузер может хранить их «навсегда»
  const headers = { 'Content-Type': m.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable' };
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
    // «Команды» на русском могут прислать «8 421» или «412,5 ккал» — убираем пробелы и единицы
    const n = typeof o === 'string' ? parseFloat(o.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.').replace(/[^\d.\-].*$/, '')) : o;
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
  const raw = (await readBody(req, 2_000_000)).toString('utf8');
  // последнюю отправку храним для диагностики: пользователь видит в приложении, что именно прислала команда
  const remember = (ok, parsed) => q('UPDATE users SET health_last = ? WHERE id = ?').run(JSON.stringify({ at: now(), ok, raw: raw.slice(0, 400), parsed, type: String(req.headers['content-type'] || '').slice(0, 60) }), u.id);
  let body; try { body = JSON.parse(raw); } catch { remember(false, null); throw fail(400, 'Нужен JSON'); }
  const today = String(url.searchParams.get('date') || body.date || dayKey(now())).slice(0, 10);   // «сегодня» по часовому поясу сервиса (APP_TZ), а не по Гринвичу
  const days = harvest(body, today);
  remember(days.size > 0, Object.fromEntries(days));
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
    const nu = q('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    return send(res, 200, { me: { ...pub(nu), admin: isAdmin(nu) } });
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
    return send(res, 200, { me: { ...pub(u), admin: isAdmin(u) } });
  }
  if (p === '/api/me' && M === 'GET' && !userOf(req)) return send(res, 200, { me: null });
  if (p === '/api/auth/logout' && M === 'POST') {
    const t = cookieToken(req); if (t) q('DELETE FROM sessions WHERE token = ?').run(sha(t));
    return send(res, 200, { ok: true }, { 'Set-Cookie': `hf=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? '; Secure' : ''}` });
  }

  if (p === '/api/clientlog' && M === 'POST') {
    rate('clog:' + ipOf(req), 30, 600_000);
    const b = await json(req, 8_000), u = userOf(req);
    console.error('client', u ? '@' + u.username : 'anon', String(b.where || '').slice(0, 40), String(b.error || '').slice(0, 300), String(req.headers['user-agent'] || '').slice(0, 120));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/reports' && M === 'POST') return saveReport(req, res);
  if (p === '/api/push/key' && M === 'GET') return send(res, 200, { key: VAPID.publicKey });
  const me = need(req);
  if (p === '/api/push/subscribe' && M === 'POST') {
    const b = await json(req, 8_000), ep = String(b.endpoint || ''), k = b.keys || {};
    let host = ''; try { const u = new URL(ep); if (u.protocol === 'https:') host = u.hostname; } catch {}
    if (!PUSH_HOSTS.test(host) || !k.p256dh || !k.auth) throw fail(400, 'Неверная подписка');
    q(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).run(ep, me.id, String(k.p256dh), String(k.auth), now());
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && M === 'POST') {
    const b = await json(req, 8_000); q('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(b.endpoint || ''), me.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && M === 'POST') {
    rate('ptest:' + me.id, 10, 600_000);
    const n = q('SELECT COUNT(*) n FROM push_subs WHERE user_id = ?').get(me.id).n;
    notify(me.id, { title: 'Healthy Fit', body: 'Уведомления работают 👍', url: '/', tag: 'test' });
    return send(res, 200, { devices: n });
  }
  if (p === '/api/me' && M === 'GET') return send(res, 200, { me: { ...pub(me), healthToken: me.health_token, admin: isAdmin(me), shareSummary: me.share_summary !== 0 } });
  if (p === '/api/admin/reports' && M === 'GET') {
    if (!isAdmin(me)) throw fail(403, 'Только для администратора');
    const st = url.searchParams.get('status') || 'new';
    const rows = q(`SELECT r.*, u.username FROM reports r LEFT JOIN users u ON u.id = r.user_id WHERE ? = 'all' OR r.status = ? ORDER BY r.id DESC LIMIT 200`).all(st, st);
    const counts = Object.fromEntries(q('SELECT status, COUNT(*) n FROM reports GROUP BY status').all().map(x => [x.status, x.n]));
    return send(res, 200, { counts, reports: rows.map(r => ({ id: r.id, created: r.created, status: r.status, username: r.username || null,
      reasons: JSON.parse(r.reasons || '[]'), comment: r.comment, title: r.title, model: r.model, confidence: r.confidence, caption: r.caption,
      ai: r.ai ? JSON.parse(r.ai) : null, final: JSON.parse(r.final || '[]'), media: r.media ? `/media/${r.media}` : '', note: r.note || '' })) });
  }
  if (p === '/api/admin/stats' && M === 'GET') {
    if (!isAdmin(me)) throw fail(403, 'Только для администратора');
    const okRuns = aiStats.filter(x => x.ok), last = okRuns.slice(-50), ms = last.map(x => x.ms).sort((a, b) => a - b);
    const pct = k => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * k))] : 0, p50 = pct(0.5), p95 = pct(0.95);
    const avg = k => last.length ? Math.round(last.reduce((a, x) => a + x[k], 0) / last.length) : 0;
    return send(res, 200, { runs: aiStats.length, fails: aiStats.length - okRuns.length, p50, p95, upload: avg('upload_ms'), kb: avg('kb'), reasoning: avg('reasoning'), out: avg('out'),
      effort: REASONING, maxTokens: AI_MAX_TOKENS, users: q('SELECT COUNT(*) n FROM users').get().n, today: aiCount, last: aiStats.slice(-10).reverse() });
  }
  const ar = /^\/api\/admin\/reports\/(\d+)$/.exec(p);
  if (ar && M === 'PATCH') {
    if (!isAdmin(me)) throw fail(403, 'Только для администратора');
    const b = await json(req, 8_000);
    q('UPDATE reports SET status = COALESCE(?, status), note = COALESCE(?, note) WHERE id = ?').run(
      ['new', 'done', 'skip'].includes(b.status) ? b.status : null, b.note != null ? String(b.note).slice(0, 600) : null, Number(ar[1]));
    return send(res, 200, { ok: true });
  }
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
    if (b.shareSummary !== undefined) q('UPDATE users SET share_summary = ? WHERE id = ?').run(b.shareSummary ? 1 : 0, me.id);
    return send(res, 200, { me: pub(q('SELECT * FROM users WHERE id = ?').get(me.id)) });
  }
  if (p === '/api/me/health-token' && M === 'POST') {
    const t = randomBytes(18).toString('base64url'); q('UPDATE users SET health_token = ? WHERE id = ?').run(t, me.id);
    return send(res, 200, { healthToken: t });
  }
  if (p === '/api/sync' && M === 'PUT') {
    rate('sync:' + me.id, 120, 600_000);
    const raw = (await readBody(req, 8_000_000)).toString('utf8');
    let parsed; try { parsed = JSON.parse(raw); } catch { throw fail(400, 'Неверные данные'); }
    if (!parsed || typeof parsed !== 'object' || !parsed.days) throw fail(400, 'Неверные данные');
    q('UPDATE users SET sync = ?, sync_at = ? WHERE id = ?').run(raw, now(), me.id);
    return send(res, 200, { ok: true, at: now() });
  }
  if (p === '/api/sync' && M === 'GET') {
    const r = q('SELECT sync, sync_at FROM users WHERE id = ?').get(me.id);
    return send(res, 200, { data: r.sync ? JSON.parse(r.sync) : null, at: r.sync_at });
  }
  if (p === '/api/health' && M === 'GET') {
    const rows = q('SELECT date, steps, active_kcal, updated FROM health WHERE user_id = ? AND date >= ? ORDER BY date').all(me.id, String(url.searchParams.get('from') || '2000-01-01'));
    const last = q('SELECT health_last FROM users WHERE id = ?').get(me.id)?.health_last;
    return send(res, 200, { days: rows, last: last ? JSON.parse(last) : null, today: dayKey(now()) });
  }
  if (p === '/api/media' && M === 'POST') return upload(req, res, me);

  const um = /^\/api\/users\/(\d+)$/.exec(p);
  if (um && M === 'GET') {
    const u = q('SELECT * FROM users WHERE id = ?').get(Number(um[1])); if (!u) throw fail(404, 'Пользователь не найден');
    const visible = canSee(me.id, u.id);
    const posts = q(`SELECT * FROM posts WHERE user_id = ? ${visible ? '' : "AND vis = 'public'"} ORDER BY id DESC LIMIT 120`).all(u.id).map(p => shapePost(p, me.id));
    const friendsCount = q(`SELECT COUNT(*) n FROM friends WHERE (a = ? OR b = ?) AND status = 'accepted'`).get(u.id, u.id).n;
    return send(res, 200, { user: { ...pub(u), state: u.id === me.id ? 'self' : friendState(me.id, u.id), flame: u.id === me.id ? null : flame(me.id, u.id), summary: summaryFor(me.id, u),
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
    const r = q('INSERT INTO posts (user_id, media, caption, meta, created, vis) VALUES (?, ?, ?, ?, ?, ?)').run(me.id, m.id, String(b.caption || '').slice(0, 500), meta, now(), b.vis === 'friends' ? 'friends' : 'public');
    return send(res, 200, { post: shapePost(q('SELECT * FROM posts WHERE id = ?').get(r.lastInsertRowid), me.id) });
  }
  if (p === '/api/feed' && M === 'GET') {
    const before = Number(url.searchParams.get('before') || 9e15);
    // «Для вас» (scope=all): пока по свежести — все открытые посты + свои + друзей; «Друзья»: только друзья и свои
    const all = url.searchParams.get('scope') === 'all';
    const rows = q(`SELECT * FROM posts WHERE id < ? AND (${all ? "vis = 'public' OR " : ''}user_id = ? OR user_id IN (
        SELECT CASE WHEN a = ? THEN b ELSE a END FROM friends WHERE (a = ? OR b = ?) AND status = 'accepted')) ORDER BY id DESC LIMIT 20`)
      .all(before, me.id, me.id, me.id, me.id);
    return send(res, 200, { posts: rows.map(p => shapePost(p, me.id)) });
  }
  const pm = /^\/api\/posts\/(\d+)(\/like|\/comments)?$/.exec(p);
  if (pm) {
    const post = visiblePost(Number(pm[1]), me.id);
    if (!pm[2] && M === 'GET') {
      const comments = q('SELECT * FROM comments WHERE post_id = ? ORDER BY id LIMIT 500').all(post.id).map(c => shapeComment(c, me.id));
      return send(res, 200, { post: shapePost(post, me.id), comments });
    }
    if (!pm[2] && M === 'DELETE') {
      if (post.user_id !== me.id) throw fail(403, 'Можно удалить только свою публикацию');
      q('DELETE FROM likes WHERE post_id = ?').run(post.id);
      q('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE post_id = ?)').run(post.id);
      q('DELETE FROM comments WHERE post_id = ?').run(post.id);
      q('DELETE FROM posts WHERE id = ?').run(post.id);
      if (post.media && !q('SELECT 1 FROM messages WHERE media = ?').get(post.media) && !q('SELECT 1 FROM posts WHERE media = ?').get(post.media) && !q('SELECT 1 FROM users WHERE avatar = ?').get(post.media)) {
        q('DELETE FROM media WHERE id = ?').run(post.media); await unlink(join(MEDIA, post.media)).catch(() => {});
      }
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
      const b = await json(req, 8_000);
      const body = String(b.body || '').trim().slice(0, 500);
      if (!body) throw fail(400, 'Пустой комментарий');
      // ответ: храним корневой комментарий (одна ветка, как в TikTok) и кому отвечаем
      let parent = null, replyTo = null;
      if (b.parent) {
        const pc = q('SELECT * FROM comments WHERE id = ? AND post_id = ?').get(Number(b.parent), post.id);
        if (!pc) throw fail(404, 'Комментарий не найден');
        parent = pc.parent_id || pc.id; replyTo = pc.user_id;
      }
      const r = q('INSERT INTO comments (post_id, user_id, body, created, parent_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)').run(post.id, me.id, body, now(), parent, replyTo);
      if (replyTo && replyTo !== me.id) notify(replyTo, { title: `${me.name} ответил(а) вам`, body: body.slice(0, 120), url: `/?post=${post.id}`, tag: `post-${post.id}` });
      if (post.user_id !== me.id && post.user_id !== replyTo) notify(post.user_id, { title: `${me.name} прокомментировал(а)`, body: body.slice(0, 120), url: `/?post=${post.id}`, tag: `post-${post.id}` });
      return send(res, 200, { comment: shapeComment(q('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid), me.id) });
    }
  }
  const cl = /^\/api\/comments\/(\d+)\/like$/.exec(p);
  if (cl) {
    rate('clike:' + me.id, 300, 3_600_000);
    const c = q('SELECT * FROM comments WHERE id = ?').get(Number(cl[1])); if (!c) throw fail(404, 'Комментарий не найден');
    visiblePost(c.post_id, me.id);
    if (M === 'POST') q('INSERT OR IGNORE INTO comment_likes (comment_id, user_id, created) VALUES (?, ?, ?)').run(c.id, me.id, now());
    else if (M === 'DELETE') q('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?').run(c.id, me.id);
    return send(res, 200, { likes: q('SELECT COUNT(*) n FROM comment_likes WHERE comment_id = ?').get(c.id).n, liked: M === 'POST' });
  }
  const dc = /^\/api\/comments\/(\d+)$/.exec(p);
  if (dc && M === 'DELETE') {
    const c = q('SELECT c.*, p.user_id AS owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?').get(Number(dc[1]));
    if (!c || (c.user_id !== me.id && c.owner !== me.id)) throw fail(404, 'Комментарий не найден');
    // удаляем комментарий вместе с ответами на него и лайками
    const ids = [c.id, ...q('SELECT id FROM comments WHERE parent_id = ?').all(c.id).map(x => x.id)];
    for (const id of ids) { q('DELETE FROM comment_likes WHERE comment_id = ?').run(id); q('DELETE FROM comments WHERE id = ?').run(id); }
    return send(res, 200, { ok: true, removed: ids });
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
      if (r.status === 'accepted') { const sm = summaryFor(me.id, r); friends.push({ ...withFlame(me.id, r), today: sm ? { kcal: sm.kcal, goal: sm.goal, meals: sm.meals } : null }); }
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
      if (st === 'none') {
        q('INSERT INTO friends (a, b, status, created) VALUES (?, ?, ?, ?)').run(a, b, `pending:${me.id}`, now());
        notify(other, { title: 'Заявка в друзья', body: `${me.name} (@${me.username}) хочет добавить вас в друзья`, url: '/?tab=chats', tag: `friend-${me.id}` });
      } else if (st === 'incoming') {
        q(`UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?`).run(a, b);
        notify(other, { title: 'Новый друг', body: `${me.name} принял(а) вашу заявку`, url: `/?user=${me.id}`, tag: `friend-${me.id}` });
      }
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
    dropFlame(me.id, other);
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
      chatOpen.set(`${me.id}:${other}`, now());
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
      const kind = pick(b.kind, ['text', 'meal', 'voice', 'video', 'photo', 'post'], 'text');
      const body = String(b.body || '').slice(0, 2000);
      let media = null;
      if (['voice', 'video', 'photo', 'meal'].includes(kind) && b.media) {
        const m = q('SELECT * FROM media WHERE id = ? AND owner = ?').get(String(b.media), me.id);
        if (!m) throw fail(400, 'Файл не найден');
        media = m.id;
      }
      if (kind === 'text' && !body.trim()) throw fail(400, 'Пустое сообщение');
      // пересылка публикации из ленты: другу должна быть видна сама публикация
      let postRef = null;
      if (kind === 'post') {
        postRef = visiblePost(Number(b.post), me.id);
        if (!canSeePost(other, postRef)) throw fail(403, 'Эту публикацию видят только друзья автора');
        media = postRef.media;
      }
      if ((kind === 'voice' || kind === 'video') && !media) throw fail(400, 'Нет записи');
      let meta = null;
      if (postRef) {
        const pm2 = JSON.parse(postRef.meta || '{}'), au = q('SELECT name, username FROM users WHERE id = ?').get(postRef.user_id);
        meta = JSON.stringify({ title: pm2.title || '', kcal: num(pm2.kcal), p: num(pm2.p), f: num(pm2.f), c: num(pm2.c), postId: postRef.id, author: au ? { name: au.name, username: au.username } : null });
      } else if (b.meta && typeof b.meta === 'object') {
        const x = b.meta;
        meta = JSON.stringify({ title: String(x.title || '').slice(0, 80), kcal: num(x.kcal), p: num(x.p), f: num(x.f), c: num(x.c),
          items: (Array.isArray(x.items) ? x.items : []).slice(0, 12).map(i => ({ name: String(i.name || '').slice(0, 40), grams: num(i.grams) })),
          dur: Math.min(600, num(x.dur)) });
      }
      // ответ на сообщение — только из этой же переписки
      let replyTo = null;
      if (b.reply) { const rm = q('SELECT id FROM messages WHERE id = ? AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))').get(Number(b.reply), me.id, other, other, me.id); replyTo = rm ? rm.id : null; }
      const r = q('INSERT INTO messages (sender, recipient, kind, body, media, meta, created, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(me.id, other, kind, body, media, meta, now(), replyTo);
      dropFlame(me.id, other);
      notify(other, { title: me.name, body: msgText(kind, body, meta && JSON.parse(meta)), url: `/?chat=${me.id}`, tag: `chat-${me.id}` }, me.id);
      return send(res, 200, { message: shapeMsg(q('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid)) });
    }
  }
  const dm = /^\/api\/messages\/(\d+)$/.exec(p);
  if (dm && M === 'DELETE') {
    const m = q('SELECT * FROM messages WHERE id = ? AND sender = ?').get(Number(dm[1]), me.id);
    if (!m) throw fail(404, 'Сообщение не найдено');
    q('DELETE FROM messages WHERE id = ?').run(m.id); dropFlame(m.sender, m.recipient);
    if (m.media && !q('SELECT 1 FROM messages WHERE media = ?').get(m.media) && !q('SELECT 1 FROM posts WHERE media = ?').get(m.media)) {
      q('DELETE FROM media WHERE id = ?').run(m.media); await unlink(join(MEDIA, m.media)).catch(() => {});
    }
    return send(res, 200, { ok: true });
  }
  throw fail(404, 'Не найдено');
}
function shapeMsg(m) {
  let reply = null;
  if (m.reply_to) {
    const o = q('SELECT id, sender, kind, body, meta FROM messages WHERE id = ?').get(m.reply_to);
    reply = o ? { id: o.id, from: o.sender, kind: o.kind, text: msgText(o.kind, o.body || '', o.meta ? JSON.parse(o.meta) : null).slice(0, 90) } : { id: m.reply_to, deleted: true };
  }
  return { id: m.id, from: m.sender, to: m.recipient, kind: m.kind, body: m.body || '', media: m.media ? `/media/${m.media}` : '',
    meta: m.meta ? JSON.parse(m.meta) : null, created: m.created, read: Boolean(m.read_at), reply };
}

/* ---------------- static ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2' };
// Статика: держим в памяти, отдаём с ETag — повторный заход получает 304 без тела
const staticCache = new Map();
async function staticFile(file) {
  const st = await stat(file); if (!st.isFile()) throw 0;
  const hit = staticCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const buf = await readFile(file), etag = '"' + createHash('sha1').update(buf).digest('base64url').slice(0, 20) + '"';
  const v = { buf, etag, mtime: st.mtimeMs }; staticCache.set(file, v); return v;
}
async function serveStatic(req, res, url) {
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  let file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  let f;
  try { f = await staticFile(file); }
  catch {
    // SPA: неизвестные пути без расширения → index.html
    if (extname(p)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    file = join(ROOT, 'index.html'); f = await staticFile(file);
  }
  const ext = extname(file);
  // шрифты и иконки не меняются — кэш на год; код и страница — всегда сверяем по ETag (обновления приходят сразу)
  const cache = /\.woff2$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';   // иконки могут смениться под тем же именем — сверяем по ETag
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, ETag: f.etag };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'Content-Length': f.buf.length });
  res.end(req.method === 'HEAD' ? undefined : f.buf);
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
