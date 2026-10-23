// Healthy Fit — рост через пользователей: ссылка-приглашение (кто открыл — сразу друг), карточки-превью для мессенджеров,
// «поделиться» публикацией в Telegram / WhatsApp / VK / картинкой в сторис.
(() => {
  'use strict';
  const HF = window.HF, S = () => window.HFSocial; if (!HF) return;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const nf = v => Math.round(+v || 0).toLocaleString('ru-RU');
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

  /* ---------- пришли по ссылке: /i/<код> или /p/<id>?r=<код> ---------- */
  (() => {
    const m = /^\/(i|p)\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname); if (!m) return;
    const r = new URLSearchParams(location.search).get('r');
    if (m[1] === 'i') lsSet('hf.ref', m[2]);
    else { lsSet('hf.refPost', m[2]); if (r && /^[A-Za-z0-9_-]{6,16}$/.test(r)) lsSet('hf.ref', r); }
    lsSet('hf.refAt', String(Date.now()));
    try { history.replaceState(null, '', '/'); } catch {}
  })();
  // ссылка «живёт» неделю: открыл, ушёл, вернулся через пару дней — дружба всё равно сработает
  if (Date.now() - +(lsGet('hf.refAt') || 0) > 7 * 864e5) { lsSet('hf.ref', null); lsSet('hf.refPost', null); }
  const pending = () => ({ code: lsGet('hf.ref'), post: +lsGet('hf.refPost') || 0 });

  // после входа/регистрации: дружим с пригласившим и открываем то, чем поделились
  let accepting = null;
  async function afterAuth() {
    const { code, post } = pending();
    if (code && !accepting) {
      accepting = S().api('/api/invite/accept', { method: 'POST', body: { code } })
        .then(r => { lsSet('hf.ref', null); if (r.state === 'friends' && !r.already) { HF.toast(`${r.user.name} теперь у вас в друзьях 🎉`, 'Открыть', () => window.HFPosts?.openUser(r.user.id), 6000); S().refreshSocial(); } return r; })
        .catch(e => { if (e.status === 404) lsSet('hf.ref', null); return null; })
        .finally(() => { accepting = null; });
      await accepting;
    }
    if (post && $('#onb')?.hidden !== false) { lsSet('hf.refPost', null); setTimeout(() => window.HFPosts?.openPost(post, false), 300); }
  }
  // для экрана приветствия: кто зовёт и чем поделился
  async function guestInfo() {
    const { code, post } = pending(); if (!code && !post) return null;
    const out = {};
    try { if (code) Object.assign(out, await S().api(`/api/invite/${encodeURIComponent(code)}`)); } catch {}
    try { if (post) out.post = (await S().api(`/api/share/post/${post}`)).post; } catch {}
    if (!out.user && out.post) out.user = out.post.author;
    return out.user ? out : null;
  }

  /* ---------- рисуем карточки на canvas ---------- */
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // цвета карточки — светлая тема всегда: превью в мессенджере должно быть одинаковым у всех
  const C = { paper: '#fbfbf9', card: '#ffffff', paper2: '#f1f1ee', rule: '#e4e4df', ink: '#1a1c20', ink2: '#3b3e45', muted: '#6b6f78',
    p: '#de6a52', f: '#d9952a', c: '#4f86c8', streak: '#ec7a2a', ok: '#3c9d6c' };
  const FONT = '"Onest", system-ui, -apple-system, "Segoe UI", sans-serif';
  const font = (w, px) => `${w} ${px}px ${FONT}`;
  async function fonts() { try { await Promise.all([document.fonts.load(font(800, 40)), document.fonts.load(font(500, 20)), document.fonts.load(font(700, 20))]); } catch {} }
  const loadImg = src => new Promise(res => { if (!src) return res(null); const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.textBaseline = 'alphabetic'; return [c, x]; }
  function rr(x, X, Y, W, H, r) { x.beginPath(); x.roundRect ? x.roundRect(X, Y, W, H, r) : x.rect(X, Y, W, H); }
  function cover(x, img, X, Y, W, H) {
    const s = Math.max(W / img.width, H / img.height), w = img.width * s, h = img.height * s;
    x.drawImage(img, X + (W - w) / 2, Y + (H - h) / 2, w, h);
  }
  // текст в несколько строк с многоточием на последней
  function lines(x, text, maxW, max) {
    const words = String(text || '').split(/\s+/).filter(Boolean), out = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (x.measureText(t).width <= maxW || !cur) cur = t; else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    if (out.length > max) { out.length = max; let l = out[max - 1]; while (l && x.measureText(l + '…').width > maxW) l = l.slice(0, -1); out[max - 1] = l.replace(/[\s,.;:—-]+$/, '') + '…'; }
    return out;
  }
  function logo(x, X, Y, s = 44, label = true) {
    x.fillStyle = C.ink; rr(x, X, Y, s, s, s * 0.3); x.fill();
    x.strokeStyle = '#fff'; x.lineWidth = s * 0.1; x.beginPath(); x.arc(X + s / 2, Y + s / 2, s * 0.24, 0, 7); x.stroke();
    if (label) { x.fillStyle = C.ink; x.font = font(800, s * 0.62); x.fillText('Healthy Fit', X + s + s * 0.32, Y + s * 0.72); }
  }
  function avatar(x, img, name, X, Y, d) {
    x.save(); x.beginPath(); x.arc(X + d / 2, Y + d / 2, d / 2, 0, 7); x.clip();
    if (img) cover(x, img, X, Y, d, d);
    else { x.fillStyle = C.paper2; x.fillRect(X, Y, d, d); x.fillStyle = C.ink2; x.font = font(800, d * 0.42); x.textAlign = 'center'; x.fillText((name || '?').trim().charAt(0).toUpperCase(), X + d / 2, Y + d * 0.65); x.textAlign = 'left'; }
    x.restore();
  }
  // полоска БЖУ по калориям: белок / жиры / углеводы
  function macroBar(x, m, X, Y, W, H) {
    const parts = [[C.p, (+m.p || 0) * 4], [C.f, (+m.f || 0) * 9], [C.c, (+m.c || 0) * 4]], tot = parts.reduce((a, p) => a + p[1], 0) || 1;
    x.save(); rr(x, X, Y, W, H, H / 2); x.clip(); x.fillStyle = C.paper2; x.fillRect(X, Y, W, H);
    let cx = X; for (const [col, v] of parts) { const w = W * v / tot; x.fillStyle = col; x.fillRect(cx, Y, w, H); cx += w; }
    x.restore();
  }
  function macroRow(x, m, X, Y, size) {
    let cx = X;
    for (const [k, col, lab] of [['p', C.p, 'Б'], ['f', C.f, 'Ж'], ['c', C.c, 'У']]) {
      x.fillStyle = col; x.beginPath(); x.arc(cx + size * 0.32, Y - size * 0.34, size * 0.3, 0, 7); x.fill();
      x.fillStyle = C.muted; x.font = font(600, size); x.fillText(lab, cx + size * 0.82, Y); cx += size * 0.82 + x.measureText(lab + ' ').width;
      x.fillStyle = C.ink; x.font = font(700, size); const t = `${nf(m[k])} г`; x.fillText(t, cx, Y); cx += x.measureText(t).width + size * 1.1;
    }
  }
  const out = c => c.toDataURL('image/jpeg', 0.86);

  // последняя еда из дневника — живой пример на карточке приглашения
  function lastMeal() {
    const keys = Object.keys(HF.db.days || {}).sort().reverse();
    for (const k of keys.slice(0, 14)) {
      const ms = (HF.db.days[k].meals || []).slice().reverse();
      const m = ms.find(x => x.thumb) || ms[0];
      if (m) { const t = HF.mealTotals(m.items || []); return { title: m.name, thumb: m.thumb, kcal: t.kcal, p: t.p, f: t.f, c: t.c }; }
    }
    return null;
  }

  async function profileCard(me) {
    await fonts();
    const [c, x] = canvas(1200, 630), meal = lastMeal() || { title: 'Сырники со сметаной и ягодами', kcal: 452, p: 24, f: 19, c: 46 };
    const [ava, food] = await Promise.all([loadImg(me.avatar), loadImg(meal.thumb)]);
    x.fillStyle = C.paper; x.fillRect(0, 0, 1200, 630);
    // слева — кто зовёт
    logo(x, 72, 64, 46);
    avatar(x, ava, me.name, 72, 170, 132);
    x.fillStyle = C.ink; x.font = font(800, 46);
    x.fillText(lines(x, me.name, 380, 1)[0], 228, 228);
    x.fillStyle = C.muted; x.font = font(500, 28); x.fillText('@' + me.username, 228, 270);
    x.fillStyle = C.ink; x.font = font(800, 54);
    lines(x, 'Зову вести дневник питания вместе', 600, 2).forEach((l, i) => x.fillText(l, 72, 392 + i * 62));
    // факты и кнопка
    const streak = +(me.stats?.streak || 0); let bx = 72;
    const chip = (t, dot) => { x.font = font(700, 24); const w = x.measureText(t).width + (dot ? 64 : 40); rr(x, bx, 512, w, 52, 26); x.fillStyle = C.card; x.fill(); x.strokeStyle = C.rule; x.lineWidth = 2; x.stroke();
      if (dot) { x.fillStyle = dot; x.beginPath(); x.arc(bx + 28, 538, 8, 0, 7); x.fill(); } x.fillStyle = C.ink; x.fillText(t, bx + (dot ? 46 : 20), 547); bx += w + 12; };
    if (streak > 1) chip(`${streak} ${S().plural(streak, 'день', 'дня', 'дней')} подряд`, C.streak);
    chip('КБЖУ по фото', C.ok);
    // справа — карточка блюда, как в приложении
    x.save(); x.shadowColor = 'rgba(20,22,28,.12)'; x.shadowBlur = 40; x.shadowOffsetY = 14; rr(x, 724, 72, 404, 486, 34); x.fillStyle = C.card; x.fill(); x.restore();
    x.save(); rr(x, 724, 72, 404, 286, [34, 34, 0, 0]); x.clip();
    if (food) cover(x, food, 724, 72, 404, 286); else { x.fillStyle = C.paper2; x.fillRect(724, 72, 404, 286); x.fillStyle = C.rule; x.beginPath(); x.arc(926, 215, 92, 0, 7); x.fill(); x.fillStyle = C.card; x.beginPath(); x.arc(926, 215, 64, 0, 7); x.fill(); }
    x.restore();
    x.fillStyle = C.ink2; x.font = font(600, 24); x.fillText(lines(x, meal.title, 350, 1)[0], 752, 400);
    x.fillStyle = C.ink; x.font = font(800, 58); const k = nf(meal.kcal); x.fillText(k, 752, 466);
    const kw = x.measureText(k).width; x.fillStyle = C.muted; x.font = font(600, 26); x.fillText('ккал', 752 + kw + 10, 466);
    macroBar(x, meal, 752, 488, 348, 12);
    macroRow(x, meal, 752, 536, 22);
    return out(c);
  }

  async function postCard(post) {
    await fonts();
    const [c, x] = canvas(1200, 630), m = post.meta || {};
    const pics = (post.gallery?.length ? post.gallery : [post.media]).slice(0, 4);
    const [ava, ...imgs] = await Promise.all([loadImg(post.author?.avatar), ...pics.map(loadImg)]);
    x.fillStyle = C.paper; x.fillRect(0, 0, 1200, 630);
    // фото — слева на всю высоту; у «дня» — коллаж 2×2
    const ok = imgs.filter(Boolean);
    if (ok.length >= 4) ok.slice(0, 4).forEach((im, i) => cover(x, im, (i % 2) * 316, Math.floor(i / 2) * 316, 314, 314));
    else if (ok.length >= 2) ok.slice(0, 2).forEach((im, i) => cover(x, im, 0, i * 316, 630, 314));
    else if (ok[0]) cover(x, ok[0], 0, 0, 630, 630);
    else { x.fillStyle = C.paper2; x.fillRect(0, 0, 630, 630); }
    const X = 690, W = 450;
    avatar(x, ava, post.author?.name, X, 64, 56);
    x.fillStyle = C.ink; x.font = font(700, 26); x.fillText(lines(x, post.author?.name || '', W - 72, 1)[0], X + 72, 92);
    x.fillStyle = C.muted; x.font = font(500, 20); x.fillText(m.day ? 'мой день в Healthy Fit' : 'делится едой', X + 72, 118);
    x.fillStyle = C.ink; x.font = font(800, 44);
    const tl = lines(x, m.title || 'Блюдо', W, 2); tl.forEach((l, i) => x.fillText(l, X, 214 + i * 52));
    const ky = 214 + tl.length * 52 + 92;
    x.font = font(800, 104); const k = nf(m.kcal); x.fillText(k, X - 4, ky);
    const kw = x.measureText(k).width; x.fillStyle = C.muted; x.font = font(600, 32); x.fillText('ккал', X + kw + 10, ky);
    macroBar(x, m, X, ky + 30, W, 14);
    macroRow(x, m, X, ky + 84, 26);
    logo(x, X, 540, 40);
    x.fillStyle = C.muted; x.font = font(500, 20); x.fillText('КБЖУ по фото', X + 220, 567);
    return out(c);
  }

  // вертикальная картинка 4:5 — для сторис и ленты в Telegram / Instagram
  async function storyCard(post) {
    await fonts();
    const [c, x] = canvas(1080, 1350), m = post.meta || {};
    const pics = (post.gallery?.length ? post.gallery : [post.media]).slice(0, 4);
    const [ava, ...imgs] = await Promise.all([loadImg(post.author?.avatar), ...pics.map(loadImg)]);
    x.fillStyle = C.paper; x.fillRect(0, 0, 1080, 1350);
    x.save(); rr(x, 40, 40, 1000, 860, 48); x.clip();
    const ok = imgs.filter(Boolean);
    if (ok.length >= 4) ok.slice(0, 4).forEach((im, i) => cover(x, im, 40 + (i % 2) * 502, 40 + Math.floor(i / 2) * 432, 498, 428));
    else if (ok[0]) cover(x, ok[0], 40, 40, 1000, 860); else { x.fillStyle = C.paper2; x.fillRect(40, 40, 1000, 860); }
    x.restore();
    // автор — плашкой поверх фото
    x.font = font(700, 30); const nw = Math.min(560, x.measureText(post.author?.name || '').width);
    rr(x, 72, 72, nw + 112, 72, 36); x.fillStyle = 'rgba(255,255,255,.92)'; x.fill();
    avatar(x, ava, post.author?.name, 80, 80, 56); x.fillStyle = C.ink; x.fillText(lines(x, post.author?.name || '', 560, 1)[0], 152, 118);
    x.fillStyle = C.ink2; x.font = font(600, 36); x.fillText(lines(x, m.title || 'Блюдо', 1000, 1)[0], 72, 980);
    x.fillStyle = C.ink; x.font = font(800, 132); const k = nf(m.kcal); x.fillText(k, 66, 1112);
    const kw = x.measureText(k).width; x.fillStyle = C.muted; x.font = font(600, 40); x.fillText('ккал', 66 + kw + 14, 1112);
    macroBar(x, m, 72, 1146, 936, 16);
    macroRow(x, m, 72, 1214, 32);
    logo(x, 72, 1258, 48);
    x.fillStyle = C.muted; x.font = font(500, 26); x.textAlign = 'right'; x.fillText(location.host, 1008, 1292); x.textAlign = 'left';
    return out(c);
  }

  const upload = async dataUrl => (await S().api('/api/media', { method: 'POST', body: { data: dataUrl } })).id;
  const dataToFile = (d, name) => { const [h, b] = d.split(','), bin = atob(b), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], name, { type: /:(.*?);/.exec(h)[1] }); };

  /* ---------- кнопки мессенджеров ---------- */
  const APPS = [
    { id: 'tg', label: 'Telegram', ico: 'i-tg', url: (u, t) => `https://t.me/share/url?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
    { id: 'wa', label: 'WhatsApp', ico: 'i-wa', url: (u, t) => `https://wa.me/?text=${encodeURIComponent(t + '\n' + u)}` },
    { id: 'vk', label: 'ВКонтакте', ico: 'i-vk', url: (u, t) => `https://vk.com/share.php?url=${encodeURIComponent(u)}&title=${encodeURIComponent(t)}` },
  ];
  const canFiles = () => { try { return !!navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.jpg', { type: 'image/jpeg' })] }); } catch { return false; } };
  // ряд кнопок; get() отдаёт { url, text, image? } — ссылка и карточка готовятся при первом касании
  function appsRow(get, opts = {}) {
    const row = document.createElement('div'); row.className = 'ext-row'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Поделиться в приложениях');
    const items = [...APPS.map(a => ({ ...a, go: async () => { const d = await get(); open(a.url(d.url, d.text), '_blank', 'noopener'); } }))];
    if (opts.image && canFiles()) items.push({ id: 'img', label: 'Картинкой', ico: 'i-image', go: async () => { const d = await get(true); if (!d.image) throw new Error('Не получилось собрать картинку');
      await navigator.share({ files: [dataToFile(d.image, 'healthy-fit.jpg')], text: `${d.text}\n${d.url}` }); } });
    if (navigator.share) items.push({ id: 'more', label: 'Ещё', ico: 'i-dots-h', go: async () => { const d = await get(); await navigator.share({ title: 'Healthy Fit', text: d.text, url: d.url }); } });
    items.push({ id: 'copy', label: 'Ссылка', ico: 'i-link', go: async () => { const d = await get(); await copy(d.url); HF.toast('Ссылка скопирована'); } });
    for (const a of items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = `ext-app ext-${a.id}`;
      b.innerHTML = `<span class="ext-ico"><svg aria-hidden="true"><use href="#${a.ico}"/></svg></span><span>${a.label}</span>`;
      b.onclick = async () => {
        if (b.classList.contains('busy')) return; b.classList.add('busy');
        try { await a.go(); opts.done?.(a.id); }
        catch (e) { if (e?.name !== 'AbortError') HF.toast(e.message || 'Не получилось'); }
        finally { b.classList.remove('busy'); }
      };
      row.appendChild(b);
    }
    return row;
  }
  async function copy(t) {
    try { await navigator.clipboard.writeText(t); return; } catch {}
    const i = document.createElement('textarea'); i.value = t; i.setAttribute('readonly', ''); i.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(i); i.select();
    try { document.execCommand('copy'); } finally { i.remove(); }
  }

  /* ---------- приглашение ---------- */
  let inv = null;
  async function openInvite() {
    const me = S()?.me; if (!me) { HF.showTab('chats'); HF.toast('Сначала войдите или создайте аккаунт'); return; }
    const sheet = $('#inviteSheet'), img = $('#invCard');
    img.removeAttribute('src'); img.parentElement.classList.add('loading');
    $('#invLink').textContent = '…'; $('#invJoined').hidden = true;
    const box = $('#invApps'); box.innerHTML = '';
    HF.openDialog(sheet);
    let ready;
    const prep = async () => {
      if (!inv) inv = await S().api('/api/invite');
      const url = `${location.origin}/i/${inv.code}`;
      $('#invLink').textContent = url.replace(/^https?:\/\//, '');
      if (inv.joined) { $('#invJoined').hidden = false; $('#invJoined').textContent = `По вашей ссылке пришли: ${inv.joined} ${S().plural(inv.joined, 'человек', 'человека', 'человек')}`; }
      // карточку собираем на телефоне и кладём на сервер — по ней Telegram и WhatsApp рисуют превью
      const card = await profileCard(me); img.src = card; img.parentElement.classList.remove('loading');
      try { const id = await upload(card); const r = await S().api('/api/me/og', { method: 'POST', body: { media: id } }); inv.og = r.og; } catch {}
      return { url, text: `${me.name} зовёт вас в Healthy Fit — КБЖУ по фото за пару секунд. Откройте ссылку — и мы сразу друзья 👇` };
    };
    ready = prep().catch(e => { HF.toast(e.message); throw e; });
    box.appendChild(appsRow(() => ready));
    $('#invCopy').onclick = async () => { const d = await ready; await copy(d.url); HF.toast('Ссылка скопирована'); };
    $('#invReset').onclick = async () => {
      if (!confirmReset()) return;
      try { const r = await S().api('/api/invite/reset', { method: 'POST' }); inv = { ...(inv || {}), code: r.code }; HF.toast('Старая ссылка больше не работает'); HF.closeDialog(sheet); openInvite(); } catch (e) { HF.toast(e.message); }
    };
  }
  // двойное касание вместо системного confirm(): второй тап в течение 3 с подтверждает
  let resetArm = 0;
  function confirmReset() {
    const b = $('#invReset');
    if (Date.now() - resetArm < 3000) { resetArm = 0; b.textContent = 'Сменить ссылку'; return true; }
    resetArm = Date.now(); b.textContent = 'Нажмите ещё раз — старая перестанет работать';
    setTimeout(() => { if (resetArm && Date.now() - resetArm >= 2900) { resetArm = 0; b.textContent = 'Сменить ссылку'; } }, 3100);
    return false;
  }

  /* ---------- публикация наружу ---------- */
  // ссылка на пост несёт и код автора ссылки: зарегистрировался — сразу друг того, кто поделился
  const postCache = new Map();
  function postGetter(post) {
    let p = postCache.get(post.id);
    return async wantImage => {
      if (!p) {
        p = (async () => {
          if (!inv) inv = await S().api('/api/invite');
          const card = await postCard(post);
          const id = await upload(card); await S().api(`/api/posts/${post.id}/og`, { method: 'POST', body: { media: id } });
          const m = post.meta || {};
          return { url: `${location.origin}/p/${post.id}?r=${inv.code}`, text: `${m.title || 'Моя еда'} — ${nf(m.kcal)} ккал · Б ${nf(m.p)} Ж ${nf(m.f)} У ${nf(m.c)}. Считаю КБЖУ по фото в Healthy Fit` };
        })();
        postCache.set(post.id, p); p.catch(() => postCache.delete(post.id));
      }
      const d = await p;
      if (wantImage && !d.image) d.image = await storyCard(post);
      return d;
    };
  }
  const canShareOut = post => post && (post.mine || post.vis === 'public');

  window.HFShare = { openInvite, appsRow, postGetter, canShareOut, afterAuth, guestInfo, profileCard, postCard, storyCard, pending };
})();
