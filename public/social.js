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
    // Safari иногда рвёт запрос с Blob в теле («Load failed») — отправляем байтами
    if (opts.body instanceof Blob) { o.body = new Uint8Array(await opts.body.arrayBuffer()); o.headers['Content-Type'] = (opts.body.type || 'application/octet-stream').split(';')[0]; }
    else if (opts.body !== undefined) { o.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body); o.headers['Content-Type'] = 'application/json'; }
    let r;
    for (let attempt = 0; ; attempt++) {
      try { r = await fetch(path, o); break; }
      catch (e) {
        if (attempt < 1 && (o.method === 'GET' || path === '/api/media')) { await new Promise(res => setTimeout(res, 800)); continue; }
        logError(path, e);
        throw Object.assign(new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'), { network: true });
      }
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Нет связи с сервером'), { status: r.status });
    return data;
  }
  function logError(where, e) {
    try { fetch('/api/clientlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true,
      body: JSON.stringify({ where, error: `${e?.name || ''}: ${e?.message || e}` }) }).catch(() => {}); } catch {}
  }
  // фото (data:URL) → сервер JSON-ом: работает одинаково во всех браузерах
  const uploadImage = dataUrl => api('/api/media', { method: 'POST', body: { data: dataUrl } });
  const BOT_AVA = '<svg aria-hidden="true"><use href="#i-spark"/></svg>';
  const ava = (el, u) => {
    el.classList.toggle('bot-ava', !!u?.bot);
    if (u?.bot) { el.style.backgroundImage = ''; el.innerHTML = BOT_AVA; return el; }
    if (u?.avatar) { el.style.backgroundImage = `url("${u.avatar}")`; el.textContent = ''; }
    else { el.style.backgroundImage = ''; el.textContent = (u?.name || '?').trim().charAt(0).toUpperCase(); }
    return el;
  };
  const avaHTML = (u, cls = '') => u?.bot ? `<span class="avatar bot-ava ${cls}">${BOT_AVA}</span>` : u?.avatar ? `<span class="avatar ${cls}" style="background-image:url('${esc(u.avatar)}')"></span>` : `<span class="avatar ${cls}">${esc((u?.name || '?').charAt(0).toUpperCase())}</span>`;
  const flameBadge = f => !f || f.state === 'none' ? '' :
    `<i class="flame-b ${f.state}" title="${f.state === 'out' ? 'Огонёк погас' : f.state === 'risk' ? 'Напишите друг другу сегодня' : 'Огонёк дружбы'}"><svg><use href="#i-flame"/></svg>${f.count}</i>`;
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const timeAgo = t => {
    const d = new Date(t), n = new Date();
    if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  };
  const preview = m => !m ? '' : m.kind === 'text' ? m.body : m.kind === 'post' ? `Публикация: ${m.meta?.title || 'блюдо'}` : m.kind === 'meal' ? `Еда: ${m.meta?.title || 'блюдо'} · ${Math.round(m.meta?.kcal || 0)} ккал`
    : m.kind === 'voice' ? 'Голосовое сообщение' : m.kind === 'video' ? 'Видеосообщение' : 'Фото';

  /* ================= account ================= */
  async function boot() {
    if (DEMO) { try { me = (await api('/api/me')).me; } catch { me = null; } if (me && !HF.db.profile.name && me.name) { HF.db.profile.name = me.name; HF.save(); HF.render(); } renderAuth(); renderAccountCard(); renderHealthCard(); if (me) refreshSocial(); return; }
    try { me = (await api('/api/me')).me; } catch { me = null; }
    // имя из аккаунта, если в профиле на телефоне его ещё нет
    if (me && !HF.db.profile.name && me.name) { HF.db.profile.name = me.name; HF.save(); HF.render(); }
    renderAuth(); renderAccountCard(); renderHealthCard();
    if (me) { await refreshSocial(); pullHealth(); restoreIfEmpty(); syncPush(true); route(); }
    renderPushUI();
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
        if (mode === 'reg') { claimDiary(); await pushProfile(); maybeOfferInstall(1200); } else await restoreIfEmpty();
        boot();
      } catch (err) { $('#authErr').textContent = err.message; }
      finally { btn.disabled = false; }
    };
  }
  async function pushProfile() {
    if (!me) return;
    const p = HF.db.profile, body = { name: p.name || me.name, stats: stats() };
    if (p.avatar && !me.avatar) {
      try { body.avatar = (await uploadImage(p.avatar)).id; } catch (e) { logError('avatar', e); }
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
      <p class="sub small" id="unameHint"></p>
      <label class="push-row share-sum"><div><b>Друзья видят мою сводку</b><p class="sub small">Калории и БЖУ за сегодня — только друзьям</p></div>
        <input type="checkbox" class="switch" id="shareSummary" ${me.shareSummary === false ? '' : 'checked'}></label>
      <div id="myCoachRow"></div>
      ${me.admin ? '<div class="push-row"><div><b>Админ-панель</b><p class="sub small">Пользователи, разбор ошибок, скорость нейросети</p></div><button class="btn btn-ghost btn-sm" id="adminOpen">Открыть</button></div>' : ''}
      ${canOfferInstall() ? '<div class="push-row"><div><b>Приложение на экране «Домой»</b><p class="sub small">Быстрый запуск и уведомления</p></div><button class="btn btn-ghost btn-sm" id="installOpen">Установить</button></div>' : ''}`;
    $('#installOpen')?.addEventListener('click', openInstall);
    $('#adminOpen')?.addEventListener('click', () => window.HFAdmin?.open());
    // мой тренер: кто видит мой дневник — с возможностью закрыть доступ
    api('/api/clients').then(r => {
      coachInfo = r; const box = $('#myCoachRow'); if (!box) return;
      box.innerHTML = r.coaches.map(c => `<div class="push-row"><div><b>Тренер: ${esc(c.name)}</b><p class="sub small">Видит ваш дневник: еду с фото, воду, активность, вес</p></div><button class="btn btn-ghost btn-sm" data-uncoach="${c.id}">Закрыть доступ</button></div>`).join('');
      box.querySelectorAll('[data-uncoach]').forEach(b => b.onclick = async () => { try { await api(`/api/coach/${b.dataset.uncoach}`, { method: 'DELETE' }); HF.toast('Доступ к дневнику закрыт'); renderAccountCard(); } catch (e) { HF.toast(e.message); } });
    }).catch(() => {});
    $('#shareSummary')?.addEventListener('change', async e => {
      const on = e.target.checked;
      try { await api('/api/me', { method: 'PATCH', body: { shareSummary: on } }); me.shareSummary = on; HF.toast(on ? 'Друзья видят вашу сводку за день' : 'Сводка скрыта от друзей'); }
      catch (err) { e.target.checked = !on; HF.toast(err.message); }
    });
    renderPushUI();
    const ui = $('#unameInput');
    ui.addEventListener('input', () => checkName(ui.value, $('#unameHint'), me.username));
    ui.addEventListener('change', async () => {
      const v = ui.value.trim(); if (!v || v === me.username) return;
      try { me = { ...me, ...(await api('/api/me', { method: 'PATCH', body: { username: v } })).me }; HF.toast(`Теперь вы @${me.username}`); $('#unameHint').textContent = ''; }
      catch (e) { HF.toast(e.message); ui.value = me.username; $('#unameHint').textContent = ''; }
    });
    $('#logoutBtn').onclick = async () => { await dropPush(); try { await api('/api/auth/logout', { method: 'POST' }); } catch {} me = null; boot(); HF.toast('Вы вышли'); };
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
    try { const up = await uploadImage(HF.db.profile.avatar);
      me = (await api('/api/me', { method: 'PATCH', body: { avatar: up.id } })).me; } catch {}
  }, 600));

  /* ================= cloud backup ================= */
  let syncT;
  function onSave() { if (!me || DEMO) return; clearTimeout(syncT); syncT = setTimeout(syncUp, 5000); schedulePush(); }
  async function syncUp() {
    const el = $('#syncInfo');
    try {
      // фото старше 30 дней в облако не шлём — иначе за пару месяцев копия упирается в лимит
      const cut = Date.now() - 30 * 864e5, copy = { ...HF.db, owner: me.id, days: {} };
      for (const [k, d] of Object.entries(HF.db.days)) copy.days[k] = { ...d, meals: d.meals.map(m => m.time < cut ? { ...m, thumb: '' } : m) };
      await api('/api/sync', { method: 'PUT', body: JSON.stringify(copy) });
      if (el) el.textContent = `Копия сохранена ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    } catch (e) { if (el) el.textContent = `Копия не сохранилась: ${e.message}`; }
  }
  // Новый аккаунт на телефоне, где был дневник другого аккаунта, — начинаем с чистого дневника.
  function claimDiary() {
    if (HF.db.owner && HF.db.owner !== me.id) { const name = HF.db.profile.name; HF.db = HF.validDb({ days: {}, profile: { name } }); HF.render(); }
    HF.db.owner = me.id; HF.save();
  }
  // При входе: если на телефоне дневник другого аккаунта — заменяем облачным; иначе объединяем записи двух устройств.
  async function restoreIfEmpty() {
    try {
      const r = await api('/api/sync'), local = HF.db;
      const foreign = local.owner && local.owner !== me.id;
      if (!r.data) { if (foreign) { HF.db = HF.validDb({ days: {} }); HF.db.owner = me.id; HF.save(); HF.render(); } else { local.owner = me.id; syncUp(); } return; }
      const prev = local;
      const next = foreign ? HF.validDb(r.data) : HF.mergeDb(local, r.data); if (!next) return;
      next.owner = me.id;
      const count = db => Object.values(db.days).reduce((a, d) => a + d.meals.length, 0);
      const added = count(next) - (foreign ? 0 : count(local));
      HF.db = next; HF.save(); HF.render(); syncUp();
      if (foreign) HF.toast('Загружен дневник этого аккаунта', 'Отменить', () => { HF.db = prev; HF.save(); HF.render(); }, 8000);
      else if (added > 0) HF.toast(`Из облака добавлено приёмов пищи: ${added}`);
    } catch {}
  }

  /* ================= «Здоровье» ================= */
  let healthLast = null;
  async function pullHealth() {
    if (!me) return;
    try {
      const from = HF.keyOf(new Date(Date.now() - 60 * 864e5));
      const r = await api('/api/health?from=' + from);
      healthLast = r.last || null;
      HF.db.health ||= {};
      for (const d of r.days) HF.db.health[d.date] = { steps: d.steps || 0, active_kcal: d.active_kcal || 0 };
      HF.save(); HF.render();
    } catch {}
  }
  setInterval(() => { if (me && !document.hidden) pullHealth(); }, 10 * 60 * 1000);
  /* «Здоровье»: на iPhone — готовая «Быстрая команда» (2 нажатия), на Android — Health Connect */
  const SC_NAME = (window.KBJU_CONFIG || {}).healthShortcutName || 'Healthy Fit';
  const scLink = () => (window.KBJU_CONFIG || {}).healthShortcut || '';
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const healthUrl = () => `${location.origin}/api/health/ingest?t=${me.healthToken}`;
  function lastHealth() { const days = Object.keys(HF.db.health || {}).sort(); return days[days.length - 1]; }
  // запустить команду: она прочитает «Здоровье» и отправит шаги и калории на сервер
  function runShortcut() {
    lsSet('hf.hcRun', String(Date.now()));
    const back = standalone ? '' : `&x-success=${encodeURIComponent(location.origin + '/?health=sync')}&x-cancel=${encodeURIComponent(location.origin + '/?health=cancel')}&x-error=${encodeURIComponent(location.origin + '/?health=error')}`;
    location.href = `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(SC_NAME)}${back}`;
  }
  // Разбираем, что именно случилось, и говорим человеку понятными словами
  async function afterSync(silent, ranAt = Date.now() - 5 * 60e3) {
    await pullHealth(); renderHealthCard();
    const h = HF.db.health?.[HF.today()], L = healthLast, fresh = L && L.at > ranAt - 60e3;
    if (h && (h.steps || h.active_kcal) && (!L || L.ok)) { lsSet('hf.hcOk', '1'); if (!silent) HF.toast(`Из «Здоровья»: ${Math.round(h.steps).toLocaleString('ru-RU')} шагов · ${Math.round(h.active_kcal)} ккал`); return; }
    if (silent) return;
    if (!fresh) HF.toast('Команда не достучалась до сервера: в ней не ваш адрес. Нажмите «Добавить» и вставьте адрес, когда «Команды» спросят.', 'Открыть', openHealth, 9000);
    else if (!L.ok) HF.toast(`Команда прислала данные, но в них нет шагов и калорий: «${(L.raw || 'пусто').slice(0, 80)}». Проверьте поля steps и active_kcal.`, 'Открыть', openHealth, 10000);
    else HF.toast('Данные пришли, но за другой день — проверьте «Дата начала: Сегодня» в команде', 'Открыть', openHealth, 8000);
  }
  window.HFHealth = { run: runShortcut, afterSync, ready: () => isIOS && lsGet('hf.hcOk') === '1' };
  function renderHealthCard() {
    const c = $('#healthCard'); if (!c) return;
    const last = lastHealth(), ok = isIOS && lsGet('hf.hcOk') === '1';
    c.innerHTML = `<div class="row-between"><div><h2 class="h2">«Здоровье» и браслеты</h2>
      <p class="sub">${last ? `Обновлено: ${new Date(last + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : 'Шаги и активные калории — автоматически'}</p></div>
      ${ok ? '<button class="btn btn-primary btn-sm" id="healthSync">Обновить</button>' : `<button class="btn btn-ghost btn-sm" id="healthOpen">${last ? 'Настроить' : 'Подключить'}</button>`}</div>
      ${ok ? '<button class="link-btn small" id="healthOpen">Настройки и автообновление</button>' : ''}`;
    $('#healthOpen').onclick = openHealth;
    $('#healthSync')?.addEventListener('click', runShortcut);
    // на iPhone — кнопка «Из «Здоровья»» прямо у шагов: настроено → обновить, нет → открыть подключение
    const sb = $('#stepsHealth'); if (sb) { sb.hidden = !me || isAndroid; sb.onclick = ok ? runShortcut : openHealth; }
  }
  async function openHealth() {
    const g = $('#healthGuide');
    if (!me) { g.innerHTML = `<p>Чтобы телефон присылал шаги и калории, нужен аккаунт: так данные попадут именно к вам.</p><button class="btn btn-primary" id="hgAuth">Войти или создать аккаунт</button>`;
      HF.openDialog($('#healthSheet')); $('#hgAuth').onclick = () => { HF.closeDialog($('#healthSheet')); HF.showTab('chats'); }; return; }
    if (!me.healthToken) { try { me.healthToken = (await api('/api/me')).me.healthToken; } catch {} }
    await pullHealth();
    const url = healthUrl(), link = scLink(), added = lsGet('hf.hcAdded') === '1', ok = lsGet('hf.hcOk') === '1';
    const ios = `
      <ol class="hc-steps">
        <li class="${added ? 'done' : 'now'}"><div><b>Добавьте команду</b>
          <p class="sub small">Адрес уже скопирован — в «Командах» нажмите «Вставить» и «Добавить».</p></div>
          ${link ? `<button class="btn ${added ? 'btn-ghost' : 'btn-primary'} btn-sm" id="hcAdd">${added ? 'Ещё раз' : 'Добавить'}</button>` : ''}</li>
        <li class="${ok ? 'done' : added ? 'now' : ''}"><div><b>Запустите один раз</b>
          <p class="sub small">Разрешите доступ к шагам и энергии. Дальше — кнопка «Обновить».</p></div>
          <button class="btn ${added && !ok ? 'btn-primary' : 'btn-ghost'} btn-sm" id="hcRun">Запустить</button></li>
        <li class="${lsGet('hf.hcAuto') === '1' ? 'done' : ''}"><div><b>Чтобы не запускать вручную</b>
          <p class="sub small">Apple не даёт сайтам читать «Здоровье» в фоне, но «Команды» могут сами: «Автоматизация» → <b>+</b> → «Время суток» → 13:00, «Ежедневно» → <b>«Запускать сразу»</b> → «${SC_NAME}». Повторите для 18:00 и 22:30 — шаги будут обновляться весь день без вас.</p></div>
          <button class="btn btn-ghost btn-sm" id="hcAuto">${lsGet('hf.hcAuto') === '1' ? 'Готово ✓' : 'Сделал'}</button></li>
      </ol>
      ${link ? '' : `<p class="plan-warn">Готовая команда ещё не опубликована — пока соберите её сами по инструкции ниже (2 минуты).</p>`}
      <details class="hg"${link ? '' : ' open'}><summary>Собрать команду вручную</summary><ol>
        <li>«Команды» → <b>+</b> → назовите <b>${SC_NAME}</b>.</li>
        <li><b>Текст</b> — вставьте ваш адрес (кнопка «Копировать» ниже).</li>
        <li><b>Найти образцы здоровья</b>: тип — «Шаги», дата начала — «Сегодня», <b>«Группировать» — «День»</b> (так шаги сложатся в одно число).</li>
        <li>Ещё раз <b>Найти образцы здоровья</b>: «Активная энергия», «Сегодня», «Группировать» — «День», единица — «ккал».</li>
        <li><b>Получить содержимое URL</b>: URL — переменная «Текст»; «Показать больше» → метод <b>POST</b>, тело <b>JSON</b> → «Добавить поле» → «Число»: <code>steps</code> = первые «Образцы здоровья» (тап по переменной → «Значение»), <code>active_kcal</code> = вторые → «Значение».</li>
      </ol></details>`;
    const android = `<ol class="hc-steps">
        <li class="now"><div><b>Health Connect</b><p class="sub small">Шагомер (Google Fit, Samsung Health, Mi Fitness, Zepp…) должен писать данные в Health Connect.</p></div></li>
        <li><div><b>Приложение HC Webhook</b><p class="sub small">GitHub: mcnaveen/health-connect-webhook. Доступ к «Шагам» и «Активным калориям», Webhook URL — ваш адрес ниже, интервал 1–3 часа.</p></div></li>
      </ol>`;
    g.innerHTML = `${isAndroid ? android : ios}
      <details class="hg"><summary>${isAndroid ? 'Для iPhone' : 'Для Android'}</summary>${isAndroid ? ios.replace(/id="hc(Add|Run|Auto)"/g, 'data-x="$1"') : android}</details>
      <p class="field-label">Ваш личный адрес — никому не показывайте</p>
      <div class="copy-row"><code id="hgUrl">${esc(url)}</code><button class="btn btn-ghost btn-sm" id="hgCopy">Копировать</button></div>
      <p class="sub small">За день учитывается большее: активные калории из «Здоровья» или ваши тренировки и шаги — тренировка с часов не посчитается дважды.</p>
      ${healthLast ? `<p class="sub small hc-last">Последняя отправка: ${new Date(healthLast.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — ${healthLast.ok ? 'принята ✓' : `<b>не распознана</b>: <code>${esc((healthLast.raw || 'пусто').slice(0, 120))}</code>`}</p>` : '<p class="sub small hc-last">Команда ещё ни разу не присылала данные.</p>'}
      <div class="row-btns"><button class="btn btn-ghost btn-sm" id="hgPull">Проверить данные</button><button class="btn btn-ghost btn-sm" id="hgRotate">Сменить адрес</button></div>`;
    HF.openDialog($('#healthSheet'));
    const copy = async () => { try { await navigator.clipboard.writeText(url); return true; } catch { getSelection().selectAllChildren($('#hgUrl')); return false; } };
    $('#hgCopy').onclick = async () => { if (await copy()) HF.toast('Адрес скопирован'); };
    $('#hcAdd')?.addEventListener('click', async () => {
      await copy(); lsSet('hf.hcAdded', '1');
      location.href = link;   // iCloud-страница команды → «Добавить быструю команду» → вставить адрес
    });
    $('#hcRun')?.addEventListener('click', () => { lsSet('hf.hcAdded', '1'); runShortcut(); });
    $('#hcAuto')?.addEventListener('click', () => { lsSet('hf.hcAuto', '1'); HF.closeDialog($('#healthSheet')); openHealth(); });
    $('#hgPull').onclick = () => afterSync(false);
    $('#hgRotate').onclick = async () => { try { me.healthToken = (await api('/api/me/health-token', { method: 'POST' })).healthToken; lsSet('hf.hcAdded', '0'); lsSet('hf.hcOk', '0'); HF.closeDialog($('#healthSheet')); openHealth(); HF.toast('Адрес сменён — добавьте команду заново'); } catch (e) { HF.toast(e.message); } };
  }
  // вернулись из «Команд» (вкладка снова видна) — подтягиваем свежие данные
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !me) return;
    const ran = +(lsGet('hf.hcRun') || 0); if (Date.now() - ran < 3 * 60 * 1000) { lsSet('hf.hcRun', '0'); setTimeout(() => afterSync(false, ran), 1500); }
  });

  /* ================= friends & inbox ================= */
  let prevUnread = null, prevIncoming = null;
  async function refreshSocial() {
    if (!me) return;
    try {
      const [f, c] = await Promise.all([api('/api/friends'), api('/api/chats')]);
      friends = f.friends; incoming = f.incoming; sent = f.sent; chats = c.chats;
      const total = c.unreadTotal + incoming.length;
      const b = $('#chatBadge'); b.hidden = !total; b.textContent = total;
      document.title = total ? `(${total}) Healthy Fit` : 'Healthy Fit';
      try { if (navigator.setAppBadge) total ? navigator.setAppBadge(total) : navigator.clearAppBadge(); } catch {}
      // всплывашка о новом, пока приложение открыто
      if (prevUnread) {
        const fresh = c.chats.filter(x => x.unread > (prevUnread[x.peer.id] || 0) && !(peer && peer.id === x.peer.id && !chatEl.hidden));
        if (fresh.length) {
          const x = fresh[0];
          HF.toast(`${x.peer.name}: ${preview(x.last)}`.slice(0, 90), 'Открыть', () => openChat(x.peer), 6000);
          try { navigator.vibrate?.(60); } catch {}
        } else if (prevIncoming != null && incoming.length > prevIncoming) HF.toast(`${incoming[incoming.length - 1].name} хочет добавить вас в друзья`, 'Открыть', () => HF.showTab('chats'), 6000);
      }
      prevUnread = Object.fromEntries(c.chats.map(x => [x.peer.id, x.unread])); prevIncoming = incoming.length;
      if (tab === 'chats') renderInbox();
    } catch (e) { if (e.status === 401) { me = null; boot(); } }
  }
  setInterval(() => { if (me && !document.hidden) refreshSocial(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && me) { refreshSocial(); if (window.HFPushSync) window.HFPushSync(); } });

  function renderInbox() {
    const row = $('#friendRow');
    row.innerHTML = friends.length ? '' : `<p class="sub friend-empty">Найдите друзей по логину через поиск выше.</p>`;
    for (const u of friends) {
      const b = document.createElement('button'); b.className = 'friend';
      // тонкое кольцо вокруг аватарки — насколько друг заполнил дневную норму
      const pr = u.today && u.today.goal ? Math.min(1, u.today.kcal / u.today.goal) : 0;
      if (u.today) b.style.setProperty('--prog', pr.toFixed(3));
      if (u.today) b.classList.add('has-prog'), b.title = `${u.name}: ${u.today.kcal} из ${u.today.goal} ккал сегодня`;
      b.innerHTML = `${avaHTML(u, 'friend-ava')}<span>${esc(u.name)}</span>${u.flame && u.flame.state !== 'none' ? `<span class="mini-flame">${flameBadge(u.flame)}</span>` : ''}`;
      b.onclick = () => openChat(u);   // сразу в переписку; профиль — по тапу на имя в шапке чата
      row.appendChild(b);
    }
    const rq = $('#requests');
    rq.innerHTML = incoming.length ? `<h2 class="h2 list-title">Заявки в друзья</h2>` : '';
    for (const u of incoming) {
      const d = document.createElement('div'); d.className = 'req';
      d.innerHTML = `${avaHTML(u)}<span class="req-who"><b>${esc(u.name)}</b><small>@${esc(u.username)}</small></span>
        <button class="btn btn-primary btn-sm" data-a="yes">Принять</button><button class="icon-btn" data-a="no" aria-label="Отклонить"><svg><use href="#i-x"/></svg></button>`;
      d.querySelector('[data-a=yes]').onclick = async () => { try { await api(`/api/friends/${u.id}`, { method: 'POST' }); HF.toast(`${u.name} теперь в друзьях`); } catch (e) { HF.toast(e.message); } refreshSocial(); };
      d.querySelector('[data-a=no]').onclick = async () => { await api(`/api/friends/${u.id}`, { method: 'DELETE' }).catch(() => {}); refreshSocial(); };
      rq.appendChild(d);
    }
    const list = $('#chatList'); list.innerHTML = '';
    if (!chats.length) list.innerHTML = `<li class="sub chat-empty">Пока нет сообщений. Сфотографируйте еду и нажмите «Поделиться» — или откройте друга сверху.</li>`;
    for (const c of chats) {
      const li = document.createElement('li'), b = document.createElement('button'); b.className = 'chat-row' + (c.unread ? ' unread' : '') + (c.peer.bot ? ' is-bot' : '');
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
          d.querySelector('.req-who').onclick = () => window.HFPosts?.openUser(u.id);
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
    peer = u; lastId = 0; peerRead = 0; setReplyMsg(null);
    ava($('#chatAva'), u); $('#chatName').textContent = u.name; $('#chatSub').textContent = u.bot ? 'Итоги дня каждый вечер · советы' : '@' + u.username; $('#flameBanner').hidden = true;
    chatEl.classList.toggle('is-bot', !!u.bot); $('#chatMore').hidden = !!u.bot;
    $('#msgs').innerHTML = ''; delete $('#msgs').dataset.day; $('#msgInput').value = ''; updateSendBtn();
    HF.openDialog(chatEl, '#chatBack');   // без автофокуса: сначала читаем переписку, клавиатура — по нажатию на поле
    await loadMsgs();
    clearInterval(chatPoll); chatPoll = setInterval(() => { if (!document.hidden) loadMsgs(); }, 3000);
  }
  function closeChat() { setReplyMsg(null); clearInterval(chatPoll); if (R) recFinish(false); HF.closeDialog(chatEl); peer = null; refreshSocial(); }
  // «Назад» из чата (кнопка, свайп, жест Safari) — всегда на вкладку «Чаты», а не в окно, из которого пришли
  function leaveChat() { closeChat(); HF.closeOverlays(); if (!document.querySelector('#tab-chats:not([hidden])')) HF.showTab('chats'); }
  $('#chatBack').onclick = leaveChat; chatEl._back = leaveChat;
  async function loadMsgs() {
    if (!peer) return;
    try {
      const r = await api(`/api/chats/${peer.id}?after=${lastId}`);
      const sc = $('#chatScroll'), atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
      for (const m of r.messages) { appendMsg(m); lastId = Math.max(lastId, m.id); }
      if (r.peerRead !== peerRead) { peerRead = r.peerRead; markRead(); }
      if (peer.bot) {} else if (!r.friends) $('#chatSub').textContent = 'Вы больше не друзья — писать нельзя'; else renderFlame(r.peer?.flame);
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
  // время + галочки: одна — доставлено, две зелёные — прочитано (как в Telegram)
  const TICKS = '<svg class="tick" viewBox="0 0 20 12" aria-hidden="true"><path class="t1" d="M1.5 6.5 5 10l7-8"/><path class="t2" d="M8.6 9.4 9.2 10l7-8"/></svg>';
  const metaHTML = (t, mine) => `<span class="meta"><time>${t}</time>${mine ? TICKS : ''}</span>`;
  const dayKeyOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  function dayLabel(ts) {
    const d = new Date(ts), n = new Date(), y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
    if (dayKeyOf(d) === dayKeyOf(n)) return 'Сегодня';
    if (dayKeyOf(d) === dayKeyOf(y)) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
  }
  const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // кружки: в ленте крутятся без звука, по тапу — со звуком и крупнее, с кольцом прогресса
  const circleIO = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(e => {
    const v = e.target; if (v.closest('.circle-msg.playing')) return;
    if (e.isIntersecting) { v.muted = true; v.loop = true; v.play().catch(() => {}); } else v.pause();
  }), { threshold: 0.6 }) : null;
  function appendMsg(m) {
    if (document.querySelector(`.msg[data-id="${m.id}"]`)) return;
    const list = $('#msgs'), li = document.createElement('li'), mine = m.from === me.id;
    // разделитель дня
    const dk = dayKeyOf(m.created);
    if (list.dataset.day !== dk) { list.dataset.day = dk; const sep = document.createElement('li'); sep.className = 'day-sep'; sep.innerHTML = `<span>${dayLabel(m.created)}</span>`; list.appendChild(sep); }
    // группировка подряд идущих сообщений одного человека: хвостик и аватарный отступ — только у последнего
    const prev = list.lastElementChild;
    if (prev?.classList.contains('msg') && prev.classList.contains(mine ? 'mine' : 'theirs') && m.created - +prev.dataset.at < 5 * 60e3) { li.classList.add('cont'); prev.classList.add('has-next'); }
    li.classList.add('msg', mine ? 'mine' : 'theirs', `k-${m.kind}`); li.dataset.id = m.id; li.dataset.at = m.created;
    const t = new Date(m.created).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (m.kind === 'text') {
      li.innerHTML = `<div class="bubble"><p></p>${metaHTML(t, mine)}</div>`;
      const pEl = li.querySelector('p'); pEl.textContent = m.body; pEl.insertAdjacentHTML('beforeend', '<span class="meta-sp" aria-hidden="true"></span>');
      if (/^\p{Extended_Pictographic}{1,3}$/u.test(m.body.trim())) li.classList.add('emoji-only');
    }
    else if (m.kind === 'meal' || m.kind === 'post') {
      // карточка вложения на своей «бумаге», подпись — отдельной строкой в цвете пузыря, как в Telegram
      const x = m.meta || {}, isPost = m.kind === 'post';
      li.innerHTML = `<div class="bubble media-bubble">
        <div class="att"${isPost && x.postId ? ' role="button" tabindex="0"' : ''}>
          ${isPost && x.author ? `<div class="att-from"><span class="avatar">${esc((x.author.name || '?').charAt(0).toUpperCase())}</span><b>${esc(x.author.name)}</b><span>публикация</span></div>` : ''}
          ${m.media ? `<img class="att-img" src="${esc(m.media)}" alt="" loading="lazy">` : ''}
          <div class="att-info"><b class="att-title"></b>
            <p class="att-kcal"><b>${Math.round(x.kcal || 0)}</b> ккал<span style="--c:var(--color-protein)">Б ${Math.round(x.p || 0)}</span><span style="--c:var(--color-fat)">Ж ${Math.round(x.f || 0)}</span><span style="--c:var(--color-carb)">У ${Math.round(x.c || 0)}</span></p></div>
        </div>
        ${m.body ? '<p class="cap"></p>' : ''}${metaHTML(t, mine)}</div>`;
      li.querySelector('.att-title').textContent = x.title || 'Еда';
      if (m.body) { const c = li.querySelector('.cap'); c.textContent = m.body; c.insertAdjacentHTML('beforeend', '<span class="meta-sp" aria-hidden="true"></span>'); }
      else li.querySelector('.media-bubble').classList.add('no-cap');
      if (isPost && x.postId) { const att = li.querySelector('.att'); att.setAttribute('aria-label', `Открыть публикацию «${x.title || ''}»`);
        att.onclick = () => window.HFPosts?.openPost(x.postId); att.onkeydown = e => { if (e.key === 'Enter') att.click(); }; }
    } else if (m.kind === 'voice') {
      const dur = Math.max(1, Math.round(m.meta?.dur || 0)), N = 28;
      li.innerHTML = `<div class="bubble voice"><button class="vplay" aria-label="Воспроизвести голосовое, ${fmtDur(dur)}"><svg><use href="#i-play"/></svg></button>
        <div class="vbody"><span class="wave" role="slider" aria-label="Перемотка" aria-valuemin="0" aria-valuemax="${dur}" aria-valuenow="0" tabindex="-1">${Array.from({ length: N }, (_, i) => `<i style="height:${22 + Math.abs(Math.sin(m.id * 7 + i * 1.7)) * 78}%"></i>`).join('')}</span>
        <span class="vfoot"><span class="vdur">${fmtDur(dur)}</span>${metaHTML(t, mine)}</span></div></div>`;
      const btn = li.querySelector('.vplay'), wave = li.querySelector('.wave'), bars = [...wave.children], vd = li.querySelector('.vdur'), audio = new Audio(); audio.preload = 'none'; audio.src = m.media;
      const paint = p => { const k = Math.round(p * N); bars.forEach((b, i) => b.classList.toggle('on', i < k)); wave.setAttribute('aria-valuenow', Math.round(p * dur)); };
      btn.onclick = () => { document.querySelectorAll('audio, video').forEach(a => a !== audio && a.pause()); audio.paused ? audio.play().catch(() => HF.toast('Не удалось воспроизвести')) : audio.pause(); };
      wave.onclick = e => { const r = wave.getBoundingClientRect(), p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); const go = () => { audio.currentTime = p * (audio.duration || dur); paint(p); };
        if (audio.readyState) go(); else { audio.addEventListener('loadedmetadata', go, { once: true }); audio.load(); } if (audio.paused) btn.click(); };
      audio.onplay = () => { btn.innerHTML = '<svg><use href="#i-pause"/></svg>'; li.classList.add('playing'); };
      audio.onpause = () => { btn.innerHTML = '<svg><use href="#i-play"/></svg>'; li.classList.remove('playing'); };
      audio.onended = () => { audio.onpause(); paint(0); vd.textContent = fmtDur(dur); };
      audio.ontimeupdate = () => { const d = audio.duration && isFinite(audio.duration) ? audio.duration : dur; paint(audio.currentTime / d); vd.textContent = fmtDur(Math.max(0, d - audio.currentTime)); };
    } else if (m.kind === 'video') {
      const dur = Math.max(1, Math.round(m.meta?.dur || 0)), C = 2 * Math.PI * 48;
      li.innerHTML = `<div class="circle-msg" role="button" tabindex="0" aria-label="Видеосообщение, ${fmtDur(dur)}"><video playsinline muted preload="metadata" src="${esc(m.media)}#t=0.1"></video>
        <svg class="cm-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" style="stroke-dasharray:${C};stroke-dashoffset:${C}"/></svg>
        <span class="cm-dur">${fmtDur(dur)}</span>${metaHTML(t, mine)}</div>`;
      const v = li.querySelector('video'), wrap = li.querySelector('.circle-msg'), ring = li.querySelector('.cm-ring circle'), cd = li.querySelector('.cm-dur');
      circleIO?.observe(v);
      const stop = () => { wrap.classList.remove('playing'); v.muted = true; v.loop = true; ring.style.strokeDashoffset = C; cd.textContent = fmtDur(dur); };
      wrap.onclick = () => {
        if (wrap.classList.contains('playing')) { if (v.paused) v.play(); else { v.pause(); stop(); v.play().catch(() => {}); } return; }
        document.querySelectorAll('audio').forEach(a => a.pause());
        document.querySelectorAll('.circle-msg.playing').forEach(o => o !== wrap && o.click());
        wrap.classList.add('playing'); v.loop = false; v.muted = false; v.currentTime = 0; v.play().catch(() => stop());
      };
      wrap.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); wrap.click(); } };
      v.ontimeupdate = () => { if (!wrap.classList.contains('playing')) return; const d = v.duration && isFinite(v.duration) ? v.duration : dur; ring.style.strokeDashoffset = C * (1 - v.currentTime / d); cd.textContent = fmtDur(Math.max(0, d - v.currentTime)); };
      v.onended = () => { stop(); v.play().catch(() => {}); };
    }
    if (m.reply) {
      const q = document.createElement('button'); q.className = 'quote'; q.type = 'button';
      q.innerHTML = `<b></b><span></span>`;
      q.querySelector('b').textContent = m.reply.deleted ? 'Сообщение удалено' : m.reply.from === me.id ? 'Вы' : peer?.name || '';
      q.querySelector('span').textContent = m.reply.deleted ? '' : m.reply.text;
      q.onclick = e => { e.stopPropagation(); const o = document.querySelector(`.msg[data-id="${m.reply.id}"]`); if (o) { o.scrollIntoView({ block: 'center', behavior: 'smooth' }); o.classList.remove('flash'); void o.offsetWidth; o.classList.add('flash'); } };
      // цитата — всегда отдельной строкой во всю ширину пузыря; у кружка — над ним, а не внутри круга
      const host = li.querySelector('.bubble, .circle-msg');
      if (host?.classList.contains('circle-msg')) { li.classList.add('col'); q.classList.add('quote-solo'); li.insertBefore(q, host); } else host?.prepend(q);
    }
    li.insertAdjacentHTML('beforeend', '<span class="msg-swipe" aria-hidden="true"><svg><use href="#i-reply"/></svg></span>');
    bindSwipeReply(li, m);
    if (mine) {
      li.addEventListener('contextmenu', e => { e.preventDefault(); delMsg(m.id, li); });
      let lp; li.addEventListener('touchstart', () => { lp = setTimeout(() => delMsg(m.id, li), 650); }, { passive: true });
      li.addEventListener('touchend', () => clearTimeout(lp)); li.addEventListener('touchmove', () => clearTimeout(lp), { passive: true });
    }
    $('#msgs').appendChild(li); markRead();
  }
  /* ответ на сообщение: свайп влево (как в Telegram) или двойной тап */
  let replyMsg = null;
  const msgSnippet = m => m.kind === 'text' ? m.body : preview(m);
  function setReplyMsg(m) {
    replyMsg = m; $('#msgReply').hidden = !m;
    if (!m) return;
    $('#msgReplyName').textContent = m.from === me.id ? 'Ответ себе' : `Ответ ${peer?.name || ''}`;
    $('#msgReplyText').textContent = msgSnippet(m).slice(0, 90);
    $('#msgInput').focus();
  }
  $('#msgReplyX').onclick = () => setReplyMsg(null);
  function bindSwipeReply(li, m) {
    let x0 = 0, y0 = 0, dx = 0, on = false, moved = false;
    const move = el => el && (el.style.transform = dx ? `translateX(${dx}px)` : '');
    const target = () => li.querySelector('.bubble, .circle-msg');
    li.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button) return; if (e.target.closest('button, video, audio, .vplay')) return; x0 = e.clientX; y0 = e.clientY; dx = 0; on = true; moved = false; });
    li.addEventListener('pointermove', e => {
      if (!on) return;
      const ddx = e.clientX - x0, ddy = e.clientY - y0;
      if (!moved && Math.abs(ddy) > 10 && Math.abs(ddy) > Math.abs(ddx)) { on = false; return; }
      if (ddx < -6) {
        moved = true; dx = Math.max(-92, ddx > -64 ? ddx : -64 + (ddx + 64) * 0.4);   // после 64 px — «резинка»
        target().style.transition = 'none'; move(target());
        li.style.setProperty('--sw', Math.min(1, -dx / 60)); li.classList.toggle('armed', dx < -56);
      }
    });
    const end = () => {
      if (!on) return; on = false;
      const t = target(); t.style.transition = ''; dx = 0; move(t); li.style.removeProperty('--sw');
      if (li.classList.contains('armed')) { li.classList.remove('armed'); try { navigator.vibrate?.(12); } catch {} setReplyMsg(m); }
    };
    li.addEventListener('pointerup', end); li.addEventListener('pointercancel', end); li.addEventListener('pointerleave', end);
    li.addEventListener('dblclick', e => { if (!e.target.closest('button, video')) setReplyMsg(m); });
  }
  async function delMsg(id, li) {
    li.classList.add('del-ask');
    HF.toast('Удалить сообщение у обоих?', 'Удалить', async () => { try { await api(`/api/messages/${id}`, { method: 'DELETE' }); li.remove(); } catch (e) { HF.toast(e.message); } }, 4000);
    setTimeout(() => li.classList.remove('del-ask'), 4000);
  }
  async function sendMsg(payload) {
    if (!peer) return;
    if (replyMsg) payload = { ...payload, reply: replyMsg.id };
    try { const r = await api(`/api/chats/${peer.id}`, { method: 'POST', body: payload }); setReplyMsg(null); appendMsg(r.message); lastId = Math.max(lastId, r.message.id);
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
  // как в Telegram: тянешь вверх — над кнопкой «замок» едет навстречу пальцу и защёлкивается; влево — отмена
  const LOCK_DY = 90, CANCEL_DX = 110;
  function pressMove(x, y) {
    if (!press?.held || !R || R.locked) return;
    const dx = Math.min(0, x - press.x), dy = Math.min(0, y - press.y), c = $('#chat');
    const up = Math.abs(dy) > Math.abs(dx);   // жесты не смешиваем: ведём либо вверх, либо влево
    const lk = up ? Math.min(1, -dy / LOCK_DY) : 0, cx = up ? 0 : dx;
    c.style.setProperty('--lk', lk.toFixed(3)); c.style.setProperty('--cx', `${Math.max(-CANCEL_DX, cx)}px`); c.style.setProperty('--cxk', Math.min(1, -cx / CANCEL_DX).toFixed(3));
    sendBtn.style.transform = `translate(${Math.max(-CANCEL_DX, cx) * 0.5}px, ${Math.max(-LOCK_DY, up ? dy : 0) * 0.45}px) scale(1.5)`;
    R.cancelArmed = cx < -CANCEL_DX * 0.85; c.classList.toggle('rec-cancel', R.cancelArmed);
    if (lk >= 1) lockRec();
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
    e.preventDefault(); try { sendBtn.setPointerCapture?.(e.pointerId); } catch {} pressStart(e.clientX, e.clientY);
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
    if (!on) { c.classList.remove('rec-locked', 'rec-cancel'); c.style.removeProperty('--lk'); c.style.removeProperty('--cx'); c.style.removeProperty('--cxk'); c.style.removeProperty('--lvl'); sendBtn.style.transform = ''; }
    $('#recStatus').hidden = !on; $('#msgInput').hidden = on; $('#recTrash').hidden = !(on && R?.locked);
    $('#circleRec').hidden = !(on && R?.mode === 'video');
    if (on) { $('#recTime').textContent = '0:00'; setProg(0); }
    if (on && R?.locked) sendBtn.innerHTML = '<svg><use href="#i-send"/></svg>';
    if (!on) updateSendBtn();
  }
  function setProg(p) { const c = $('#circleProg'), len = 2 * Math.PI * 48; c.style.strokeDasharray = len; c.style.strokeDashoffset = len * (1 - Math.min(1, p)); }
  function lockRec() {
    if (!R || R.locked) return;
    R.locked = true; press = null; sendBtn.style.transform = '';
    const c = $('#chat'); c.classList.add('rec-locked', 'rec-justlocked'); c.style.setProperty('--lk', '1'); c.style.removeProperty('--cx'); c.classList.remove('rec-cancel');
    setTimeout(() => c.classList.remove('rec-justlocked'), 700);
    try { navigator.vibrate?.(20); } catch {}
    $('#recTrash').hidden = false;
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
    // уровень громкости — «дышащий» ореол вокруг кнопки, как в Telegram
    try {
      const AC = window.AudioContext || window.webkitAudioContext, ac = r.ac = new AC(), an = ac.createAnalyser(); an.fftSize = 256;
      ac.createMediaStreamSource(r.stream).connect(an); const buf = new Uint8Array(an.fftSize);
      const tick = () => { if (R !== r) return; an.getByteTimeDomainData(buf); let sum = 0; for (const v of buf) sum += (v - 128) ** 2;
        $('#chat').style.setProperty('--lvl', Math.min(1, Math.sqrt(sum / buf.length) / 40).toFixed(2)); requestAnimationFrame(tick); };
      tick();
    } catch {}
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
    R = null; clearInterval(r.timer); setRecUI(false); try { r.ac?.close(); } catch {}
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
  $('#recTrash').onclick = () => recFinish(false); $('#recCancel').onclick = () => recFinish(false);


  /* ================= меню чата (⋮): профиль и тренер ================= */
  const COACH_WHAT = 'Тренер видит ваш дневник целиком: всю еду с фото, граммы и КБЖУ, воду, тренировки, вес и прогресс. Отменить можно в любой момент.';
  async function openChatMenu() {
    if (!peer || peer.bot) return;
    const u0 = peer; let info = { myCoach: false, iCoach: false, state: 'friends' };
    try { const r = await api(`/api/users/${u0.id}`); info = r.user; } catch {}
    if (peer !== u0) return;
    ava($('#cmAva'), u0); $('#cmTitle').textContent = u0.name;
    $('#cmSub').textContent = info.myCoach ? 'Ваш тренер' : info.iCoach ? 'Ваш подопечный' : '@' + u0.username;
    const item = (id, ico, title, sub, danger) => `<button class="am-item${danger ? ' danger' : ''}" data-act="${id}"><span class="am-ico"><svg><use href="#${ico}"/></svg></span><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
    $('#cmList').innerHTML = [
      item('profile', 'i-user', 'Открыть профиль', ''),
      info.iCoach ? item('diary', 'i-cal', 'Дневник подопечного', 'Еда с фото, вода, активность, вес') : '',
      info.myCoach ? item('uncoach', 'i-x', 'Убрать из тренеров', 'Дневник снова станет закрытым', true)
        : info.state === 'friends' ? item('coach', 'i-spark', 'Назначить тренером', COACH_WHAT) : '',
    ].join('');
    $('#cmList').querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const a = b.dataset.act;
      if (a === 'profile' || a === 'diary') { HF.closeDialog($('#chatMenu')); window.HFPosts?.openUser(u0.id, a === 'diary'); return; }
      try {
        await api(`/api/coach/${u0.id}`, { method: a === 'coach' ? 'POST' : 'DELETE' });
        HF.closeDialog($('#chatMenu'));
        HF.toast(a === 'coach' ? `${u0.name} теперь ваш тренер — дневник открыт` : `${u0.name} больше не видит ваш дневник`);
        renderAccountCard();
      } catch (e) { HF.toast(e.message); }
    });
    HF.openDialog($('#chatMenu'));
  }
  $('#chatMore').onclick = openChatMenu;

  /* ================= подопечные (для тренера) — в «Чатах» над сообщениями ================= */
  let coachInfo = { clients: [], coaches: [] };
  async function loadClients() {
    if (!me) return;
    try { coachInfo = await api('/api/clients'); } catch { return; }
    const box = $('#clientsBox'), cl = coachInfo.clients;
    box.hidden = !cl.length;
    box.innerHTML = cl.length ? `<h2 class="h2 list-title">Подопечные</h2><div class="cl-list">${cl.map(u => {
      const t = u.today, k = t && t.goal ? Math.min(1.2, t.kcal / t.goal) : 0, ok = t && Math.abs(t.kcal - t.goal) <= t.goal * 0.1;
      return `<button class="cl-row" data-cl="${u.id}">${avaHTML(u)}<span class="cl-main"><b>${esc(u.name)}</b>
        <small>${t ? `${Math.round(t.kcal)} из ${t.goal} ккал · ${t.meals} ${plural(t.meals, 'приём', 'приёма', 'приёмов')}` : 'ещё не синхронизировал дневник'}</small>
        <span class="cl-bar"><i class="${ok ? 'ok' : k > 1.1 ? 'over' : ''}" style="width:${Math.min(100, k * 100)}%"></i></span></span><svg class="cl-chev" aria-hidden="true"><use href="#i-chev"/></svg></button>`; }).join('')}</div>` : '';
    box.querySelectorAll('[data-cl]').forEach(b => b.onclick = () => window.HFPosts?.openUser(+b.dataset.cl, true));
  }

  /* ================= share (TikTok-style) ================= */
  let shareData = null, toProfile = false; const picked = new Set();
  let shareVis = 'public';
  try { shareVis = localStorage.getItem('hf.shareVis') || 'public'; } catch {}
  $('#shareVis').querySelectorAll('[data-vis]').forEach(b => b.onclick = () => {
    shareVis = b.dataset.vis; try { localStorage.setItem('hf.shareVis', shareVis); } catch {} updShare();
  });
  function updShare() {
    $('#shareVis').hidden = !toProfile || !!shareData?.post;
    $('#shareVis').querySelectorAll('[data-vis]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.vis === shareVis)));
    const n = picked.size + (toProfile ? 1 : 0), btn = $('#shareSend');
    btn.disabled = !n;
    btn.textContent = toProfile && !picked.size ? 'Опубликовать' : toProfile ? `Опубликовать и отправить · ${picked.size}` : picked.size > 1 ? `Отправить · ${picked.size}` : 'Отправить';
  }
  async function shareMeal(d) {
    if (!me) { HF.toast('Войдите, чтобы делиться с друзьями'); HF.showTab('chats'); return; }
    shareData = d; picked.clear(); toProfile = false; $('#shareText').value = '';   // ничего не выбрано заранее — человек сам решает, куда отправить
    $('#shareTitle').textContent = d.post ? 'Отправить публикацию' : d.day ? 'Выложить день' : 'Отправить другу';
    $('#sharePreview').innerHTML = d.day
      ? `<span class="sp-stack">${d.thumbs.slice(0, 4).map((t, i) => `<img src="${esc(t)}" alt="" style="--i:${i}">`).join('')}</span><span><b></b><small>${d.meals.length} ${((n) => n % 10 === 1 && n % 100 !== 11 ? 'приём' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'приёма' : 'приёмов')(d.meals.length)} пищи · ${Math.round(d.totals.kcal)} ккал · Б ${Math.round(d.totals.p)} · Ж ${Math.round(d.totals.f)} · У ${Math.round(d.totals.c)}</small></span>`
      : `${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : ''}<span><b></b><small>${Math.round(d.totals.kcal)} ккал · Б ${Math.round(d.totals.p)} · Ж ${Math.round(d.totals.f)} · У ${Math.round(d.totals.c)}</small></span>`;
    $('#sharePreview b').textContent = d.name;
    if (!friends.length) await refreshSocial();
    const row = $('#shareFriends'); row.innerHTML = '';
    const mine = document.createElement('button'); mine.className = 'share-friend share-me'; mine.setAttribute('aria-pressed', String(toProfile));
    mine.innerHTML = `<span class="sf-ava">${avaHTML(me)}<i class="sf-plus"><svg><use href="#i-plus"/></svg></i><i class="sf-check"><svg><use href="#i-check"/></svg></i></span><span>В профиль</span>`;
    mine.onclick = () => { if (!d.thumb) { HF.toast('Для публикации нужно фото блюда'); return; } toProfile = !toProfile; mine.setAttribute('aria-pressed', String(toProfile)); updShare(); };
    if (!d.post) row.appendChild(mine);
    if (!friends.length) row.insertAdjacentHTML('beforeend', `<p class="sub share-nofr">Друзей пока нет — найдите их во вкладке «Друзья».</p>`);
    for (const u of friends) {
      const b = document.createElement('button'); b.className = 'share-friend'; b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="sf-ava">${avaHTML(u)}<i class="sf-check"><svg><use href="#i-check"/></svg></i></span><span>${esc(u.name)}</span>`;
      b.onclick = () => { picked.has(u.id) ? picked.delete(u.id) : picked.add(u.id); b.setAttribute('aria-pressed', String(picked.has(u.id))); updShare(); };
      row.appendChild(b);
    }
    updShare(); $('#shareText').placeholder = 'Подпись к публикации или сообщение';
    HF.openDialog($('#shareSheet'));
  }
  $('#shareSend').onclick = async () => {
    const d = shareData; if (!d || (!picked.size && !toProfile)) return;
    const btn = $('#shareSend'); btn.disabled = true; btn.textContent = 'Отправляю…';
    try {
      if (d.post) {   // пересылка публикации из ленты
        const body = $('#shareText').value.trim();
        for (const id of picked) await api(`/api/chats/${id}`, { method: 'POST', body: { kind: 'post', post: d.post, body } });
        HF.closeDialog($('#shareSheet')); HF.toast(picked.size > 1 ? `Отправлено ${picked.size} друзьям` : 'Отправлено'); refreshSocial(); return;
      }
      if (d.day) {   // мультипост: все фото дня одной публикацией, друзьям — ссылкой на неё или блюдами по очереди
        const body = $('#shareText').value.trim(), ids = [];
        for (let i = 0; i < d.images.length; i++) { btn.textContent = `Загружаю фото ${i + 1} из ${d.images.length}…`; ids.push((await uploadImage(d.images[i])).id); }
        const meta = { title: d.name, kcal: d.totals.kcal, p: d.totals.p, f: d.totals.f, c: d.totals.c, meals: d.meals };
        if (toProfile) {
          const r = await api('/api/posts', { method: 'POST', body: { media: ids[0], gallery: ids.slice(1), caption: body, meta, vis: shareVis } });
          for (const id of picked) await api(`/api/chats/${id}`, { method: 'POST', body: { kind: 'post', post: r.post.id, body } });
        } else for (const id of picked) for (let i = 0; i < ids.length; i++)
          await api(`/api/chats/${id}`, { method: 'POST', body: { kind: 'meal', media: ids[i], meta: d.meals[i], body: i === 0 ? body : '' } });
        HF.closeDialog($('#shareSheet'));
        HF.toast(toProfile && picked.size ? `День опубликован и отправлен ${picked.size}` : toProfile ? 'День опубликован в профиле' : 'Отправлено');
        refreshSocial(); window.HFPosts?.refresh(); return;
      }
      let media;
      if (d.image || d.thumb) media = (await uploadImage(d.image || d.thumb)).id;   // полное фото — для эстетики ленты
      const meta = { title: d.name, kcal: d.totals.kcal, p: d.totals.p, f: d.totals.f, c: d.totals.c, items: d.items.map(i => ({ name: i.name, grams: i.grams })) };
      const body = $('#shareText').value.trim();
      if (toProfile && media) await api('/api/posts', { method: 'POST', body: { media, caption: body, meta, vis: shareVis } });
      for (const id of picked) await api(`/api/chats/${id}`, { method: 'POST', body: { kind: 'meal', media, meta, body } });
      HF.closeDialog($('#shareSheet'));
      const saved = d.onSent?.();
      const what = toProfile && picked.size ? `Опубликовано и отправлено ${picked.size}` : toProfile ? 'Опубликовано в профиле' : picked.size > 1 ? `Отправлено ${picked.size} друзьям` : 'Отправлено';
      HF.toast(saved?.isNew ? `${what} · добавлено в дневник` : what);
      refreshSocial(); window.HFPosts?.refresh();
    } catch (e) { if (!e.network) logError('share', e); HF.toast(e.message); updShare(); }
  };

  /* ================= пуш-уведомления ================= */
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let swReg = null;
  if ('serviceWorker' in navigator && !mock) {
    navigator.serviceWorker.register('/sw.js').then(r => { swReg = r; }).catch(e => logError('sw', e));
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'push') refreshSocial();
      if (e.data?.type === 'open') route(e.data.url);
    });
  }
  const b64uToBytes = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  const swReady = () => swReg ? Promise.resolve(swReg) : Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('service worker не запустился')), 8000))]);
  async function pushStatus() {
    if (mock) return 'off';
    if (!pushSupported) return isIOS && !standalone ? 'ios-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission !== 'granted') return 'off';
    try { const sub = await (await swReady()).pushManager.getSubscription(); return sub ? 'on' : 'off'; } catch { return 'off'; }
  }
  async function enablePush() {
    if (mock) { HF.toast('В превью уведомления не работают — только на сервере'); return; }
    if (!pushSupported) { showPushHelp(isIOS && !standalone ? 'ios-install' : 'unsupported'); return; }
    const perm = await Notification.requestPermission();   // первым же действием — иначе iOS не покажет запрос
    if (perm !== 'granted') { if (perm === 'denied') showPushHelp('denied'); else HF.toast('Уведомления не включены'); renderPushUI(); return; }
    try {
      const reg = await swReady(), { key } = await api('/api/push/key');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
      HF.toast('Уведомления включены 🔔');
    } catch (e) { logError('push-subscribe', e); HF.toast('Не удалось включить уведомления: ' + e.message); }
    renderPushUI();
  }
  // при каждом входе напоминаем серверу о подписке этого устройства (после смены аккаунта, переустановки и т.п.)
  // Разрешение есть, а подписки нет (iOS иногда тихо её отзывает) — подписываемся заново, без вопросов человеку.
  // Вызываем при запуске и при каждом возвращении в приложение (iOS не перезапускает его днями).
  let pushSyncedAt = 0;
  async function syncPush(force) {
    if (!me || mock || !pushSupported || Notification.permission !== 'granted') return;
    if (!force && Date.now() - pushSyncedAt < 10 * 60_000) return;
    pushSyncedAt = Date.now();
    try {
      const reg = await swReady();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) { const { key } = await api('/api/push/key'); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) }); }
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    } catch (e) { pushSyncedAt = 0; logError('push-sync', e); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncPush(); });
  window.HFPushSync = syncPush;
  async function dropPush() {
    if (mock || !pushSupported) return;
    try { const sub = await (await swReady()).pushManager.getSubscription(); if (sub) await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch {}
  }
  function showPushHelp(kind) {
    const steps = kind === 'ios-install'
      ? `<p class="sub">На iPhone уведомления приходят только в приложение с экрана «Домой» (iOS 16.4 и новее).</p>
         <ol class="steps"><li>В Safari нажмите <b>«Поделиться»</b> — квадрат со стрелкой внизу экрана.</li>
         <li>Выберите <b>«На экран „Домой“»</b> → «Добавить».</li>
         <li>Откройте <b>Healthy Fit</b> с иконки и войдите в аккаунт — дневник подтянется из облака.</li>
         <li>Вкладка «Друзья» → <b>«Включить уведомления»</b> → «Разрешить».</li></ol>`
      : kind === 'denied'
      ? `<p class="sub">Уведомления запрещены для этого сайта. Разрешите их:</p>
         <ol class="steps"><li><b>iPhone:</b> Настройки → Уведомления → Healthy Fit → Допуск уведомлений.</li>
         <li><b>Android (Chrome):</b> значок замка слева от адреса → Разрешения → Уведомления → Разрешить.</li>
         <li>Вернитесь сюда и нажмите «Включить уведомления» ещё раз.</li></ol>`
      : `<p class="sub">Этот браузер не умеет получать уведомления. Откройте сайт в Chrome (Android) или добавьте на экран «Домой» в Safari (iPhone).</p>`;
    $('#pushHelpBody').innerHTML = steps;
    HF.openDialog($('#pushSheet'));
  }
  async function renderPushUI() {
    const st = await pushStatus();
    const label = { on: 'Включены на этом устройстве', off: 'Выключены', denied: 'Запрещены в настройках', 'ios-install': 'Нужно добавить на экран «Домой»', unsupported: 'Браузер не поддерживает' }[st];
    const row = $('#pushRow'), card = $('#pushCard');
    if (card) card.hidden = !me;
    if (row) {
      // статус + обе кнопки: «Подключить» (или «Как включить») и «Проверить» — тестовое уведомление на это устройство
      row.innerHTML = `<div><span class="push-dot ${st === 'on' ? 'on' : st === 'denied' ? 'bad' : ''}" aria-hidden="true"></span><b>${label}</b></div>
        <div class="push-btns">${st === 'on' ? '' : `<button class="btn btn-primary btn-sm" id="pushOn">${st === 'off' ? 'Подключить' : 'Как включить'}</button>`}
        <button class="btn btn-ghost btn-sm" id="pushTest"${st === 'on' ? '' : ' hidden'}>Проверить</button></div>`;
      $('#pushOn')?.addEventListener('click', enablePush);
      $('#pushTest')?.addEventListener('click', async () => {
        try { await syncPush(true); const r = await api('/api/push/test', { method: 'POST' });
          HF.toast(r.devices ? `Отправили тестовое уведомление на ${r.devices} ${plural(r.devices, 'устройство', 'устройства', 'устройств')} — придёт через пару секунд` : 'Это устройство не подписано — нажмите «Подключить»'); }
        catch (e) { HF.toast(e.message); } });
    }
    const ban = $('#pushBanner');
    if (ban) {
      let dismissed = false; try { dismissed = localStorage.getItem('hf.pushBanner') === 'off'; } catch {}
      ban.hidden = !me || st === 'on' || st === 'unsupported' || dismissed;
      if (!ban.hidden) {
        ban.innerHTML = `<svg aria-hidden="true"><use href="#i-bell"/></svg><div><b>${st === 'ios-install' ? 'Уведомления — с экрана «Домой»' : 'Уведомления о новых сообщениях'}</b></div>
          <button class="btn btn-primary btn-sm" id="pushBanOn">${st === 'off' ? 'Включить' : 'Как'}</button><button class="icon-btn" id="pushBanX" aria-label="Скрыть"><svg><use href="#i-x"/></svg></button>`;
        $('#pushBanOn').onclick = enablePush;
        $('#pushBanX').onclick = () => { try { localStorage.setItem('hf.pushBanner', 'off'); } catch {} ban.hidden = true; };
      }
    }
  }

  // ссылки из уведомлений: /?chat=ID, /?user=ID, /?post=ID, /?tab=chats
  async function route(href) {
    if (!me) return;
    const u = new URL(href || location.href, location.origin), p = u.searchParams;
    if (![...p.keys()].some(k => ['chat', 'user', 'post', 'tab', 'health'].includes(k))) return;
    try { history.replaceState(null, '', '/'); } catch {}
    try {
      if (p.get('health') === 'sync') { const ran = +(lsGet('hf.hcRun') || 0) || Date.now() - 120e3; lsSet('hf.hcRun', '0'); setTimeout(() => afterSync(false, ran), 800); }
      if (p.get('health') === 'error') { lsSet('hf.hcRun', '0'); HF.toast(`Не удалось запустить команду «${SC_NAME}». Нажмите «Добавить» ещё раз и не меняйте её название.`, 'Открыть', openHealth, 8000); }
      if (p.get('tab')) HF.showTab(p.get('tab'));
      if (p.get('chat')) {
        const id = +p.get('chat'); HF.showTab('chats');
        const f = friends.find(x => x.id === id) || (await api(`/api/users/${id}`)).user;
        if (!(peer && peer.id === id && !chatEl.hidden)) { if (!chatEl.hidden) closeChat(); openChat(f); }
      }
      if (p.get('user')) window.HFPosts?.openUser(+p.get('user'));
      if (p.get('post')) window.HFPosts?.openPost(+p.get('post'), true);
    } catch (e) { HF.toast(e.message); }
  }

  /* ================= «На экран „Домой“» ================= */
  let installEvt = null;   // Android/Chrome: системное окно установки
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderAccountCard(); });
  addEventListener('appinstalled', () => { installEvt = null; lsSet('hf.installed', '1'); });
  const isMobile = isIOS || isAndroid;
  const canOfferInstall = () => !mock && isMobile && !standalone && lsGet('hf.installed') !== '1';
  function openInstall() {
    const ios = isIOS, chromeIOS = /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
    const step = (ico, html) => `<li><span class="inst-ico"><svg aria-hidden="true"><use href="#${ico}"/></svg></span><span>${html}</span></li>`;
    $('#installSteps').innerHTML = ios
      ? (chromeIOS
        ? step('i-ios-share', 'Нажмите <b>«Поделиться»</b> в адресной строке, справа вверху')
        : step('i-dots-h', 'Нажмите <b>«•••»</b> в адресной строке Safari, справа внизу. Если её нет — сразу кнопку <b>«Поделиться»</b>')
          + step('i-ios-share', 'Выберите <b>«Поделиться»</b>'))
        + step('i-add-square', 'Пролистайте вниз и нажмите <b>«На экран „Домой“»</b>')
        + step('i-check', 'Нажмите <b>«Добавить»</b> — иконка появится рядом с другими приложениями')
      : installEvt ? step('i-check', 'Нажмите <b>«Установить»</b> ниже и подтвердите')
      : step('i-dots-v', 'Откройте меню браузера — три точки справа вверху')
        + step('i-add-square', 'Выберите <b>«Установить приложение»</b> или <b>«Добавить на главный экран»</b>');
    $('#installNote').textContent = ios ? 'В приложении с экрана «Домой» войдите тем же логином — дневник подтянется из облака.' : '';
    const main = $('#installMain'); main.textContent = !ios && installEvt ? 'Установить' : 'Понятно';
    main.onclick = async () => {
      if (!ios && installEvt) { installEvt.prompt(); const r = await installEvt.userChoice.catch(() => null); installEvt = null; if (r?.outcome === 'accepted') lsSet('hf.installed', '1'); }
      else lsSet('hf.installSeen', String(Date.now()));
      HF.closeDialog($('#installSheet'));
    };
    $('#installLater').onclick = () => lsSet('hf.installLater', String(Date.now()));
    $('#toast').classList.remove('show');   // подсказки поверх инструкции не нужны
    HF.openDialog($('#installSheet'), '#installMain');
  }
  // после регистрации — один раз, и не чаще раза в 3 дня, если отложили
  function maybeOfferInstall(delay = 900) {
    if (!canOfferInstall()) return;
    if (Date.now() - +(lsGet('hf.installLater') || 0) < 3 * 864e5 || lsGet('hf.installSeen')) return;
    setTimeout(() => { if (!document.querySelector('.sheet-wrap:not([hidden]), .chat:not([hidden]), #onb:not([hidden])')) openInstall(); }, delay);
  }
  window.HFInstall = { open: openInstall, maybe: maybeOfferInstall, can: canOfferInstall };

  /* ================= hooks ================= */
  $('#chatAva').onclick = $('#chatName').onclick = () => { if (peer && !peer.bot) window.HFPosts?.openUser(peer.id); };
  window.HFSocial = {
    onTab(name) { tab = name; if (name === 'chats') { renderAuth(); if (me) { renderInbox(); refreshSocial(); loadClients(); } } if (name === 'profile') { renderAccountCard(); renderHealthCard(); renderPushUI(); } if (name === 'activity') renderHealthCard(); },
    onSave, shareMeal, checkName, api, avaHTML, esc, flameBadge, openChat, plural, refreshSocial,
    get friends() { return friends; },
    get me() { return me; },
    async auth(mode, data) {
      const r = await api(mode === 'reg' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: data });
      me = r.me; if (mode === 'reg') { claimDiary(); await pushProfile(); } else await restoreIfEmpty();
      boot(); return me;
    },
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !chatEl.hidden && document.querySelector('.sheet-wrap:not([hidden])') === null) { e.stopPropagation(); if (R) recFinish(false); else closeChat(); } }, true);
  boot();
})();
