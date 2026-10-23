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
for (const [t, c, def] of [['posts', 'vis', "TEXT NOT NULL DEFAULT 'friends'"], ['comments', 'parent_id', 'INTEGER'], ['comments', 'reply_to', 'INTEGER'], ['users', 'health_last', 'TEXT'], ['messages', 'reply_to', 'INTEGER'], ['users', 'share_summary', 'INTEGER NOT NULL DEFAULT 1'], ['posts', 'gallery', 'TEXT'], ['comments', 'kind', "TEXT NOT NULL DEFAULT 'text'"], ['users', 'seen_at', 'INTEGER'], ['push_subs', 'sess', 'TEXT'], ['comments', 'media', 'TEXT'], ['comments', 'meta', 'TEXT'], ['users', 'invite', 'TEXT'], ['users', 'og', 'TEXT'], ['users', 'ref_by', 'INTEGER'], ['posts', 'og', 'TEXT']])
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
db.exec(`CREATE TABLE IF NOT EXISTS coaches (client_id INTEGER NOT NULL, coach_id INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (client_id, coach_id));
CREATE INDEX IF NOT EXISTS coaches_coach ON coaches (coach_id);`);
// приглашения: у каждого своя ссылка /i/<код>; открывший её сразу становится другом пригласившего
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_invite ON users (invite);
CREATE INDEX IF NOT EXISTS users_og ON users (og);
CREATE INDEX IF NOT EXISTS users_ref ON users (ref_by);
CREATE INDEX IF NOT EXISTS posts_og ON posts (og);`);
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
  const u = q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(sha(t)) || null;
  if (u && now() - (u.seen_at || 0) > 300_000) { try { q('UPDATE users SET seen_at = ? WHERE id = ?').run(now(), u.id); } catch {} }   // «был в сети» — не чаще раза в 5 минут
  return u;
}
function need(req) { const u = userOf(req); if (!u) throw fail(401, 'Войдите в аккаунт'); return u; }
function startSession(res, userId) {
  const t = randomBytes(32).toString('base64url');
  q('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(sha(t), userId, now());
  res.setHeader('Set-Cookie', `hf=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${SECURE ? '; Secure' : ''}`);
}
const withFlame = (me, u) => u && ({ ...pub(u), flame: flame(me, u.id) });
const BOT_USERNAME = 'hf_coach';   // «Помощник по питанию»: пишет каждому раз в день, сам сообщения не принимает
const pub = u => u && { id: u.id, username: u.username, name: u.name, avatar: u.avatar ? `/media/${u.avatar}` : '', bio: u.bio || '', stats: JSON.parse(u.stats || '{}'), ...(u.username === BOT_USERNAME ? { bot: true } : {}) };
const friendState = (me, other) => {
  const f = q('SELECT * FROM friends WHERE a = ? AND b = ?').get(Math.min(me, other), Math.max(me, other));
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  const [from] = f.status.split(':').slice(1).map(Number);
  return from === me ? 'sent' : 'incoming';
};
const areFriends = (a, b) => friendState(a, b) === 'friends';
const canSee = (me, author) => me === author || areFriends(me, author);
// тренер: человек сам назначает друга тренером — тот видит его дневник целиком (еда с фото, вода, активность, вес, прогресс)
const isCoachOf = (coach, client) => Boolean(q('SELECT 1 FROM coaches WHERE coach_id = ? AND client_id = ?').get(coach, client));

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
// Открытый чат: «пользователь:собеседник:сессия» → когда последний раз опрашивал. Сессия = устройство,
// поэтому чат, открытый на компьютере, больше не глушит пуш на телефоне.
const chatOpen = new Map();
setInterval(() => { const t = now(); for (const [k, v] of chatOpen) if (t - v > 60_000) chatOpen.delete(k); }, 60_000).unref();
const sessOf = req => { const t = cookieToken(req); return t ? sha(t) : ''; };
function notify(userId, data, skipIfChat) {
  const t = now(), openOn = sess => t - (chatOpen.get(`${userId}:${skipIfChat}:${sess}`) || 0) < 6000;
  const anyOpen = () => [...chatOpen].some(([k, v]) => k.startsWith(`${userId}:${skipIfChat}:`) && t - v < 6000);
  for (const sub of q('SELECT * FROM push_subs WHERE user_id = ?').all(userId)) {
    // этот же телефон прямо сейчас смотрит переписку — ему пуш не нужен; старые подписки без сессии — как раньше
    if (skipIfChat && (sub.sess ? openOn(sub.sess) : anyOpen())) continue;
    sendPush(VAPID, sub, data, PUSH_SUBJECT).then(code => {
      // удаляем только по «подписки больше нет» (404/410); 403 и прочее бывает временно — подписку не трогаем
      if (code === 404 || code === 410) q('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
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
  if (syncCache.size > 100) syncCache.clear();   // дневники с фото тяжёлые — много в памяти не держим
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
  const gallery = p.gallery ? JSON.parse(p.gallery).map(id => `/media/${id}`) : [];
  return { id: p.id, author: pub(author), media: p.media ? `/media/${p.media}` : '', gallery: p.media && gallery.length ? [`/media/${p.media}`, ...gallery] : [], caption: p.caption || '',
    meta: p.meta ? JSON.parse(p.meta) : null, created: p.created,
    likes: q('SELECT COUNT(*) n FROM likes WHERE post_id = ?').get(p.id).n,
    liked: Boolean(q('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(p.id, me)),
    comments: q('SELECT COUNT(*) n FROM comments WHERE post_id = ?').get(p.id).n, mine: p.user_id === me, vis: p.vis || 'friends' };
}
// открытые публикации видят все; закрытые — автор и его друзья
const canSeePost = (me, p) => p.vis === 'public' || canSee(me, p.user_id);
const newCode = () => randomBytes(6).toString('base64url');
const inviteCode = u => { if (u.invite) return u.invite; const c = newCode(); q('UPDATE users SET invite = ? WHERE id = ?').run(c, u.id); u.invite = c; return c; };
const inviter = code => code && /^[A-Za-z0-9_-]{6,16}$/.test(code) ? q('SELECT * FROM users WHERE invite = ? AND username != ?').get(code, BOT_USERNAME) : null;
const inviteFacts = u => ({ friends: q(`SELECT COUNT(*) n FROM friends WHERE (a = ? OR b = ?) AND status = 'accepted'`).get(u.id, u.id).n,
  posts: q('SELECT COUNT(*) n FROM posts WHERE user_id = ?').get(u.id).n, card: u.og ? `/media/${u.og}` : '' });
async function dropMedia(id) {
  if (q('SELECT 1 FROM posts WHERE media = ? OR og = ?').get(id, id) || q('SELECT 1 FROM users WHERE avatar = ? OR og = ?').get(id, id)) return;
  q('DELETE FROM media WHERE id = ?').run(id); await unlink(join(MEDIA, id)).catch(() => {});
}
const isAdminId = id => isAdmin(q('SELECT username FROM users WHERE id = ?').get(id));
function visiblePost(id, me) {
  const p = q('SELECT * FROM posts WHERE id = ?').get(id);
  if (!p || !(canSeePost(me, p) || isAdminId(me))) throw fail(404, 'Публикация не найдена');
  return p;
}
const shapeComment = (c, me) => {
  const to = c.reply_to ? q('SELECT id, name, username FROM users WHERE id = ?').get(c.reply_to) : null;
  return { id: c.id, body: c.body, kind: c.kind || 'text', media: c.media ? `/media/${c.media}` : '', dur: c.meta ? num(JSON.parse(c.meta).dur) : 0,
    created: c.created, parent: c.parent_id || null, replyTo: to ? { id: to.id, name: to.name, username: to.username } : null,
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
const PROMPT_TEXT = await readFile(fileURLToPath(new URL('./prompt-text.txt', import.meta.url)), 'utf8');   // еда словами или голосом — без фото
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
    })).filter(i => i.grams > 0).map(i => {
      // калорийность должна сходиться с БЖУ (4·Б + 9·Ж + 4·У): если модель ошиблась больше чем на 25% — считаем по БЖУ
      const byMacro = 4 * i.p_100 + 9 * i.f_100 + 4 * i.c_100;
      if (i.role !== 'drink' && byMacro > 5 && Math.abs(i.kcal_100 - byMacro) / byMacro > 0.25) i.kcal_100 = Math.round(byMacro);   // напитки не трогаем: у алкоголя калории не из БЖУ
      return i;
    }),
    confidence: pick(j.confidence, ['low', 'medium', 'high'], 'medium'),
    question: String(j.question || '').slice(0, 120),
    options: (Array.isArray(j.options) ? j.options : []).slice(0, 4).map(o => String(o).slice(0, 40)),
  };
}
// Скорость: модель «рассуждает» перед ответом — для оценки еды по фото хватает низкого уровня.
// Если ProxyAPI/модель не примет параметр, один раз откатываемся без него и запоминаем (без серии 4xx).
let REASONING = (process.env.AI_REASONING || 'low').toLowerCase();   // low | medium | high | off
const AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 4000);   // с запасом: «размышления» модели тоже тратят этот лимит, иначе ответ обрывается пустым
const AI_HEDGE_MS = Number(process.env.AI_HEDGE_MS || 15000);     // столько ждём основную модель, потом параллельно спрашиваем запасную
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 42000); // общий потолок ожидания ответа
const AI_BASE = (process.env.AI_BASE_URL || 'https://api.proxyapi.ru/v1').replace(/\/$/, '');
const aiStats = [];   // последние 200 распознаваний: время, размер фото, токены — для админа
function aiBody(model, caption, image, withReasoning) {
  const content = image
    ? [{ type: 'text', text: PROMPT.replace('{caption}', caption) }, { type: 'image_url', image_url: /^openai\//.test(model.id) ? { url: image, detail: 'auto' } : { url: image } }]
    : [{ type: 'text', text: PROMPT_TEXT.replace('{caption}', caption) }];
  const b = { model: model.id, max_completion_tokens: AI_MAX_TOKENS, messages: [{ role: 'user', content }] };
  // описание словами: картинки нет, запрос лёгкий — можно дать модели подумать чуть дольше ради точности
  if (withReasoning && REASONING !== 'off' && /^openai\//.test(model.id)) b.reasoning_effort = image ? REASONING : (process.env.AI_REASONING_TEXT || (REASONING === 'low' ? 'medium' : REASONING));
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
  const body = await json(req, 4_000_000);
  const image = String(body.image || '');
  const caption = String(body.caption || '').replace(/[<>]/g, '').slice(0, image ? 300 : 1000);
  if (image && (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 3_000_000)) throw fail(400, 'Нужна фотография JPEG/PNG до ~2 МБ');
  if (!image && caption.trim().length < 2) throw fail(400, 'Опишите, что вы съели');
  const primary = MODELS[body.model] || MODELS.fast, backup = primary === MODELS.gemini ? MODELS.fast : MODELS.gemini;
  const t0 = now();
  // одна попытка у одной модели: никогда не бросает, всегда возвращает итог — так их удобно гонять наперегонки
  async function attempt(model, signal) {
    const ta = now(); let usedReasoning = REASONING !== 'off' && /^openai\//.test(model.id);
    try {
      let r = await callAI(aiBody(model, caption, image, true), signal);
      if (r.status === 400 && usedReasoning) {
        const txt = await r.text();
        if (!/reasoning/i.test(txt)) return { model, status: 400, why: txt.slice(0, 200), ms: now() - ta };
        console.error('reasoning_effort не поддерживается — выключаю'); REASONING = 'off'; usedReasoning = false;
        r = await callAI(aiBody(model, caption, image, false), signal);
      }
      if (!r.ok) return { model, status: r.status, why: (await r.text().catch(() => '')).slice(0, 200), ms: now() - ta };
      const data = await r.json().catch(() => null), ch = data?.choices?.[0];
      const m = String(ch?.message?.content || '').match(/\{[\s\S]*\}/);
      let parsed = null; try { parsed = m ? JSON.parse(m[0]) : null; } catch {}
      if (!parsed) return { model, status: 200, bad: true, why: `пустой/битый ответ, finish=${ch?.finish_reason || '?'}`, ms: now() - ta, usage: data?.usage };
      return { model, ok: true, parsed, usage: data?.usage || {}, usedReasoning, ms: now() - ta };
    } catch (e) { return { model, status: 0, why: e.name === 'AbortError' ? 'нет ответа (таймаут)' : `сеть: ${e.message}`, ms: now() - ta }; }
  }
  // основная модель; если молчит дольше AI_HEDGE_MS или ошиблась — параллельно спрашиваем запасную, берём первый годный ответ
  const cA = new AbortController(), cB = new AbortController();
  const deadline = setTimeout(() => { cA.abort(); cB.abort(); }, AI_TIMEOUT_MS);
  const pA = attempt(primary, cA.signal);
  let hedgeT; const hedge = new Promise(r => { hedgeT = setTimeout(() => r(null), AI_HEDGE_MS); });
  const fails = [];
  let res0 = await Promise.race([pA, hedge]); clearTimeout(hedgeT);
  if (res0 && !res0.ok) fails.push(res0);
  if (!res0?.ok && !(res0 && (res0.status === 402 || res0.status === 429))) {   // баланс и лимит ключа общие — запасная не поможет
    const pB = attempt(backup, cB.signal), list = res0 ? [pB] : [pA, pB];
    res0 = await new Promise(done => { let left = list.length; for (const p of list) p.then(r => { if (r.ok) done(r); else { if (!fails.includes(r)) fails.push(r); if (--left === 0) done(null); } }); });
  }
  clearTimeout(deadline);
  if (res0?.ok) (res0.model === primary ? cB : cA).abort();   // проигравшего не ждём и не оплачиваем дальше
  for (const f of fails) {
    console.error(`analyze FAIL ${f.model.id} status=${f.status} ${f.ms}ms ${f.why}`);
    aiStats.push({ at: now(), model: f.model.id, ms: f.ms, ok: false, why: `${f.status ? 'http ' + f.status : ''} ${f.why}`.trim(), kb: Math.round(image.length * 0.75 / 1024), upload_ms: t0 - tIn, prompt: f.usage?.prompt_tokens || 0, out: f.usage?.completion_tokens || 0, reasoning: f.usage?.completion_tokens_details?.reasoning_tokens || 0, effort: REASONING });
  }
  if (!res0?.ok) {
    while (aiStats.length > 200) aiStats.shift();
    const st = fails.map(f => f.status);
    if (st.includes(402)) { console.error('proxyapi 402: пополните баланс'); throw fail(503, 'Сервис временно недоступен. Попробуйте позже.'); }
    if (st.includes(429)) throw fail(429, 'Очередь занята. Попробуйте через минуту.');
    if (st.every(x => x === 0)) throw fail(504, 'Нейросеть не ответила. Попробуйте ещё раз.');
    if (fails.some(f => f.bad)) throw fail(502, 'Нейросеть ответила непонятно. Попробуйте ещё раз.');
    throw fail(502, 'Не получилось распознать. Попробуйте ещё раз.');
  }
  const { parsed, model, usage: u } = res0;
  const stat = { at: now(), model: model.id, ms: now() - t0, upload_ms: t0 - tIn, kb: Math.round(image.length * 0.75 / 1024),
    prompt: u.prompt_tokens || 0, out: u.completion_tokens || 0, reasoning: u.completion_tokens_details?.reasoning_tokens || 0, effort: res0.usedReasoning ? REASONING : 'off', ok: true, ...(model !== primary ? { fallback: true } : {}) };
  aiStats.push(stat); while (aiStats.length > 200) aiStats.shift();
  console.log(`analyze ${model.id}${stat.fallback ? ' (запасная)' : ''} ${stat.ms}ms upload=${stat.upload_ms}ms ${stat.kb}KB tokens in=${stat.prompt} out=${stat.out} reasoning=${stat.reasoning} effort=${stat.effort}`);
  send(res, 200, { ...clean(parsed), model: model.label, ms: stat.ms, ...(stat.fallback ? { fallback: true } : {}) });
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
  // аватарки и карточки-превью для мессенджеров открыты всем: ими человек делится сам
  const isAvatar = q('SELECT 1 FROM users WHERE avatar = ? OR og = ?').get(id, id) || q('SELECT 1 FROM posts WHERE og = ?').get(id);
  const allowed = isAvatar || isAdmin(me) || (me && (m.owner === me.id ||
    q('SELECT 1 FROM messages WHERE media = ? AND (sender = ? OR recipient = ?)').get(id, me.id, me.id) ||
    q('SELECT user_id, vis FROM posts WHERE media = ? OR gallery LIKE ?').all(id, `%"${id}"%`).some(p => canSeePost(me.id, p)) ||
    q('SELECT p.user_id, p.vis FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.media = ?').all(id).some(p => canSeePost(me.id, p))));
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
    if (username === BOT_USERNAME || q('SELECT 1 FROM users WHERE username = ?').get(username)) throw fail(409, 'Такой логин уже занят');
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
  // публичные карточки для гостя, пришедшего по ссылке: только то, чем человек сам поделился
  const ic = /^\/api\/invite\/([A-Za-z0-9_-]{6,16})$/.exec(p);
  if (ic && M === 'GET') {
    rate('inv:' + ipOf(req), 120, 600_000);
    const u = inviter(ic[1]); if (!u) throw fail(404, 'Ссылка устарела');
    return send(res, 200, { user: pub(u), ...inviteFacts(u) });
  }
  const sp = /^\/api\/share\/post\/(\d+)$/.exec(p);
  if (sp && M === 'GET') {
    rate('inv:' + ipOf(req), 120, 600_000);
    const post = q('SELECT * FROM posts WHERE id = ?').get(Number(sp[1]));
    if (!post?.og) throw fail(404, 'Публикация недоступна');
    const x = post.meta ? JSON.parse(post.meta) : {}, a = q('SELECT * FROM users WHERE id = ?').get(post.user_id);
    return send(res, 200, { post: { id: post.id, title: x.title || '', kcal: x.kcal || 0, p: x.p || 0, f: x.f || 0, c: x.c || 0, day: !!x.day, card: `/media/${post.og}`, author: pub(a) } });
  }
  const me = need(req);
  if (p === '/api/invite' && M === 'GET') {
    return send(res, 200, { code: inviteCode(me), joined: q('SELECT COUNT(*) n FROM users WHERE ref_by = ?').get(me.id).n, og: me.og ? `/media/${me.og}` : '' });
  }
  if (p === '/api/invite/reset' && M === 'POST') {
    rate('invreset:' + me.id, 10, 3_600_000);
    q('UPDATE users SET invite = ? WHERE id = ?').run(newCode(), me.id);
    return send(res, 200, { code: q('SELECT invite FROM users WHERE id = ?').get(me.id).invite });
  }
  if (p === '/api/invite/accept' && M === 'POST') {
    rate('invacc:' + me.id, 30, 3_600_000);
    const b = await json(req, 2_000), u = inviter(String(b.code || ''));
    if (!u) throw fail(404, 'Ссылка устарела — попросите новую');
    if (u.id === me.id) return send(res, 200, { user: pub(u), state: 'self' });
    const a = Math.min(me.id, u.id), c = Math.max(me.id, u.id), was = friendState(me.id, u.id);
    if (was !== 'friends') {
      q(`INSERT INTO friends (a, b, status, created) VALUES (?, ?, 'accepted', ?) ON CONFLICT (a, b) DO UPDATE SET status = 'accepted'`).run(a, c, now());
      // «пришёл по ссылке» — только для свежих аккаунтов (первые сутки), чтобы счётчик приглашённых был честным
      const fresh = !me.ref_by && now() - me.created < 864e5;
      if (fresh) q('UPDATE users SET ref_by = ? WHERE id = ?').run(u.id, me.id);
      notify(u.id, { title: fresh ? 'По вашей ссылке пришёл друг 🎉' : 'Новый друг', body: `${me.name} (@${me.username}) ${fresh ? 'присоединился(ась) — вы теперь друзья' : 'открыл(а) вашу ссылку — вы теперь друзья'}`, url: `/?user=${me.id}`, tag: `friend-${me.id}` });
    }
    return send(res, 200, { user: pub(u), state: 'friends', already: was === 'friends' });
  }
  if (p === '/api/me/og' && M === 'POST') {
    const b = await json(req, 2_000), m = q('SELECT * FROM media WHERE id = ? AND owner = ?').get(String(b.media || ''), me.id);
    if (!m || !m.type.startsWith('image/')) throw fail(400, 'Нужна картинка');
    const old = me.og; q('UPDATE users SET og = ? WHERE id = ?').run(m.id, me.id);
    if (old && old !== m.id) await dropMedia(old);
    return send(res, 200, { og: `/media/${m.id}` });
  }
  const po = /^\/api\/posts\/(\d+)\/og$/.exec(p);
  if (po && M === 'POST') {
    const post = q('SELECT * FROM posts WHERE id = ?').get(Number(po[1]));
    if (!post || !canSeePost(me.id, post) || (post.user_id !== me.id && post.vis !== 'public')) throw fail(404, 'Публикация не найдена');
    const b = await json(req, 2_000), m = q('SELECT * FROM media WHERE id = ? AND owner = ?').get(String(b.media || ''), me.id);
    if (!m || !m.type.startsWith('image/')) throw fail(400, 'Нужна картинка');
    // карточку пересобирает только автор; остальные получают уже готовую
    if (post.og && post.user_id !== me.id) { await dropMedia(m.id); return send(res, 200, { og: `/media/${post.og}` }); }
    const old = post.og; q('UPDATE posts SET og = ? WHERE id = ?').run(m.id, post.id);
    if (old && old !== m.id) await dropMedia(old);
    return send(res, 200, { og: `/media/${m.id}` });
  }
  if (p === '/api/push/subscribe' && M === 'POST') {
    const b = await json(req, 8_000), ep = String(b.endpoint || ''), k = b.keys || {};
    let host = ''; try { const u = new URL(ep); if (u.protocol === 'https:') host = u.hostname; } catch {}
    if (!PUSH_HOSTS.test(host) || !k.p256dh || !k.auth) throw fail(400, 'Неверная подписка');
    q(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created, sess) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, sess = COALESCE(excluded.sess, push_subs.sess)`)
      .run(ep, me.id, String(k.p256dh), String(k.auth), now(), sessOf(req) || null);
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
  // назначить / снять тренера (только из друзей)
  const cm2 = /^\/api\/coach\/(\d+)$/.exec(p);
  if (cm2 && (M === 'POST' || M === 'DELETE')) {
    const other = Number(cm2[1]), ou = q('SELECT * FROM users WHERE id = ?').get(other);
    if (!ou || other === me.id || ou.username === BOT_USERNAME) throw fail(404, 'Пользователь не найден');
    if (M === 'POST') {
      if (!areFriends(me.id, other)) throw fail(403, 'Тренером можно назначить только друга');
      const r = q('INSERT OR IGNORE INTO coaches (client_id, coach_id, created) VALUES (?, ?, ?)').run(me.id, other, now());
      if (r.changes) notify(other, { title: 'Вы теперь тренер', body: `${me.name} открыл(а) вам свой дневник: еда, вода, активность и вес`, url: `/?user=${me.id}`, tag: `coach-${me.id}` });
    } else q('DELETE FROM coaches WHERE client_id = ? AND coach_id = ?').run(me.id, other);
    return send(res, 200, { coach: M === 'POST' });
  }
  // тренер отказывается от подопечного
  const cl2 = /^\/api\/clients\/(\d+)$/.exec(p);
  if (cl2 && M === 'DELETE') { q('DELETE FROM coaches WHERE client_id = ? AND coach_id = ?').run(Number(cl2[1]), me.id); return send(res, 200, { ok: true }); }
  if (p === '/api/clients' && M === 'GET') {
    const rows = q('SELECT u.* FROM coaches c JOIN users u ON u.id = c.client_id WHERE c.coach_id = ? ORDER BY c.created').all(me.id);
    const coaches = q('SELECT u.* FROM coaches c JOIN users u ON u.id = c.coach_id WHERE c.client_id = ?').all(me.id).map(pub);
    return send(res, 200, { clients: rows.map(u => { const sm = daySummary(u); return { ...pub(u), today: sm ? { kcal: sm.kcal, goal: sm.goal, meals: sm.meals, p: sm.p, pGoal: sm.pGoal } : null, synced: u.sync_at || null }; }), coaches });
  }
  // дневник подопечного: только тренеру (и администратору), за последние N дней
  const dym = /^\/api\/users\/(\d+)\/diary$/.exec(p);
  if (dym && M === 'GET') {
    const u = q('SELECT * FROM users WHERE id = ?').get(Number(dym[1])); if (!u) throw fail(404, 'Пользователь не найден');
    if (!(isCoachOf(me.id, u.id) || isAdmin(me))) throw fail(403, 'Дневник открыт только тренеру');
    const n = Math.max(1, Math.min(60, Number(url.searchParams.get('days') || 14)));
    let data = null; try { data = u.sync ? JSON.parse(u.sync) : null; } catch {}
    if (!data?.days) return send(res, 200, { days: {}, weights: [], profile: null, settings: null, health: {}, synced: null, n });
    const from = shiftDay(dayKey(now()), -(n - 1)), days = {}, health = {};
    for (const [k, v] of Object.entries(data.days)) if (k >= from) days[k] = { meals: (v.meals || []).map(m => ({ id: m.id, time: m.time, type: m.type, name: m.name, thumb: m.thumb || '', portion: m.portion || 1, items: m.items || [] })), water: v.water || 0, acts: v.acts || [], steps: v.steps || 0 };
    for (const [k, v] of Object.entries(data.health || {})) if (k >= from) health[k] = v;
    const pr = data.profile || {};
    return send(res, 200, { n, synced: u.sync_at, days, health, weights: (data.weights || []).slice(-120), settings: data.settings || {},
      profile: { sex: pr.sex, age: pr.age, height: pr.height, weight: pr.weight, target: pr.target, goal: pr.goal, activity: pr.activity } });
  }
  // все зарегистрированные: кто, когда пришёл, когда был в сети, активность
  if (p === '/api/admin/users' && M === 'GET') {
    if (!isAdmin(me)) throw fail(403, 'Только для администратора');
    const term = String(url.searchParams.get('q') || '').trim().replace(/[%_]/g, '').slice(0, 30);
    const rows = q(`SELECT u.id, u.username, u.name, u.avatar, u.bio, u.stats, u.created, u.seen_at, u.sync_at,
        (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) posts,
        (SELECT COUNT(*) FROM friends f WHERE (f.a = u.id OR f.b = u.id) AND f.status = 'accepted') friends,
        (SELECT MAX(created) FROM sessions s WHERE s.user_id = u.id) login
      FROM users u WHERE u.username != ? AND (? = '' OR u.username LIKE ? OR u.name LIKE ?) ORDER BY COALESCE(u.seen_at, u.created) DESC LIMIT 500`)
      .all(BOT_USERNAME, term, term + '%', '%' + term + '%');
    const total = q('SELECT COUNT(*) n FROM users WHERE username != ?').get(BOT_USERNAME).n, day = now() - 864e5, week = now() - 7 * 864e5;
    return send(res, 200, { total, active1: q('SELECT COUNT(*) n FROM users WHERE seen_at > ?').get(day).n, active7: q('SELECT COUNT(*) n FROM users WHERE seen_at > ?').get(week).n,
      newWeek: q('SELECT COUNT(*) n FROM users WHERE created > ? AND username != ?').get(week, BOT_USERNAME).n,
      users: rows.map(u => ({ ...pub(u), created: u.created, seen: u.seen_at || u.login || null, sync: u.sync_at || null, posts: u.posts, friends: u.friends, admin: isAdmin(u) })) });
  }
  if (p === '/api/admin/stats' && M === 'GET') {
    if (!isAdmin(me)) throw fail(403, 'Только для администратора');
    const okRuns = aiStats.filter(x => x.ok), last = okRuns.slice(-50), ms = last.map(x => x.ms).sort((a, b) => a - b);
    const pct = k => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * k))] : 0, p50 = pct(0.5), p95 = pct(0.95);
    const avg = k => last.length ? Math.round(last.reduce((a, x) => a + x[k], 0) / last.length) : 0;
    return send(res, 200, { runs: aiStats.length, fails: aiStats.length - okRuns.length, p50, p95, upload: avg('upload_ms'), kb: avg('kb'), reasoning: avg('reasoning'), out: avg('out'),
      effort: REASONING, maxTokens: AI_MAX_TOKENS, fallbacks: aiStats.filter(x => x.fallback).length, errors: aiStats.filter(x => !x.ok).slice(-6).reverse().map(x => ({ at: x.at, model: x.model, ms: x.ms, why: x.why })), users: q('SELECT COUNT(*) n FROM users').get().n, today: aiCount, last: aiStats.slice(-10).reverse() });
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
    const coach = isCoachOf(me.id, u.id), admin = isAdmin(me), visible = admin || coach || canSee(me.id, u.id);   // администратор и тренер видят профиль целиком
    const posts = q(`SELECT * FROM posts WHERE user_id = ? ${visible ? '' : "AND vis = 'public'"} ORDER BY id DESC LIMIT 120`).all(u.id).map(p => shapePost(p, me.id));
    const friendsCount = q(`SELECT COUNT(*) n FROM friends WHERE (a = ? OR b = ?) AND status = 'accepted'`).get(u.id, u.id).n;
    return send(res, 200, { user: { ...pub(u), state: u.id === me.id ? 'self' : friendState(me.id, u.id), flame: u.id === me.id ? null : flame(me.id, u.id), summary: (admin || coach) && u.id !== me.id && u.username !== BOT_USERNAME ? daySummary(u) : summaryFor(me.id, u),
      iCoach: coach, myCoach: isCoachOf(u.id, me.id),
      postsCount: q('SELECT COUNT(*) n FROM posts WHERE user_id = ?').get(u.id).n, friendsCount }, posts, visible });
  }
  if (p === '/api/posts' && M === 'POST') {
    rate('post:' + me.id, 30, 3_600_000);
    const b = await json(req, 16_000);
    const m = b.media && q('SELECT * FROM media WHERE id = ? AND owner = ?').get(String(b.media), me.id);
    if (!m || !m.type.startsWith('image/')) throw fail(400, 'Нужна фотография');
    const x = b.meta && typeof b.meta === 'object' ? b.meta : {};
    const meta = JSON.stringify({ title: String(x.title || '').slice(0, 80), kcal: num(x.kcal), p: num(x.p), f: num(x.f), c: num(x.c),
      items: (Array.isArray(x.items) ? x.items : []).slice(0, 12).map(i => ({ name: String(i.name || '').slice(0, 40), grams: num(i.grams) })),
      ...(Array.isArray(x.meals) && x.meals.length ? { day: true, meals: x.meals.slice(0, 10).map(i => ({ title: String(i.title || '').slice(0, 80), kcal: num(i.kcal), p: num(i.p), f: num(i.f), c: num(i.c), time: String(i.time || '').slice(0, 5) })) } : {}) });
    // мультипост «мой день»: до 10 фото, у каждого — своя карточка блюда в meta.meals
    const gal = (Array.isArray(b.gallery) ? b.gallery : []).slice(0, 9).map(String).filter(id => id !== m.id && q('SELECT 1 FROM media WHERE id = ? AND owner = ? AND type LIKE ?').get(id, me.id, 'image/%'));
    const r = q('INSERT INTO posts (user_id, media, caption, meta, created, vis, gallery) VALUES (?, ?, ?, ?, ?, ?, ?)').run(me.id, m.id, String(b.caption || '').slice(0, 500), meta, now(), b.vis === 'friends' ? 'friends' : 'public', gal.length ? JSON.stringify(gal) : null);
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
      for (const mid of [post.media, ...(post.gallery ? JSON.parse(post.gallery) : [])]) {
        if (mid && !q('SELECT 1 FROM messages WHERE media = ?').get(mid) && !q('SELECT 1 FROM posts WHERE media = ? OR gallery LIKE ?').get(mid, `%"${mid}"%`) && !q('SELECT 1 FROM users WHERE avatar = ?').get(mid)) {
          q('DELETE FROM media WHERE id = ?').run(mid); await unlink(join(MEDIA, mid)).catch(() => {});
        }
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
      // голосовое или кружок: файл уже загружен через /api/media и принадлежит автору комментария
      const kind = b.kind === 'voice' || b.kind === 'video' ? b.kind : 'text';
      const cm = kind !== 'text' && q('SELECT * FROM media WHERE id = ? AND owner = ?').get(String(b.media || ''), me.id);
      if (kind !== 'text' && (!cm || !cm.type.startsWith(kind === 'voice' ? 'audio/' : 'video/') && !(kind === 'voice' && cm.type === 'video/webm'))) throw fail(400, 'Нет записи');
      if (kind === 'text' && !body) throw fail(400, 'Пустой комментарий');
      const cmeta = kind !== 'text' ? JSON.stringify({ dur: Math.max(0, Math.min(600, num(b.meta?.dur))) }) : null;
      // ответ: храним корневой комментарий (одна ветка, как в TikTok) и кому отвечаем
      let parent = null, replyTo = null;
      if (b.parent) {
        const pc = q('SELECT * FROM comments WHERE id = ? AND post_id = ?').get(Number(b.parent), post.id);
        if (!pc) throw fail(404, 'Комментарий не найден');
        parent = pc.parent_id || pc.id; replyTo = pc.user_id;
      }
      const r = q('INSERT INTO comments (post_id, user_id, body, created, parent_id, reply_to, kind, media, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(post.id, me.id, body, now(), parent, replyTo, kind, cm ? cm.id : null, cmeta);
      const ptxt = kind === 'voice' ? '🎤 Голосовой комментарий' : kind === 'video' ? '📹 Кружок' : body.slice(0, 120);
      if (replyTo && replyTo !== me.id) notify(replyTo, { title: `${me.name} ответил(а) вам`, body: ptxt, url: `/?post=${post.id}`, tag: `post-${post.id}` });
      if (post.user_id !== me.id && post.user_id !== replyTo) notify(post.user_id, { title: `${me.name} прокомментировал(а)`, body: ptxt, url: `/?post=${post.id}`, tag: `post-${post.id}` });
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
    const rows = q(`SELECT * FROM users WHERE id != ? AND username != ? AND (username LIKE ? OR name LIKE ?) ORDER BY username = ? DESC, username LIMIT 20`)
      .all(me.id, BOT_USERNAME, term + '%', '%' + term + '%', term);
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
    if (M === 'DELETE') { q('DELETE FROM friends WHERE a = ? AND b = ?').run(a, b); q('DELETE FROM coaches WHERE (client_id = ? AND coach_id = ?) OR (client_id = ? AND coach_id = ?)').run(me.id, other, other, me.id); return send(res, 200, { state: 'none' }); }
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
      chatOpen.set(`${me.id}:${other}:${sessOf(req)}`, now());
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
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
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

/* ---------------- ссылки для мессенджеров ----------------
   /i/<код> — приглашение, /p/<id> — публикация. Отдаём то же приложение, но с og-тегами: Telegram, WhatsApp и VK
   рисуют по ним карточку-превью (картинку собирает приложение на телефоне и загружает как users.og / posts.og). */
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nfr = v => Math.round(+v || 0).toLocaleString('ru-RU');
async function serveShare(req, res, url) {
  const base = `${req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https'}://${req.headers.host}`;
  let title = 'Healthy Fit — КБЖУ по фото', desc = 'Сфоткал — и знаешь, сколько съел. Граммы и КБЖУ по фото за пару секунд, вода, тренировки и друзья.', img = '/og.jpg';
  const [, kind, id] = /^\/(i|p)\/([^/]+)/.exec(url.pathname);
  if (kind === 'i') {
    const u = inviter(id);
    if (u) {
      const st = JSON.parse(u.stats || '{}');
      title = `${u.name} зовёт вас в Healthy Fit`;
      desc = `${st.streak > 1 ? `Уже ${st.streak} дн. подряд записывает еду. ` : ''}Добавьтесь в друзья в одно касание — и держите серию вместе. КБЖУ по фото за пару секунд.`;
      if (u.og) img = `/media/${u.og}`; else if (u.avatar) img = `/media/${u.avatar}`;
    }
  } else {
    const post = q('SELECT * FROM posts WHERE id = ?').get(Number(id));
    if (post?.og) {
      const x = post.meta ? JSON.parse(post.meta) : {}, a = q('SELECT name FROM users WHERE id = ?').get(post.user_id);
      title = `${x.title || 'Блюдо'} — ${nfr(x.kcal)} ккал`;
      desc = `Б ${nfr(x.p)} · Ж ${nfr(x.f)} · У ${nfr(x.c)} г. ${a?.name || ''} считает КБЖУ по фото в Healthy Fit — попробуйте со своей едой.`;
      img = `/media/${post.og}`;
    }
  }
  const f = await staticFile(join(ROOT, 'index.html'));
  const meta = [['og:type', 'website'], ['og:site_name', 'Healthy Fit'], ['og:title', title], ['og:description', desc], ['og:url', base + url.pathname + url.search],
    ['og:image', base + img], ['og:image:width', '1200'], ['og:image:height', '630'], ['og:locale', 'ru_RU']]
    .map(([k, v]) => `<meta property="${k}" content="${escH(v)}">`).join('\n  ') + `\n  <meta name="twitter:card" content="summary_large_image">`;
  const html = f.buf.toString('utf8')
    .replace(/<title>[^<]*<\/title>/, `<title>${escH(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${escH(desc)}`)
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  ${meta}`)
    // страница живёт по адресу /i/… — относительные пути к стилям и скриптам делаем абсолютными
    .replace(/(\s(?:src|href)=")(?![a-z]+:|\/|#)/g, '$1/');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

/* ---------------- «Помощник по питанию» ----------------
   Раз в день вечером (20:00–23:00 по APP_TZ) пишет каждому в чат: итоги дня, «неделя пока» и один совет на завтра;
   по воскресеньям — итоги недели и путь до цели по весу. Считает по облачной копии дневника — теми же формулами, что приложение. */
// помощник не должен уметь «положить» сервер: любая ошибка при его запуске — только в лог
let BOT_ID = 0;
try {
  db.exec(`CREATE TABLE IF NOT EXISTS coach_log (user_id INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (user_id, day, kind))`);
  BOT_ID = q('SELECT id FROM users WHERE username = ?').get(BOT_USERNAME)?.id || 0;
  if (!BOT_ID) BOT_ID = Number(q('INSERT INTO users (username, name, pass, health_token, created) VALUES (?, ?, ?, ?, ?)')
    .run(BOT_USERNAME, 'Помощник по питанию', hashPass(randomBytes(24).toString('hex')), randomBytes(18).toString('base64url'), now()).lastInsertRowid);
} catch (e) { console.error('coach init', e.message); }
const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
const nf = v => Math.round(v).toLocaleString('ru-RU');
const lit = ml => String(Math.round(ml / 100) / 10).replace('.', ',');
function dayStatsOf(data, date) {
  const day = data.days?.[date] || {}, s = data.settings || {}, prof = data.profile || {}, t = { kcal: 0, p: 0 };
  for (const m of day.meals || []) for (const it of m.items || []) { const x = itemTotals(it); t.kcal += x.kcal * (1); t.p += x.p; }
  const h = (data.health || {})[date] || {};
  let bonus = 0; try { bonus = HFCalc.dayBonus({ ...prof, weight: +prof.weight || 75 }, day.acts || [], day.steps || h.steps || 0, h.active_kcal || 0).kcal; } catch {}
  return { meals: (day.meals || []).length, kcal: t.kcal, p: t.p, goal: (+s.goal || 2000) + bonus, pGoal: +s.p || 120, water: +day.water || 0, waterGoal: +s.waterGoal || 2000 };
}
const shiftDay = (k, n) => { const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function coachEvening(u, date, weekly) {
  let data = null; try { data = u.sync ? JSON.parse(u.sync) : null; } catch {}   // без кэша: не держим чужие дневники в памяти
  if (!data?.days) return null;
  const d = dayStatsOf(data, date), lines = [];
  const week = Array.from({ length: 7 }, (_, i) => dayStatsOf(data, shiftDay(date, -i))).filter(x => x.meals);
  const inNorm = week.filter(x => Math.abs(x.kcal - x.goal) <= x.goal * 0.1).length;
  if (!d.meals) {
    if (!week.length) return null;   // давно не пользуется — не надоедаем
    lines.push('Сегодня в дневнике пусто 🙂', 'Запишите хотя бы ужин — даже примерно. Без пропусков видно настоящий прогресс, а серия не сгорит в полночь.');
  } else {
    const diff = d.kcal - d.goal, ok = Math.abs(diff) <= d.goal * 0.1;
    lines.push('Итоги дня 🌙', `Съедено ${nf(d.kcal)} из ${nf(d.goal)} ккал — ${ok ? 'в норме ✅' : diff > 0 ? `перебор ${nf(diff)} ккал` : `недобор ${nf(-diff)} ккал`}`,
      `Белок ${nf(d.p)} из ${nf(d.pGoal)} г · вода ${lit(d.water)} из ${lit(d.waterGoal)} л`);
    if (week.length > 1) lines.push(`Неделя пока: ${inNorm} из ${week.length} дней в норме, в среднем ${nf(week.reduce((a, x) => a + x.kcal, 0) / week.length)} ккал.`);
    const tip = d.p < d.pGoal * 0.85 ? `Совет на завтра: добавьте ~${nf(d.pGoal - d.p)} г белка — творог, яйца, курица или рыба.`
      : diff > d.goal * 0.1 ? 'Совет на завтра: чуть меньше гарнира и перекусов — и день попадёт в норму.'
      : diff < -d.goal * 0.25 ? 'Совет на завтра: не урезайте слишком сильно — большой недобор тормозит прогресс и срывает режим.'
      : d.water < d.waterGoal * 0.7 ? 'Совет на завтра: держите бутылку воды на виду — до нормы не хватило.'
      : 'Отличный день — повторите завтра 💪';
    lines.push(tip);
  }
  if (weekly && week.length >= 3) {
    const w = (data.weights || []).filter(x => x.date > shiftDay(date, -8)), prof = data.profile || {};
    const last = (data.weights || []).at?.(-1)?.kg ?? (data.weights || [])[(data.weights || []).length - 1]?.kg;
    lines.push('', `Итоги недели: ${inNorm} из 7 дней в норме калорий.`);
    if (w.length >= 2) { const dk = Math.round((w[w.length - 1].kg - w[0].kg) * 10) / 10; lines.push(`Вес за неделю: ${dk > 0 ? '+' : dk < 0 ? '−' : ''}${String(Math.abs(dk)).replace('.', ',')} кг.`); }
    const start = (data.weights || [])[0]?.kg, tgt = +prof.target;
    if (tgt && start && last && Math.abs(start - tgt) > 0.2) {
      const pct = Math.max(0, Math.min(100, Math.round((start - last) / (start - tgt) * 100))), left = Math.round(Math.abs(last - tgt) * 10) / 10;
      lines.push(`До цели ${String(left).replace('.', ',')} кг — пройдено ${pct}% пути.`);
    } else if (!(data.weights || []).length) lines.push('Запишите вес в «Профиль → Прогресс» — покажу, как вы движетесь к цели.');
  }
  return lines.join('\n');
}
function coachSay(uid, text) {
  q('INSERT INTO messages (sender, recipient, kind, body, media, meta, created, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(BOT_ID, uid, 'text', text, null, null, now(), null);
  notify(uid, { title: 'Помощник по питанию', body: text.split('\n').slice(0, 2).join(' · ').slice(0, 140), url: `/?chat=${BOT_ID}`, tag: 'coach' });
}
const COACH_HELLO = 'Привет! Я помощник по питанию 👋\nКаждый вечер буду присылать итоги дня: калории, белок, воду и один совет на завтра. По воскресеньям — итоги недели и сколько осталось до цели.\nЗаписывайте еду — фото, голосом или удержав камеру — и смотрите свой прогресс в «Профиль → Прогресс».';
let coachBusy = false;
async function coachTick() {
  if (!BOT_ID || coachBusy) return; coachBusy = true;
  try {
    const parts = Object.fromEntries(clockFmt.formatToParts(new Date()).map(x => [x.type, x.value]));
    const hour = +parts.hour, today = dayKey(now()), weekly = parts.weekday === 'Sun', since = now() - 30 * 864e5;
    const ids = q(`SELECT u.id FROM users u WHERE u.id != ? AND (u.sync_at > ? OR EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.created > ?))`).all(BOT_ID, since, since).map(r => r.id);
    for (const id of ids) {
      await new Promise(r => setImmediate(r));   // по одному человеку за раз: сервер продолжает отвечать остальным
      try {
        if (!q('SELECT 1 FROM coach_log WHERE user_id = ? AND kind = ?').get(id, 'hello')) {
          q('INSERT OR IGNORE INTO coach_log (user_id, day, kind) VALUES (?, ?, ?)').run(id, today, 'hello'); coachSay(id, COACH_HELLO);
        }
        if (hour < 20 || hour >= 23 || q('SELECT 1 FROM coach_log WHERE user_id = ? AND day = ? AND kind = ?').get(id, today, 'day')) continue;
        q('INSERT OR IGNORE INTO coach_log (user_id, day, kind) VALUES (?, ?, ?)').run(id, today, 'day');
        const u = q('SELECT id, sync, sync_at FROM users WHERE id = ?').get(id);
        const text = coachEvening(u, today, weekly); if (text) coachSay(id, text);
      } catch (e) { console.error('coach user', id, e.message); }
    }
  } catch (e) { console.error('coach', e.message); } finally { coachBusy = false; }
}
setTimeout(coachTick, Number(process.env.COACH_DELAY_MS || 20_000)); setInterval(coachTick, 10 * 60_000);

// страховка: необработанная ошибка в фоне пишется в лог, а не роняет сервер в цикл перезапусков
process.on('unhandledRejection', e => console.error('unhandledRejection', e?.stack || e));
process.on('uncaughtException', e => console.error('uncaughtException', e?.stack || e));

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
    if (/^\/(i\/[A-Za-z0-9_-]{6,16}|p\/\d+)\/?$/.test(url.pathname)) return await serveShare(req, res, url);
    await serveStatic(req, res, url);
  } catch (e) {
    if (!e.public) console.error(e);
    if (!res.headersSent) send(res, e.code && e.public ? e.code : 500, { error: e.public ? e.message : 'Ошибка сервера' });
    else res.end();
  }
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`healthy on :${PORT}, key ${KEY ? 'set' : 'MISSING'}, data ${DATA}`));
