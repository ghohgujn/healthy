// Healthy Fit — соцслой: аккаунт, друзья, мессенджер (текст, еда, голосовые, кружки), «поделиться», «Здоровье», облачная копия.
(() => {
  'use strict';
  const HF = window.HF; if (!HF) return;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const DEMO = !!(window.KBJU_CONFIG && window.KBJU_CONFIG.demo);

  let me = null, friends = [], incoming = [], sent = [], chats = [], tab = 'today';

  // В превью без сервера подключается внешняя заглушка (demo/mock-api.js); в проекте её нет.
  const mock = window.HFMockApi || null;

  async function api(path, opts = {}) {
    if (mock) return mock(path, opts);
    const o ={ method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body instanceof Blob) { o.body = opts.body; o.headers['Content-Type'] = opts.body.type; }
    else if (opts.body !== undefined) { o.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body); o.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(path, o);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Нет связи с сервером'), { status: r.status });
    return data;
  }
  const ava = (el, u) => {
    if (u?.avatar) { el.style.backgroundImage = `url("${u.avatar}")`; el.textContent = ''; }
    else { el.style.backgroundImage = ''; el.textContent = (u?.name || '?').trim().charAt(0).toUpperCase(); }
    return el;
  };
  const avaHTML = (u, cls = '') => u?.avatar ? `<span class="avatar ${cls}" style="background-image:url('${esc(u.avatar)}')"></span>` : `<span class="avatar ${cls}">${esc((u?.name || '?').charAt(0).toUpperCase())}</span>`;
  const flameBadge = f => !f || f.state === 'none' ? '' :
    `<i class="flame-b ${f.state}" title="${f.state === 'out' ? 'Огонёк погас' : f.state === 'risk' ? 'Напишите друг другу сегодня' : 'Огонёк дружбы'}"><svg><use href="#i-flame"/></svg>${f.count}</i>`;
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const timeAgo = t => {
    const d = new Date(t), n = new Date();
    if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  };
  const preview = m => !m ? '' : m.kind === 'text' ? m.body : m.kind === 'meal' ? `Еда: ${m.meta?.title || 'блюдо'} · ${Math.round(m.meta?.kcal || 0)} ккал`
    : m.kind === 'voice' ? 'Голосовое сообщение' : m.kind === 'video' ? 'Видеосообщение' : 'Фото';

  /* ================= account ================= */
  async function boot() {
    if (DEMO) { try { me = (await api('/api/me')).me; } catch { me = null; } renderAuth(); renderAccountCard(); renderHealthCard(); if (me) refreshSocial(); return; }
    try { me = (await api('/api/me')).me; } catch { me = null; }
    renderAuth(); renderAccountCard(); renderHealthCard();
    if (me) { refreshSocial(); pullHealth(); restoreIfEmpty(); }
  }
  function renderAuth() {
    $('#socialBox').hidden = !me;
    const box = $('#authBox');
    if (me) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="card auth">
      <p class="h2">Друзья и чаты</p>
      <p class="sub">Создайте аккаунт, чтобы находить друзей, делиться едой, отправлять голосовые и кружки. Дневник останется на телефоне и будет копироваться в облако.</p>
      <div class="seg" role="radiogroup" aria-label="Режим"><button data-mode="reg" aria-checked="true">Регистрация</button><button data-mode="login" aria-checked="false">Вход</button></div>
      <form id="authForm" class="auth-form" novalidate>
        <label class="field" data-only="reg"><span class="field-label">Имя</span><input class="input" name="name" maxlength="30" autocomplete="given-name"></label>
        <label class="field"><span class="field-label">Логин</span><input class="input" name="username" maxlength="20" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="латиница, цифры, _ ."></label>
        <label class="field"><span class="field-label">Пароль</span><input class="input" name="password" type="password" minlength="6" autocomplete="new-password"></label>
        <p class="form-err" id="authErr" role="alert"></p>
        <button class="btn btn-primary" type="submit" id="authSubmit">Создать аккаунт</button>
      </form>
    </div>`;
    let mode = 'reg';
    box.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
      mode = b.dataset.mode;
      box.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
      box.querySelector('[data-only="reg"]').hidden = mode !== 'reg';
      box.querySelector('[name=password]').autocomplete = mode === 'reg' ? 'new-password' : 'current-password';
      $('#authSubmit').textContent = mode === 'reg' ? 'Создать аккаунт' : 'Войти';
    });
    $('#authForm').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target), btn = $('#authSubmit');
      if (!f.get('name') && HF.db.profile.name && mode === 'reg') f.set('name', HF.db.profile.name);
      btn.disabled = true; $('#authErr').textContent = '';
      try {
        const r = await api(mode === 'reg' ? '/api/auth/register' : '/api/auth/login', { method: 'POST',
          body: { name: f.get('name'), username: f.get('username'), password: f.get('password') } });
        me = r.me; HF.toast(mode === 'reg' ? `Добро пожаловать, ${me.name}!` : 'Вы вошли');
        if (mode === 'reg') await pushProfile(); else await restoreIfEmpty(true);
        boot();
      } catch (err) { $('#authErr').textContent = err.message; }
      finally { btn.disabled = false; }
    };
  }
  async function pushProfile() {
    if (!me) return;
    const p = HF.db.profile, body = { name: p.name || me.name, stats: stats() };
    if (p.avatar && !me.avatar) {
      try { const blob = await (await fetch(p.avatar)).blob(); const up = await api('/api/media', { method: 'POST', body: blob }); body.avatar = up.id; } catch {}
    }
    try { me = { ...me, ...(await api('/api/me', { method: 'PATCH', body })).me }; } catch {}
  }
  function stats() {
    const s = HF.streakInfo(), d = new Date(); let w = 0;
    for (let i = 0; i < 30; i++) { const k = HF.keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i)); if (HF.db.days[k]?.acts?.length) w++; }
    return { streak: s.count, workouts30: w, goal: HF.db.profile.goal };
  }
  function renderAccountCard() {
    const c = $('#accountCard'); if (!c) return;
    if (!me) { c.innerHTML = `<h2 class="h2">Аккаунт</h2><p class="sub">Войдите, чтобы дружить, переписываться и хранить копию дневника в облаке.</p><button class="btn btn-ghost" id="goAuth">Войти или создать</button>`;
      $('#goAuth').onclick = () => HF.showTab('chats'); return; }
    c.innerHTML = `<div class="row-between"><div><h2 class="h2">Аккаунт</h2><p class="sub" id="syncInfo">Копия дневника в облаке включена</p></div>
      <button class="btn btn-ghost btn-sm" id="logoutBtn">Выйти</button></div>
      <label class="field"><span class="field-label">Короткое имя — по нему вас находят друзья</span>
        <span class="uname"><span>@</span><input class="input" id="unameInput" maxlength="20" autocapitalize="none" spellcheck="false" autocomplete="username" value="${esc(me.username)}"></span></label>
      <p class="sub small" id="unameHint"></p>`;
    const ui = $('#unameInput');
    ui.addEventListener('input', () => checkName(ui.value, $('#unameHint'), me.username));
    ui.addEventListener('change', async () => {
      const v = ui.value.trim(); if (!v || v === me.username) return;
      try { me = { ...me, ...(await api('/api/me', { method: 'PATCH', body: { username: v } })).me }; HF.toast(`Теперь вы @${me.username}`); $('#unameHint').textContent = ''; }
      catch (e) { HF.toast(e.message); ui.value = me.username; $('#unameHint').textContent = ''; }
    });
    $('#logoutBtn').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} me = null; boot(); HF.toast('Вы вышли'); };
  }

  let checkT;
  function checkName(v, hintEl, current) {
    clearTimeout(checkT); v = v.trim();
    if (!v || v === current) { hintEl.textContent = ''; hintEl.className = 'sub small'; return Promise.resolve(null); }
    return new Promise(res => { checkT = setTimeout(async () => {
      try { const r = await api('/api/auth/check?username=' + encodeURIComponent(v));
        hintEl.textContent = r.available ? `@${v} свободно` : (r.reason || `@${v} уже занято`); hintEl.className = 'sub small ' + (r.available ? 'ok' : 'bad'); res(r.available); }
      catch { hintEl.textContent = ''; res(null); } }, 350); });
  }

  /* profile → server: имя/аватар/статистика */
  let pushT;
  function schedulePush() { clearTimeout(pushT); pushT = setTimeout(pushProfile, 4000); }
  $('#nameInput')?.addEventListener('change', schedulePush);
  $('#avatarInput')?.addEventListener('change', () => setTimeout(async () => {
    if (!me || !HF.db.profile.avatar) return;
    try { const blob = await (await fetch(HF.db.profile.avatar)).blob(); const up = await api('/api/media', { method: 'POST', body: blob });
      me = (await api('/api/me', { method: 'PATCH', body: { avatar: up.id } })).me; } catch {}
  }, 600));

  /* ================= cloud backup ================= */
  let syncT;
  function onSave() { if (!me || DEMO) return; clearTimeout(syncT); syncT = setTimeout(syncUp, 5000); schedulePush(); }
  async function syncUp() {
    try { await api('/api/sync', { method: 'PUT', body: JSON.stringify(HF.db) }); const el = $('#syncInfo'); if (el) el.textContent = `Копия сохранена ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`; } catch {}
  }
  async function restoreIfEmpty(ask) {
    const local = Object.values(HF.db.days).reduce((a, d) => a + (d.meals?.length || 0), 0);
    try {
      const r = await api('/api/sync'); if (!r.data) { if (local) syncUp(); return; }
      const remoteMeals = Object.values(r.data.days || {}).reduce((a, d) => a + (d.meals?.length || 0), 0);
      if (!local || (ask && remoteMeals > local)) {
        const next = HF.validDb(r.data); if (!next) return;
        const prev = HF.db; HF.db = next; HF.save(); HF.render();
        HF.toast(`Дневник восстановлен из облака: ${remoteMeals} приёмов`, local ? 'Отменить' : null, () => { HF.db = prev; HF.save(); HF.render(); }, 8000);
      }
    } catch {}
  }

  /* ================= «Здоровье» ================= */
  async function pullHealth() {
    if (!me) return;
    try {
      const from = HF.keyOf(new Date(Date.now() - 60 * 864e5));
      const r = await api('/api/health?from=' + from);
      HF.db.health ||= {};
      for (const d of r.days) HF.db.health[d.date] = { steps: d.steps || 0, active_kcal: d.active_kcal || 0 };
      HF.save(); HF.render();
    } catch {}
  }
  setInterval(() => { if (me && !document.hidden) pullHealth(); }, 10 * 60 * 1000);
  function renderHealthCard() {
    const c = $('#healthCard'); if (!c) return;
    const days = Object.keys(HF.db.health || {}).sort(), last = days[days.length - 1];
    c.innerHTML = `<div class="row-between"><div><h2 class="h2">«Здоровье» и браслеты</h2>
      <p class="sub">${last ? `Последние данные: ${new Date(last + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : 'Шаги и активные калории — автоматически'}</p></div>
      <button class="btn btn-ghost btn-sm" id="healthOpen">${last ? 'Настроить' : 'Подключить'}</button></div>`;
    $('#healthOpen').onclick = openHealth;
  }
  async function openHealth() {
    const g = $('#healthGuide');
    if (!me) { g.innerHTML = `<p>Чтобы телефон присылал шаги и калории, нужен аккаунт: так данные попадут именно к вам.</p><button class="btn btn-primary" id="hgAuth">Войти или создать аккаунт</button>`;
      HF.openDialog($('#healthSheet')); $('#hgAuth').onclick = () => { HF.closeDialog($('#healthSheet')); HF.showTab('chats'); }; return; }
    let token = me.healthToken;
    if (!token) { try { token = (await api('/api/me')).me.healthToken; me.healthToken = token; } catch {} }
    const url = `${location.origin}/api/health/ingest?t=${token}`;
    g.innerHTML = `
      <p class="sub">Ваш личный адрес для отправки данных. Никому его не показывайте.</p>
      <div class="copy-row"><code id="hgUrl">${esc(url)}</code><button class="btn btn-ghost btn-sm" id="hgCopy">Копировать</button></div>
      <details class="hg" open><summary>iPhone — «Быстрые команды»</summary><ol>
        <li>Откройте «Команды» → <b>+</b> → «Добавить действие» → <b>Найти образцы здоровья</b>: тип «Шаги», дата «Сегодня», группировать «День».</li>
        <li>Добавьте <b>Вычислить статистику</b> → «Сумма» — получится число шагов.</li>
        <li>Повторите для типа <b>«Активная энергия»</b> (тоже «Сумма»).</li>
        <li>Добавьте <b>Получить содержимое URL</b>: вставьте адрес выше, метод <b>POST</b>, тело <b>JSON</b>, поля: <code>steps</code> = сумма шагов, <code>active_kcal</code> = сумма энергии.</li>
        <li>Вкладка «Автоматизация» → «Время суток» → каждые несколько часов (например, 12:00, 18:00, 23:30) → «Запускать сразу» → выберите эту команду.</li>
      </ol></details>
      <details class="hg"><summary>Android — Health Connect</summary><ol>
        <li>Убедитесь, что шагомер (Google Fit, Samsung Health, Mi Fitness, Zepp и т.п.) пишет данные в <b>Health Connect</b>.</li>
        <li>Установите открытое приложение <b>HC Webhook</b> (GitHub: mcnaveen/health-connect-webhook).</li>
        <li>Дайте доступ к «Шагам» и «Активным калориям», вставьте адрес выше как Webhook URL, интервал — 1–3 часа.</li>
      </ol></details>
      <p class="sub small">Активные калории из «Здоровья» уже включают тренировки с часов, поэтому за день учитывается большее: они или ваши отметки в календаре.</p>
      <div class="row-btns"><button class="btn btn-ghost btn-sm" id="hgPull">Обновить сейчас</button><button class="btn btn-ghost btn-sm" id="hgRotate">Сменить адрес</button></div>`;
    HF.openDialog($('#healthSheet'));
    $('#hgCopy').onclick = async () => { try { await navigator.clipboard.writeText(url); HF.toast('Скопировано'); } catch { getSelection().selectAllChildren($('#hgUrl')); } };
    $('#hgPull').onclick = async () => { await pullHealth(); renderHealthCard(); HF.toast('Данные обновлены'); };
    $('#hgRotate').onclick = async () => { try { me.healthToken = (await api('/api/me/health-token', { method: 'POST' })).healthToken; HF.closeDialog($('#healthSheet')); openHealth(); HF.toast('Адрес сменён — обновите его в команде'); } catch (e) { HF.toast(e.message); } };
  }

  /* ================= friends & inbox ================= */
  async function refreshSocial() {
    if (!me) return;
    try {
      const [f, c] = await Promise.all([api('/api/friends'), api('/api/chats')]);
      friends = f.friends; incoming = f.incoming; sent = f.sent; chats = c.chats;
      const b = $('#chatBadge'); b.hidden = !(c.unreadTotal + incoming.length); b.textContent = c.unreadTotal + incoming.length;
      if (tab === 'chats') renderInbox();
    } catch (e) { if (e.status === 401) { me = null; boot(); } }
  }
  setInterval(() => { if (me && !document.hidden && $('#chat').hidden) refreshSocial(); }, 15000);

  function renderInbox() {
    const row = $('#friendRow');
    row.innerHTML = friends.length ? '' : `<p class="sub friend-empty">Найдите друзей по логину через поиск выше.</p>`;
    for (const u of friends) {
      const b = document.createElement('button'); b.className = 'friend';
      b.innerHTML = `${avaHTML(u, 'friend-ava')}<span>${esc(u.name)}</span>${u.flame && u.flame.state !== 'none' ? `<span class="mini-flame">${flameBadge(u.flame)}</span>` : ''}`;
      b.onclick = () => openChat(u);
      row.appendChild(b);
    }
    const rq = $('#requests');
    rq.innerHTML = incoming.length ? `<h2 class="h2 list-title">Заявки в друзья</h2>` : '';
    for (const u of incoming) {
      const d = document.createElement('div'); d.className = 'req';
      d.innerHTML = `${avaHTML(u)}<span class="req-who"><b>${esc(u.name)}</b><small>@${esc(u.username)}</small></span>
        <button class="btn btn-primary btn-sm" data-a="yes">Принять</button><button class="icon-btn" data-a="no" aria-label="Отклонить"><svg><use href="#i-x"/></svg></button>`;
      d.querySelector('[data-a=yes]').onclick = async () => { await api(`/api/friends/${u.id}`, { method: 'POST' }).catch(e => HF.toast(e.message)); HF.toast(`${u.name} теперь в друзьях`); refreshSocial(); };
      d.querySelector('[data-a=no]').onclick = async () => { await api(`/api/friends/${u.id}`, { method: 'DELETE' }).catch(() => {}); refreshSocial(); };
      rq.appendChild(d);
    }
    const list = $('#chatList'); list.innerHTML = '';
    if (!chats.length) list.innerHTML = `<li class="sub chat-empty">Пока нет сообщений. Сфотографируйте еду и нажмите «Поделиться» — или откройте друга сверху.</li>`;
    for (const c of chats) {
      const li = document.createElement('li'), b = document.createElement('button'); b.className = 'chat-row' + (c.unread ? ' unread' : '');
      b.innerHTML = `${avaHTML(c.peer)}<span class="cr-main"><b>${esc(c.peer.name)} ${flameBadge(c.peer.flame)}</b><small>${c.last.from === me.id ? 'Вы: ' : ''}${esc(preview(c.last))}</small></span>
        <span class="cr-side"><small>${timeAgo(c.last.created)}</small>${c.unread ? `<i class="dot">${c.unread}</i>` : ''}</span>`;
      b.onclick = () => openChat(c.peer);
      li.appendChild(b); list.appendChild(li);
    }
  }
  let searchT;
  $('#userSearch').addEventListener('input', e => {
    clearTimeout(searchT);
    const term = e.target.value.trim();
    $('#socialMain').hidden = !!term; $('#searchResults').hidden = !term;
    if (!term) return;
    searchT = setTimeout(async () => {
      const box = $('#searchResults');
      try {
        const { users } = await api('/api/users?q=' + encodeURIComponent(term));
        box.innerHTML = users.length ? '' : `<p class="sub">Никого не нашли. Проверьте логин.</p>`;
        for (const u of users) {
          const d = document.createElement('div'); d.className = 'req';
          const label = { none: 'Добавить', sent: 'Заявка отправлена', incoming: 'Принять', friends: 'Написать' }[u.state];
          d.innerHTML = `${avaHTML(u)}<span class="req-who"><b>${esc(u.name)}</b><small>@${esc(u.username)}${u.stats?.streak ? ` · серия ${u.stats.streak}` : ''}</small></span>
            <button class="btn ${u.state === 'sent' ? 'btn-ghost' : 'btn-primary'} btn-sm" ${u.state === 'sent' ? 'disabled' : ''}>${label}</button>`;
          d.querySelector('button').onclick = async () => {
            if (u.state === 'friends') { openChat(u); return; }
            try { const r = await api(`/api/friends/${u.id}`, { method: 'POST' }); u.state = r.state;
              HF.toast(r.state === 'friends' ? `${u.name} теперь в друзьях` : 'Заявка отправлена'); e.target.dispatchEvent(new Event('input')); refreshSocial(); }
            catch (err) { HF.toast(err.message); }
          };
          box.appendChild(d);
        }
      } catch (err) { box.innerHTML = `<p class="sub">${esc(err.message)}</p>`; }
    }, 300);
  });

  /* ================= chat ================= */
  const chatEl = $('#chat');
  let peer = null, lastId = 0, chatPoll = null, peerRead = 0;
  async function openChat(u) {
    peer = u; lastId = 0; peerRead = 0;
    ava($('#chatAva'), u); $('#chatName').textContent = u.name; $('#chatSub').textContent = '@' + u.username; $('#flameBanner').hidden = true;
    $('#msgs').innerHTML = ''; $('#msgInput').value = ''; updateSendBtn();
    HF.openDialog(chatEl, '#msgInput');
    await loadMsgs();
    clearInterval(chatPoll); chatPoll = setInterval(() => { if (!document.hidden) loadMsgs(); }, 3000);
  }
  function closeChat() { clearInterval(chatPoll); if (R) recFinish(false); HF.closeDialog(chatEl); peer = null; refreshSocial(); }
  $('#chatBack').onclick = closeChat;
  async function loadMsgs() {
    if (!peer) return;
    try {
      const r = await api(`/api/chats/${peer.id}?after=${lastId}`);
      const sc = $('#chatScroll'), atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
      for (const m of r.messages) { appendMsg(m); lastId = Math.max(lastId, m.id); }
      if (r.peerRead !== peerRead) { peerRead = r.peerRead; markRead(); }
      if (!r.friends) $('#chatSub').textContent = 'Вы больше не друзья — писать нельзя'; else renderFlame(r.peer?.flame);
      if (r.messages.length && (atBottom || lastId === r.messages[r.messages.length - 1].id)) sc.scrollTop = sc.scrollHeight;
    } catch {}
  }
  function renderFlame(f) {
    const sub = $('#chatSub'), ban = $('#flameBanner');
    if (!f || f.state === 'none') {
      sub.textContent = '@' + peer.username + (f && f.count ? ` · ${f.count} ${plural(f.count, 'день', 'дня', 'дней')} подряд — ещё ${3 - f.count} до огонька` : '');
      ban.hidden = true; return;
    }
    const days = `${f.count} ${plural(f.count, 'день', 'дня', 'дней')}`;
    sub.innerHTML = f.state === 'active' ? `${flameBadge(f)} огонёк дружбы · ${days}`
      : f.state === 'risk' ? `${flameBadge(f)} ${f.todayMine ? 'ждём ответа сегодня' : 'напишите сегодня, чтобы не погас'}`
      : `${flameBadge(f)} огонёк погас`;
    if (f.state === 'out') {
      ban.hidden = false;
      ban.innerHTML = f.canRestore
        ? `<p><b>Огонёк на ${days} погас.</b> Восстановить можно только один раз.</p><button class="btn btn-primary btn-sm" id="flameRestore">Восстановить</button>`
        : `<p><b>Огонёк погас.</b> Восстановление уже использовано — начните новую серию: пишите друг другу 3 дня подряд.</p>`;
      const b = $('#flameRestore');
      if (b) b.onclick = async () => {
        b.disabled = true;
        try { const r = await api(`/api/friends/${peer.id}/restore`, { method: 'POST' }); renderFlame(r.flame); HF.toast('Огонёк снова горит. Больше восстановить нельзя'); }
        catch (e) { HF.toast(e.message); b.disabled = false; }
      };
    } else ban.hidden = true;
  }
  function markRead() { document.querySelectorAll('.msg.mine').forEach(el => el.classList.toggle('seen', +el.dataset.id <= peerRead)); }
  function appendMsg(m) {
    if (document.querySelector(`.msg[data-id="${m.id}"]`)) return;
    const li = document.createElement('li'), mine = m.from === me.id;
    li.className = `msg ${mine ? 'mine' : 'theirs'} k-${m.kind}`; li.dataset.id = m.id;
    const t = new Date(m.created).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (m.kind === 'text') li.innerHTML = `<div class="bubble"><p></p><time>${t}</time></div>`, li.querySelector('p').textContent = m.body;
    else if (m.kind === 'meal') {
      const x = m.meta || {};
      li.innerHTML = `<div class="bubble meal-msg">${m.media ? `<img src="${esc(m.media)}" alt="" loading="lazy">` : ''}
        <div class="mm-body"><b></b><p class="mm-kcal">${Math.round(x.kcal || 0)} ккал</p>
        <p class="mm-mac"><span style="--c:var(--color-protein)">Б ${Math.round(x.p || 0)}</span><span style="--c:var(--color-fat)">Ж ${Math.round(x.f || 0)}</span><span style="--c:var(--color-carb)">У ${Math.round(x.c || 0)}</span></p>
        ${m.body ? '<p class="mm-note"></p>' : ''}<time>${t}</time></div></div>`;
      li.querySelector('b').textContent = x.title || 'Еда'; if (m.body) li.querySelector('.mm-note').textContent = m.body;
    } else if (m.kind === 'voice') {
      const dur = Math.round(m.meta?.dur || 0);
      li.innerHTML = `<div class="bubble voice"><button class="vplay" aria-label="Воспроизвести"><svg><use href="#i-play"/></svg></button>
        <span class="wave" aria-hidden="true">${Array.from({ length: 22 }, (_, i) => `<i style="height:${30 + Math.abs(Math.sin(m.id * 7 + i * 1.7)) * 70}%"></i>`).join('')}</span>
        <span class="vdur">${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}</span><time>${t}</time></div>`;
      const btn = li.querySelector('.vplay'), audio = new Audio(); audio.preload = 'none'; audio.src = m.media;
      btn.onclick = () => { document.querySelectorAll('audio, video').forEach(a => a !== audio && a.pause()); audio.paused ? audio.play().catch(() => HF.toast('Не удалось воспроизвести')) : audio.pause(); };
      audio.onplay = () => { btn.innerHTML = '<svg><use href="#i-pause"/></svg>'; li.classList.add('playing'); };
      audio.onpause = audio.onended = () => { btn.innerHTML = '<svg><use href="#i-play"/></svg>'; li.classList.remove('playing'); };
      audio.ontimeupdate = () => { const p = audio.duration ? audio.currentTime / audio.duration : 0; li.style.setProperty('--p', p); };
    } else if (m.kind === 'video') {
      li.innerHTML = `<div class="circle-msg"><video playsinline preload="metadata" src="${esc(m.media)}#t=0.1"></video><span class="cm-play"><svg><use href="#i-play"/></svg></span><time>${t}</time></div>`;
      const v = li.querySelector('video'), wrap = li.querySelector('.circle-msg');
      wrap.onclick = () => { document.querySelectorAll('audio, video').forEach(a => a !== v && a.pause()); v.paused ? (v.muted = false, v.play()) : v.pause(); };
      v.onplay = () => wrap.classList.add('playing'); v.onpause = v.onended = () => wrap.classList.remove('playing');
    }
    if (mine) {
      li.addEventListener('contextmenu', e => { e.preventDefault(); delMsg(m.id, li); });
      let lp; li.addEventListener('touchstart', () => { lp = setTimeout(() => delMsg(m.id, li), 650); }, { passive: true });
      li.addEventListener('touchend', () => clearTimeout(lp)); li.addEventListener('touchmove', () => clearTimeout(lp), { passive: true });
    }
    $('#msgs').appendChild(li); markRead();
  }
  async function delMsg(id, li) {
    li.classList.add('del-ask');
    HF.toast('Удалить сообщение у обоих?', 'Удалить', async () => { try { await api(`/api/messages/${id}`, { method: 'DELETE' }); li.remove(); } catch (e) { HF.toast(e.message); } }, 4000);
    setTimeout(() => li.classList.remove('del-ask'), 4000);
  }
  async function sendMsg(payload) {
    if (!peer) return;
    try { const r = await api(`/api/chats/${peer.id}`, { method: 'POST', body: payload }); appendMsg(r.message); lastId = Math.max(lastId, r.message.id);
      $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight; return true; }
    catch (e) { HF.toast(e.message); return false; }
  }
  /* --- composer: одна кнопка как в Telegram ---
     текст есть → отправить; пусто → быстрый тап переключает «голос ↔ кружок»,
     удержание пишет, отпустил — отправилось; влево — отмена; вверх — запись без рук. */
  const pickType = list => (window.MediaRecorder && list.find(t => MediaRecorder.isTypeSupported(t))) || '';
  let recMode = 'voice'; try { recMode = localStorage.getItem('hf.recMode') === 'video' ? 'video' : 'voice'; } catch {}
  let R = null, press = null;
  const sendBtn = $('#sendBtn');
  function updateSendBtn() {
    const has = $('#msgInput').value.trim().length > 0;
    if (R) return;
    sendBtn.innerHTML = `<svg><use href="#${has ? 'i-send' : recMode === 'video' ? 'i-circle' : 'i-mic'}"/></svg>`;
    sendBtn.setAttribute('aria-label', has ? 'Отправить' : recMode === 'video'
      ? 'Видеосообщение: удерживайте, чтобы записать; нажмите, чтобы переключить на голосовое'
      : 'Голосовое: удерживайте, чтобы записать; нажмите, чтобы переключить на кружок');
  }
  $('#msgInput').addEventListener('input', updateSendBtn);
  $('#msgInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } });
  async function sendText() {
    const text = $('#msgInput').value.trim(); if (!text) return;
    $('#msgInput').value = ''; updateSendBtn();
    if (!(await sendMsg({ kind: 'text', body: text }))) { $('#msgInput').value = text; updateSendBtn(); }
  }
  function toggleMode() {
    recMode = recMode === 'voice' ? 'video' : 'voice';
    try { localStorage.setItem('hf.recMode', recMode); } catch {}
    sendBtn.classList.remove('flip'); void sendBtn.offsetWidth; sendBtn.classList.add('flip');
    updateSendBtn();
    let seen = false; try { seen = localStorage.getItem('hf.recHint') === '1'; localStorage.setItem('hf.recHint', '1'); } catch {}
    if (!seen) HF.toast(recMode === 'video' ? 'Кружок: удерживайте кнопку, чтобы записать' : 'Голосовое: удерживайте кнопку, чтобы записать');
  }

  function pressStart(x, y) {
    if ($('#msgInput').value.trim()) return;
    if (R?.locked) { recFinish(true); return; }
    press = { x, y, t: Date.now(), timer: setTimeout(() => { press.held = true; recStart(); }, 220) };
  }
  function pressMove(x, y) {
    if (!press?.held || !R || R.locked) return;
    const dx = x - press.x, dy = y - press.y;
    R.cancelArmed = dx < -90; $('#chat').classList.toggle('rec-cancel', R.cancelArmed);
    if (dy < -70 && !R.cancelArmed) lockRec();
  }
  function pressEnd() {
    if (!press) return;
    clearTimeout(press.timer); const p = press; press = null;
    if (!p.held) { if ($('#msgInput').value.trim()) sendText(); else toggleMode(); return; }
    if (!R || R.locked) return;
    recFinish(!R.cancelArmed);
  }
  sendBtn.addEventListener('pointerdown', e => {
    if ($('#msgInput').value.trim()) return;           // с текстом работает обычный click
    e.preventDefault(); sendBtn.setPointerCapture?.(e.pointerId); pressStart(e.clientX, e.clientY);
  });
  sendBtn.addEventListener('pointermove', e => pressMove(e.clientX, e.clientY));
  sendBtn.addEventListener('pointerup', pressEnd);
  sendBtn.addEventListener('pointercancel', () => { if (press) { clearTimeout(press.timer); if (press.held && R && !R.locked) recFinish(false); press = null; } });
  sendBtn.addEventListener('contextmenu', e => e.preventDefault());
  sendBtn.addEventListener('click', e => { if ($('#msgInput').value.trim()) sendText(); else if (e.detail === 0 && !press) toggleMode(); });
  // клавиатура: пробел — удержание (запись), Enter — переключение / отправка
  sendBtn.addEventListener('keydown', e => { if (e.key === ' ' && !e.repeat && !$('#msgInput').value.trim()) { e.preventDefault(); pressStart(0, 0); } });
  sendBtn.addEventListener('keyup', e => { if (e.key === ' ') { e.preventDefault(); pressEnd(); } });

  function setRecUI(on) {
    const c = $('#chat');
    c.classList.toggle('rec-on', on); c.classList.toggle('rec-voice', on && R?.mode === 'voice'); c.classList.toggle('rec-video', on && R?.mode === 'video');
    if (!on) c.classList.remove('rec-locked', 'rec-cancel');
    $('#recStatus').hidden = !on; $('#msgInput').hidden = on; $('#recTrash').hidden = !(on && R?.locked);
    $('#circleRec').hidden = !(on && R?.mode === 'video');
    if (on) { $('#recTime').textContent = '0:00'; $('#recHint').textContent = '‹ влево — отмена'; setProg(0); }
    if (on && R?.locked) sendBtn.innerHTML = '<svg><use href="#i-send"/></svg>';
    if (!on) updateSendBtn();
  }
  function setProg(p) { const c = $('#circleProg'), len = 2 * Math.PI * 48; c.style.strokeDasharray = len; c.style.strokeDashoffset = len * (1 - Math.min(1, p)); }
  function lockRec() {
    if (!R || R.locked) return;
    R.locked = true; press = null;
    $('#chat').classList.add('rec-locked'); $('#recTrash').hidden = false; $('#recHint').textContent = 'запись без рук';
    sendBtn.innerHTML = '<svg><use href="#i-send"/></svg>'; sendBtn.setAttribute('aria-label', 'Остановить и отправить');
  }

  async function recStart() {
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) { HF.toast('Запись не поддерживается в этом браузере'); return; }
    const r = R = { mode: recMode, chunks: [], locked: false, ready: false, t0: 0 };
    setRecUI(true);
    if (navigator.vibrate) navigator.vibrate(15);
    try {
      r.stream = await navigator.mediaDevices.getUserMedia(r.mode === 'voice'
        ? { audio: { echoCancellation: true, noiseSuppression: true } }
        : { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } });
    } catch {
      if (R === r) { R = null; setRecUI(false); }
      HF.toast(r.mode === 'voice' ? 'Нет доступа к микрофону — разрешите его и удерживайте кнопку ещё раз' : 'Нет доступа к камере — разрешите её и удерживайте кнопку ещё раз');
      return;
    }
    if (R !== r) { r.stream.getTracks().forEach(t => t.stop()); return; }   // отпустили раньше, чем включилась камера
    if (r.mode === 'video') { const v = $('#circleVideo'); v.srcObject = r.stream; v.muted = true; v.play().catch(() => {}); }
    const type = r.mode === 'voice' ? pickType(['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'])
      : pickType(['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
    const opts = type ? (r.mode === 'voice' ? { mimeType: type, audioBitsPerSecond: 48000 } : { mimeType: type, videoBitsPerSecond: 900_000 }) : undefined;
    r.mr = new MediaRecorder(r.stream, opts);
    r.mr.ondataavailable = e => e.data.size && r.chunks.push(e.data);
    r.mr.start(250); r.t0 = Date.now(); r.ready = true;
    const max = r.mode === 'voice' ? 300 : 60;
    r.timer = setInterval(() => {
      const s = (Date.now() - r.t0) / 1000;
      $('#recTime').textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      if (r.mode === 'video') setProg(s / max);
      if (s >= max) recFinish(true);
    }, 100);
  }
  function recFinish(send) {
    const r = R; if (!r) return;
    R = null; clearInterval(r.timer); setRecUI(false);
    const v = $('#circleVideo'); v.pause(); v.srcObject = null;
    if (!r.ready) { r.aborted = true; if (send) HF.toast('Удерживайте кнопку, чтобы записать'); return; }
    r.mr.onstop = async () => {
      r.stream.getTracks().forEach(t => t.stop());
      if (!send) return;
      const dur = (Date.now() - r.t0) / 1000;
      if (dur < 0.8) { HF.toast('Слишком коротко'); return; }
      const blob = new Blob(r.chunks, { type: (r.mr.mimeType || (r.mode === 'voice' ? 'audio/webm' : 'video/webm')).split(';')[0] });
      try { const up = await api('/api/media', { method: 'POST', body: blob }); await sendMsg({ kind: r.mode === 'voice' ? 'voice' : 'video', media: up.id, meta: { dur } }); }
      catch (e) { HF.toast(e.message); }
    };
    try { r.mr.stop(); } catch { r.stream.getTracks().forEach(t => t.stop()); }
  }
  $('#recTrash').onclick = () => recFinish(false);

  /* ================= share (TikTok-style) ================= */
  let shareData = null; const picked = new Set();
  async function shareMeal(d) {
    if (!me) { HF.toast('Войдите, чтобы делиться с друзьями'); HF.showTab('chats'); return; }
    shareData = d; picked.clear(); $('#shareText').value = '';
    $('#sharePreview').innerHTML = `${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : ''}<span><b></b><small>${Math.round(d.totals.kcal)} ккал · Б ${Math.round(d.totals.p)} · Ж ${Math.round(d.totals.f)} · У ${Math.round(d.totals.c)}</small></span>`;
    $('#sharePreview b').textContent = d.name;
    if (!friends.length) await refreshSocial();
    const row = $('#shareFriends'); row.innerHTML = '';
    if (!friends.length) row.innerHTML = `<p class="sub">Пока нет друзей. Найдите их во вкладке «Друзья».</p>`;
    for (const u of friends) {
      const b = document.createElement('button'); b.className = 'share-friend'; b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="sf-ava">${avaHTML(u)}<i class="sf-check"><svg><use href="#i-check"/></svg></i></span><span>${esc(u.name)}</span>`;
      b.onclick = () => { picked.has(u.id) ? picked.delete(u.id) : picked.add(u.id); b.setAttribute('aria-pressed', String(picked.has(u.id)));
        $('#shareSend').disabled = !picked.size; $('#shareSend').textContent = picked.size > 1 ? `Отправить · ${picked.size}` : 'Отправить'; };
      row.appendChild(b);
    }
    $('#shareSend').disabled = true; $('#shareSend').textContent = 'Отправить';
    HF.openDialog($('#shareSheet'));
  }
  $('#shareSend').onclick = async () => {
    const d = shareData; if (!d || !picked.size) return;
    const btn = $('#shareSend'); btn.disabled = true; btn.textContent = 'Отправляю…';
    try {
      let media;
      if (d.thumb) { const blob = await (await fetch(d.thumb)).blob(); media = (await api('/api/media', { method: 'POST', body: blob })).id; }
      const meta = { title: d.name, kcal: d.totals.kcal, p: d.totals.p, f: d.totals.f, c: d.totals.c, items: d.items.map(i => ({ name: i.name, grams: i.grams })) };
      const body = $('#shareText').value.trim();
      for (const id of picked) await api(`/api/chats/${id}`, { method: 'POST', body: { kind: 'meal', media, meta, body } });
      HF.closeDialog($('#shareSheet')); HF.toast(picked.size > 1 ? `Отправлено ${picked.size} друзьям` : 'Отправлено'); refreshSocial();
    } catch (e) { HF.toast(e.message); btn.disabled = false; btn.textContent = 'Отправить'; }
  };

  /* ================= hooks ================= */
  window.HFSocial = {
    onTab(name) { tab = name; if (name === 'chats') { renderAuth(); if (me) { renderInbox(); refreshSocial(); } } if (name === 'profile') { renderAccountCard(); renderHealthCard(); } },
    onSave, shareMeal, checkName,
    get me() { return me; },
    async auth(mode, data) {
      const r = await api(mode === 'reg' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: data });
      me = r.me; if (mode === 'reg') await pushProfile(); else await restoreIfEmpty(true);
      boot(); return me;
    },
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !chatEl.hidden && document.querySelector('.sheet-wrap:not([hidden])') === null) { e.stopPropagation(); if (R) recFinish(false); else closeChat(); } }, true);
  boot();
})();
