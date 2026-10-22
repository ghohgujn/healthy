// Healthy Fit — онбординг при первом запуске + скрытая панель разработчика (5 тапов по «О себе»).
(() => {
  'use strict';
  const HF = window.HF, S = () => window.HFSocial; if (!HF) return;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const el = $('#onb');
  const KEY = 'healthyfit.onboarded';
  let step = 0, mode = 'reg', acc = { name: '', username: '', password: '' }, nameOk = null;

  const P = () => HF.db.profile;
  const STEPS = ['welcome', 'account', 'goal', 'body', 'activity', 'plan'];

  function open(force) {
    step = 0; mode = 'reg';
    acc = { name: P().name || '', username: '', password: '' };
    el.hidden = false; document.body.style.overflow = 'hidden'; HF.setInert();
    render();
    if (force) $('#onbSkip').hidden = false;
  }
  function close() {
    el.hidden = true; document.body.style.overflow = ''; HF.setInert();
    if (S()?.me) window.HFInstall?.maybe(1600);   // зарегистрировался — предложим поставить на экран «Домой»
    try { localStorage.setItem(KEY, '1'); } catch {}
    HF.render();
  }

  function render() {
    const name = STEPS[step];
    $('#onbBar').style.transform = `scaleX(${(step + 1) / STEPS.length})`;
    $('#onbBack').style.visibility = step && !(step === 2 && S()?.me) ? 'visible' : 'hidden';
    $('#onbSkip').hidden = name === 'plan';
    $('#onbErr').textContent = '';
    const next = $('#onbNext'); next.disabled = false; next.hidden = false;
    const body = $('#onbBody');
    body.scrollTop = 0;

    if (name === 'welcome') {
      next.hidden = true;
      body.innerHTML = `<div class="onb-hero">
        <div class="onb-logo" aria-hidden="true"><span></span></div>
        <h1 class="onb-h" id="onbTitle">Сфоткал — и знаешь, сколько съел</h1>
        <p class="onb-p">Граммы и КБЖУ по фото за пару секунд, вода, тренировки и друзья, с которыми держать серию.</p>
        <div class="onb-actions">
          <button class="btn btn-primary" data-go="reg">Создать аккаунт</button>
          <button class="btn btn-ghost" data-go="login">У меня уже есть аккаунт</button>
        </div></div>`;
      body.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { mode = b.dataset.go; step = 1; render(); });
      return;
    }

    if (name === 'account') {
      next.textContent = mode === 'reg' ? 'Создать аккаунт' : 'Войти';
      body.innerHTML = `<h1 class="onb-h" id="onbTitle">${mode === 'reg' ? 'Как вас зовут?' : 'С возвращением'}</h1>
        <p class="onb-p">${mode === 'reg' ? 'Короткое имя — ваш @логин. По нему вас найдут друзья.' : 'Войдите — дневник подтянется из облака.'}</p>
        <form class="onb-form" id="onbForm" novalidate>
          ${mode === 'reg' ? `<label class="field"><span class="field-label">Имя</span><input class="input input-lg" name="name" maxlength="30" autocomplete="given-name" value="${esc(acc.name)}" placeholder="Илья"></label>` : ''}
          <label class="field"><span class="field-label">${mode === 'reg' ? 'Короткое имя' : 'Логин'}</span>
            <span class="uname"><span>@</span><input class="input input-lg" name="username" maxlength="20" autocapitalize="none" spellcheck="false" autocomplete="username" value="${esc(acc.username)}" placeholder="ilya.fit"></span></label>
          <p class="sub small" id="onbName"></p>
          <label class="field"><span class="field-label">Пароль</span><input class="input input-lg" name="password" type="password" minlength="6" autocomplete="${mode === 'reg' ? 'new-password' : 'current-password'}" placeholder="минимум 6 символов"></label>
          <button type="submit" hidden></button>
        </form>
        <button class="link-btn onb-switch" id="onbSwitch">${mode === 'reg' ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Создать'}</button>`;
      const f = $('#onbForm');
      const un = f.elements.namedItem('username');
      if (mode === 'reg') {
        const nm = f.elements.namedItem('name');
        nm.addEventListener('input', () => {
          acc.name = nm.value;
          if (!acc.usernameTouched) { const tr = translit(nm.value); un.value = tr; acc.username = tr; if (tr.length >= 3) S()?.checkName(tr, $('#onbName')).then(v => nameOk = v); }
        });
        un.addEventListener('input', () => { acc.usernameTouched = true; acc.username = un.value; S()?.checkName(un.value, $('#onbName')).then(v => nameOk = v); });
        if (acc.username) S()?.checkName(acc.username, $('#onbName')).then(v => nameOk = v);
      }
      f.onsubmit = e => { e.preventDefault(); next.click(); };
      $('#onbSwitch').onclick = () => { mode = mode === 'reg' ? 'login' : 'reg'; render(); };
      setTimeout(() => (f.elements.namedItem(mode === 'reg' ? 'name' : 'username') || un).focus(), 50);
      return;
    }

    if (name === 'goal') {
      next.textContent = 'Далее';
      const safe = HFCalc.safety(P());
      body.innerHTML = `<h1 class="onb-h" id="onbTitle">Какая цель?</h1><p class="onb-p">От неё зависит норма калорий и белка. Поменять можно в любой момент.</p>
        <div class="onb-goals" role="radiogroup" aria-label="Цель">${['lose_healthy', 'lose_fast', 'maintain', 'gain_lean'].map(k => {
          const g = HFCalc.GOALS[k];
          return `<button class="onb-goal" role="radio" data-goal="${k}" aria-checked="${P().goal === k}"><b>${g.label}</b><small>${g.hint}</small></button>`; }).join('')}</div>`;
      body.querySelectorAll('[data-goal]').forEach(b => b.onclick = () => {
        P().goal = b.dataset.goal; body.querySelectorAll('[data-goal]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
      });
      return;
    }

    if (name === 'body') {
      next.textContent = 'Далее';
      const p = P();
      body.innerHTML = `<h1 class="onb-h" id="onbTitle">Немного о вас</h1><p class="onb-p">Нужно для формулы Миффлина — Сан Жеора. Данные остаются у вас.</p>
        <div class="seg" role="radiogroup" aria-label="Пол"><button data-osex="m" aria-checked="${p.sex === 'm'}">Мужчина</button><button data-osex="f" aria-checked="${p.sex === 'f'}">Женщина</button></div>
        <div class="onb-grid">
          ${field('age', 'Возраст', 'лет', p.age, 14, 99, 1)}
          ${field('height', 'Рост', 'см', p.height, 120, 230, 1)}
          ${field('weight', 'Вес', 'кг', p.weight, 30, 300, 0.1)}
          ${field('target', 'Цель', 'кг', p.target || '', 30, 300, 0.1, true)}
        </div>`;
      body.querySelectorAll('[data-osex]').forEach(b => b.onclick = () => { p.sex = b.dataset.osex; body.querySelectorAll('[data-osex]').forEach(x => x.setAttribute('aria-checked', String(x === b))); });
      return;
    }

    if (name === 'activity') {
      next.textContent = 'Рассчитать норму';
      body.innerHTML = `<h1 class="onb-h" id="onbTitle">Обычная активность</h1><p class="onb-p">Только быт и работа, без тренировок. Тренировки и лишние шаги добавятся к норме в свой день.</p>
        <div class="onb-goals" role="radiogroup" aria-label="Активность">${Object.entries(HFCalc.ACTIVITY).map(([k, a]) =>
          `<button class="onb-goal" role="radio" data-act="${k}" aria-checked="${P().activity === k}"><b>${a.label}</b><small>${a.hint}</small></button>`).join('')}</div>`;
      body.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
        P().activity = b.dataset.act; body.querySelectorAll('[data-act]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
      });
      return;
    }

    if (name === 'plan') {
      const t = HFCalc.targets(P()), kc = t.p * 4 + t.f * 9 + t.c * 4, pct = v => Math.round(v / kc * 100);
      next.textContent = 'Начать';
      const me = S()?.me;
      body.innerHTML = `<h1 class="onb-h" id="onbTitle">${me ? `${esc(me.name)}, ваша норма` : 'Ваша норма'}</h1>
        <div class="onb-plan">
          <p class="onb-kcal"><b>${t.kcal}</b> ккал в день</p>
          <div class="plan-bar" aria-hidden="true"><i style="width:${pct(t.p * 4)}%;background:var(--color-protein)"></i><i style="width:${pct(t.f * 9)}%;background:var(--color-fat)"></i><i style="width:${pct(t.c * 4)}%;background:var(--color-carb)"></i></div>
          <div class="plan-legend"><span><b>${t.p} г</b>белки</span><span><b>${t.f} г</b>жиры</span><span><b>${t.c} г</b>углеводы</span></div>
          <div class="plan-meta">
            <div><b>${window.HFfmtKg(t.weeklyKg)} кг</b><span>в неделю</span></div>
            <div><b>${(t.water / 1000).toFixed(1).replace('.', ',')} л</b><span>воды в день</span></div>
            ${t.weeks ? `<div><b>${t.weeksRange[0]}–${t.weeksRange[1]} нед.</b><span>до ${P().target} кг</span></div>` : ''}
            <div><b>${t.bmi}</b><span>ИМТ</span></div>
          </div>
          ${window.HFPlanNotes(t, P())}
          ${t.safety.reasons.length ? `<p class="plan-warn">Дефицит не рекомендуется: ${t.safety.reasons.join(', ')}. Поставили поддержание.</p>` : ''}
        </div>
        <p class="onb-p small">Через 2–3 недели сверим с трендом веса и подстроим норму.</p>`;
      return;
    }
  }
  function field(k, label, unit, val, min, max, step, optional) {
    return `<label class="field onb-num"><span class="field-label">${label}${optional ? ' <i>(необязательно)</i>' : ''}</span>
      <span class="num-wrap"><input class="input input-lg" data-k="${k}" type="number" inputmode="${step < 1 ? 'decimal' : 'numeric'}" min="${min}" max="${max}" step="${step}" value="${val}"><em>${unit}</em></span></label>`;
  }
  function translit(s) {
    const m = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
    return s.toLowerCase().split('').map(c => m[c] ?? c).join('').replace(/[^a-z0-9_.]/g, '').slice(0, 20);
  }

  $('#onbNext').onclick = async () => {
    const name = STEPS[step], err = $('#onbErr'), btn = $('#onbNext');
    if (name === 'account') {
      const f = $('#onbForm'), g = k => (f.elements.namedItem(k)?.value || '').trim();
      const data = { name: g('name'), username: g('username'), password: f.elements.namedItem('password').value };
      if (mode === 'reg') {
        if (!data.name) { err.textContent = 'Укажите имя'; return; }
        if (!/^[a-z0-9_.]{3,20}$/i.test(data.username)) { err.textContent = 'Короткое имя: 3–20 символов, латиница, цифры, точка или _'; return; }
        if (nameOk === false) { err.textContent = `@${data.username} уже занято — выберите другое`; return; }
      }
      if (data.password.length < 6) { err.textContent = 'Пароль — минимум 6 символов'; return; }
      btn.disabled = true; btn.textContent = mode === 'reg' ? 'Создаю…' : 'Вхожу…';
      try {
        if (mode === 'reg') { P().name = data.name; HF.save(); }
        const me = await S().auth(mode, data);
        if (mode === 'login' && P().configured) { close(); HF.toast(`С возвращением, ${me.name}!`); return; }
        step++; render();
      } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = mode === 'reg' ? 'Создать аккаунт' : 'Войти'; }
      return;
    }
    if (name === 'body') {
      for (const inp of document.querySelectorAll('#onbBody [data-k]')) {
        const k = inp.dataset.k, raw = inp.value.trim().replace(',', '.'), v = raw === '' ? 0 : +raw;
        if (k === 'target' && !v) { P().target = 0; continue; }
        if (!(v >= +inp.min && v <= +inp.max)) { err.textContent = `${inp.closest('label').querySelector('.field-label').firstChild.textContent.trim()}: от ${inp.min} до ${inp.max}`; inp.focus(); return; }
        P()[k] = Math.round(v * 10) / 10;
      }
    }
    if (name === 'activity') {
      const t = HFCalc.targets(P());
      Object.assign(HF.db.settings, { goal: t.kcal, p: t.p, f: t.f, c: t.c, waterGoal: t.water });
      P().goal = t.goal; P().configured = true;
      const today = HF.today();
      if (!HF.db.weights.some(w => w.date === today)) HF.db.weights.push({ date: today, kg: P().weight });
      HF.save();
    }
    if (name === 'plan') { close(); HF.toast('Готово! Сфотографируйте первый приём пищи'); return; }
    step++; render();
  };
  $('#onbBack').onclick = () => { if (step > 0 && !(step === 2 && S()?.me)) { step--; render(); } };
  $('#onbSkip').onclick = () => {
    if (STEPS[step] === 'welcome' || STEPS[step] === 'account') { step = 2; render(); return; }
    close();
  };

  // первый запуск
  let seen = false; try { seen = localStorage.getItem(KEY) === '1'; } catch {}
  if (!seen && !P().configured) setTimeout(() => { open(); if (S()?.me) { step = 2; render(); } }, 600);

  /* ================= панель разработчика ================= */
  let taps = [];
  $('#aboutTitle')?.addEventListener('click', () => {
    const t = Date.now(); taps = taps.filter(x => t - x < 2500); taps.push(t);
    if (taps.length >= 5) { taps = []; if (S()?.me?.admin) openDev(); }   // панель — только администратору (@papa)
  });
  function openDev() {
    document.querySelectorAll('#devSheet input[name="model"]').forEach(r => { r.checked = r.value === HF.db.settings.model; });
    const d = HF.db, meals = Object.values(d.days).reduce((a, x) => a + (x.meals?.length || 0), 0);
    let size = 0; try { size = (localStorage.getItem('healthyfit.v1') || '').length; } catch {}
    $('#devInfo').innerHTML = `<p class="field-label">Состояние</p><p class="sub small">Аккаунт: ${S()?.me ? '@' + esc(S().me.username) : 'не вошли'} · приёмов пищи: ${meals} · дней: ${Object.keys(d.days).length} · хранилище: ${(size / 1024).toFixed(0)} КБ</p>
      <p class="field-label">Скорость распознавания</p><div class="sub small" id="devAi">Загружаю…</div>`;
    HF.openDialog($('#devSheet'));
    S()?.api('/api/admin/stats').then(r => {
      const sec = ms => (ms / 1000).toFixed(1).replace('.', ',') + ' с';
      $('#devAi').innerHTML = !r.runs ? 'Пока не было распознаваний после перезапуска сервера.' :
        `Обычно <b>${sec(r.p50)}</b>, медленные — <b>${sec(r.p95)}</b> (последние ${Math.min(50, r.runs)}). Фото ≈ ${r.kb} КБ, загрузка ${r.upload} мс.<br>
        Токены: ответ ≈ ${r.out}, из них «размышления» ≈ ${r.reasoning} · уровень размышлений: <b>${esc(r.effort)}</b> · лимит ${r.maxTokens}.<br>
        Сегодня распознаваний: ${r.today} · ошибок: ${r.fails} · пользователей: ${r.users}`;
    }).catch(e => { $('#devAi').textContent = e.message; });
  }
  $('#devOnboard').onclick = () => { HF.closeDialog($('#devSheet')); open(true); };

  /* ---------- админ: все пользователи; тап — открыть профиль целиком ---------- */
  const ago = t => { if (!t) return 'ещё не заходил'; const m = Math.round((Date.now() - t) / 60000);
    return m < 2 ? 'в сети' : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : m < 2880 ? 'вчера' : new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); };
  const since = t => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: new Date(t).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  let auT = null;
  async function loadUsers(term = '') {
    const list = $('#auList');
    try {
      const r = await S().api(`/api/admin/users?q=${encodeURIComponent(term)}`);
      $('#auStats').innerHTML = [['Всего', r.total], ['Сегодня', r.active1], ['За неделю', r.active7], ['Новых за 7 дн.', r.newWeek]]
        .map(([l, v]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
      list.innerHTML = r.users.length ? r.users.map(u => `<li><button class="au-row" data-uid="${u.id}">${S().avaHTML(u)}
        <span class="au-main"><b>${esc(u.name)}${u.admin ? '<i class="au-badge">админ</i>' : ''}</b><small>@${esc(u.username)} · с ${since(u.created)}</small></span>
        <span class="au-side"><small class="${u.seen && Date.now() - u.seen < 120000 ? 'on' : ''}">${ago(u.seen)}</small><small>${u.posts} публ. · ${u.friends} друз.</small></span></button></li>`).join('')
        : '<li class="sub au-empty">Никого не нашлось</li>';
      list.querySelectorAll('[data-uid]').forEach(b => b.onclick = () => window.HFPosts?.openUser(+b.dataset.uid));
    } catch (e) { list.innerHTML = `<li class="sub au-empty">${esc(e.message)}</li>`; }
  }
  function openUsers() { $('#auSearch').value = ''; $('#auList').innerHTML = '<li class="sub au-empty">Загружаю…</li>'; HF.openDialog($('#usersSheet')); loadUsers(); }
  $('#auSearch').addEventListener('input', e => { clearTimeout(auT); auT = setTimeout(() => loadUsers(e.target.value.trim()), 250); });
  $('#devUsers').onclick = openUsers;
  window.HFAdmin = { open: () => { if (S()?.me?.admin) openDev(); }, users: openUsers };
  $('#devHealth').onclick = async () => {
    try { const r = await (await fetch('/healthz')).json(); HF.toast(r.key ? 'Сервер работает, ключ нейросети на месте' : 'Сервер работает, но нет ключа нейросети'); }
    catch { HF.toast('Сервер не отвечает'); }
  };
  window.HFOnboarding = { open };
})();
