(() => {
  'use strict';

  /* ---------- storage ---------- */
  const KEY = 'healthyfit.v1';
  const DEFAULTS = { goal: 2000, p: 120, f: 65, c: 230, glass: 250, waterGoal: 2000, model: 'fast' };
  const CFG = window.KBJU_CONFIG || {};
  const PROFILE0 = { name: '', avatar: '', sex: 'm', age: 25, height: 175, weight: 75, target: 0, bodyFat: 0, activity: 'light', goal: 'lose_healthy', configured: false };
  let db = { settings: { ...DEFAULTS }, days: {}, profile: { ...PROFILE0 }, weights: [] };

  function validDb(d) {
    if (!d || typeof d !== 'object' || !d.days || typeof d.days !== 'object') return null;
    const days = {};
    for (const [k, v] of Object.entries(d.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') continue;
      const meals = (Array.isArray(v.meals) ? v.meals : []).filter(m => m && Array.isArray(m.items)).map(m => ({
        id: String(m.id || Math.random().toString(36).slice(2)), time: +m.time || Date.parse(k), type: String(m.type || 'Приём пищи'),
        name: String(m.name || 'Блюдо'), thumb: typeof m.thumb === 'string' && m.thumb.startsWith('data:image/') ? m.thumb : '',
        model: String(m.model || ''),
        items: m.items.map(i => ({
          name: String(i.name || 'Продукт'), role: ['food', 'drink', 'sauce'].includes(i.role) ? i.role : 'food',
          fat: ['none', 'light', 'heavy', 'included'].includes(i.fat) ? i.fat : 'none',
          grams: +i.grams || 0, kcal_100: +i.kcal_100 || 0, p_100: +i.p_100 || 0, f_100: +i.f_100 || 0, c_100: +i.c_100 || 0,
        })),
      }));
      const acts = (Array.isArray(v.acts) ? v.acts : []).filter(a => a && HFCalc.ACTIVITIES[a.type]).map(a => ({
        id: String(a.id || Math.random().toString(36).slice(2)), type: a.type, level: Math.max(0, Math.min(2, +a.level || 0)),
        min: Math.max(5, Math.min(600, +a.min || 30)) }));
      days[k] = { meals, water: Math.max(0, +v.water || 0), acts, steps: Math.max(0, Math.min(100000, +v.steps || 0)) };
    }
    const pr = d.profile && typeof d.profile === 'object' ? d.profile : {};
    const profile = { ...PROFILE0, ...pr, name: String(pr.name || '').slice(0, 30),
      avatar: typeof pr.avatar === 'string' && pr.avatar.startsWith('data:image/') ? pr.avatar : '' };
    const weights = (Array.isArray(d.weights) ? d.weights : []).filter(w => w && /^\d{4}-\d{2}-\d{2}$/.test(w.date) && +w.kg > 20 && +w.kg < 400).map(w => ({ date: w.date, kg: +w.kg }));
    const health = {};
    if (d.health && typeof d.health === 'object') for (const [k, v] of Object.entries(d.health)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v) health[k] = { steps: +v.steps || 0, active_kcal: +v.active_kcal || 0 };
    return { settings: { ...DEFAULTS, ...(d.settings && typeof d.settings === 'object' ? d.settings : {}) }, days, profile, weights, health };
  }
  try { const raw = localStorage.getItem(KEY); if (raw) db = validDb(JSON.parse(raw)) || db; } catch { /* in-memory */ }

  function save() {
    const write = () => localStorage.setItem(KEY, JSON.stringify(db));
    try { write(); window.HFSocial?.onSave(); return true; } catch {
      // free space: drop thumbnails older than 14 days, then retry once
      const cutoff = Date.now() - 14 * 864e5;
      for (const d of Object.values(db.days)) for (const m of d.meals) if (m.time < cutoff) m.thumb = '';
      try { write(); return true; } catch { return false; }
    }
  }
  const STORAGE_FULL = 'Не сохранилось: память браузера заполнена. Сделайте экспорт в настройках.';

  /* ---------- helpers ---------- */
  const $ = s => document.querySelector(s);
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => keyOf(new Date());
  const day = k => { const d = (db.days[k] ||= { meals: [], water: 0 }); d.acts ||= []; d.steps ||= 0; return d; };
  const actKcal = k => { const d = day(k), w = db.profile.weight || 75, h = (db.health || {})[k] || {};
    const manual = d.acts.reduce((a, x) => a + HFCalc.activityKcal(x.type, x.level, x.min, w), 0) + HFCalc.stepsKcal(d.steps || h.steps || 0, w);
    // активные калории из «Здоровья» уже включают тренировки с часов — берём большее, чтобы не считать дважды
    return Math.max(manual, Math.round(h.active_kcal || 0)); };
  const r0 = n => Math.round(n);
  const API = (CFG.apiBase || '').replace(/\/$/, '') + '/api/analyze';
  let selected = today();
  let lastToday = selected;

  const mealType = date => { const h = date.getHours(); return h < 11 ? 'Завтрак' : h < 16 ? 'Обед' : h < 21 ? 'Ужин' : 'Перекус'; };

  /* ---------- nutrition math (totals are computed here, never by the model) ---------- */
  const FAT_SHARE = { none: 0, light: 0.03, heavy: 0.08, included: 0 };
  function itemTotals(it) {
    // Trust the model's kcal; use Atwater only when kcal is missing (ethanol and sweeteners break 4/4/9).
    const k = it.kcal_100 > 0 ? it.kcal_100 : 4 * it.p_100 + 4 * it.c_100 + 9 * it.f_100;
    const g = it.grams / 100, addFat = it.grams * (FAT_SHARE[it.fat] || 0);
    return { kcal: k * g + addFat * 9, p: it.p_100 * g, f: it.f_100 * g + addFat, c: it.c_100 * g };
  }
  const sum = (list, fn) => list.reduce((a, x) => { const t = fn(x); a.kcal += t.kcal; a.p += t.p; a.f += t.f; a.c += t.c; return a; }, { kcal: 0, p: 0, f: 0, c: 0 });
  const mealTotals = items => sum(items, itemTotals);
  const dayTotals = k => sum(day(k).meals, m => mealTotals(m.items));

  function setRing(el, frac) {
    const len = 2 * Math.PI * +el.getAttribute('r');
    el.style.strokeDasharray = `${len}`;
    el.style.strokeDashoffset = `${len * (1 - Math.max(0, Math.min(1, frac)))}`;
  }

  /* ---------- render ---------- */
  const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  function renderWeek() {
    const box = $('#week'); box.innerHTML = '';
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i), k = keyOf(d);
      const b = document.createElement('button');
      b.className = 'day' + (db.days[k]?.meals?.length ? ' has' : '');
      b.innerHTML = `<span class="day-w">${i === 0 ? 'Сег' : WD[d.getDay()]}</span><span class="day-n">${d.getDate()}</span>`;
      b.setAttribute('aria-label', d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
      if (k === selected) b.setAttribute('aria-current', 'date');
      b.onclick = () => { selected = k; render(); };
      box.appendChild(b);
    }
  }

  function renderSummary() {
    const s = db.settings, t = dayTotals(selected), bonus = actKcal(selected), goal = s.goal + bonus, left = goal - t.kcal;
    $('#actLine').hidden = !bonus; $('#actLine').textContent = `+${bonus} ккал за активность (≈)`;
    $('#setupBanner').hidden = db.profile.configured;
    const num = $('#calLeft');
    num.textContent = r0(Math.abs(left)); num.classList.toggle('over', left < 0);
    $('#calTitle').textContent = left < 0 ? 'ккал сверх цели' : 'ккал осталось';
    $('#calEaten').textContent = `съедено ${r0(t.kcal)} из ${goal}`;
    setRing($('#calRing'), t.kcal / goal);
    for (const [m, goal] of [['p', s.p], ['f', s.f], ['c', s.c]]) {
      const card = document.querySelector(`.macro[data-m="${m}"]`);
      card.querySelector('.macro-val').innerHTML = `<b>${r0(t[m])}</b>/${goal} г`;
      setRing(card.querySelector('.ring-fg'), goal ? t[m] / goal : 0);
    }
  }

  const GLASS = 'M3 3h22l-2.6 30.2a3 3 0 0 1-3 2.8H8.6a3 3 0 0 1-3-2.8z';
  function glassSvg(i) {
    return `<svg viewBox="0 0 28 38" aria-hidden="true"><defs><clipPath id="gc${i}"><path d="${GLASS}"/></clipPath></defs>
      <path class="g-body" d="${GLASS}"/>
      <g clip-path="url(#gc${i})"><rect class="g-water" x="0" y="12" width="28" height="26"/><path class="g-wave" d="M0 13q3.5-3 7 0t7 0 7 0 7 0v3H0z"/></g>
      <path class="g-shine" d="M8.2 10l1.3 17"/><path class="g-plus" d="M14 17v8M10 21h8"/><path class="g-out" d="${GLASS}"/></svg>`;
  }
  function renderWater() {
    const s = db.settings, ml = day(selected).water;
    const count = Math.min(12, Math.max(8, Math.ceil(s.waterGoal / s.glass)));
    const filled = Math.floor(ml / s.glass + 1e-6), shown = Math.min(filled, count);
    $('#waterText').textContent = `${ml} из ${s.waterGoal} мл · стакан ${s.glass} мл`;
    $('#waterMinus').disabled = ml <= 0;
    $('#waterBarFill').style.transform = `scaleX(${Math.min(1, ml / s.waterGoal)})`;
    const box = $('#glasses'); box.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const b = document.createElement('button');
      const full = i < shown;
      b.className = 'glass' + (full ? ' full' : i === shown ? ' next' : '');
      b.innerHTML = glassSvg(i) + (i === count - 1 && filled > count ? `<span class="glass-extra">+${filled - count}</span>` : '');
      b.setAttribute('aria-label', full ? (i === shown - 1 ? `Убрать стакан, выпито ${filled}` : `Оставить ${i + 1} стакан(а)`) : `Выпито ${i + 1} стакан(а)`);
      b.onclick = () => {
        if (full && (i === shown - 1 || filled > count)) setWater(ml - s.glass); // last full glass, or over goal → minus one
        else if (full) setWater((i + 1) * s.glass);                     // tap an earlier full glass → set to it
        else setWater(Math.max(ml, (i + 1) * s.glass));                 // tap an empty glass → fill up to it
      };
      box.appendChild(b);
    }
  }
  function setWater(ml) {
    const prev = day(selected).water;
    if (ml < prev) setTimeout(() => toast(`Вода: ${Math.max(0, Math.round(ml))} мл`, 'Вернуть', () => setWater(prev)), 0);
    day(selected).water = Math.max(0, Math.min(10000, Math.round(ml)));
    if (!save()) toast(STORAGE_FULL, null, null, 6000);
    renderWater();
  }

  function renderMeals() {
    const list = $('#mealList'); list.innerHTML = '';
    const meals = day(selected).meals.slice().sort((a, b) => a.time - b.time);
    $('#mealsEmpty').hidden = meals.length > 0;
    for (const m of meals) {
      const t = mealTotals(m.items), li = document.createElement('li'), b = document.createElement('button');
      b.className = 'meal';
      const time = new Date(m.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      b.innerHTML = `${m.thumb ? '<img alt="">' : '<span class="ph"></span>'}
        <span><span class="meal-top"><span class="meal-title"></span><span class="meal-time"></span></span>
        <span class="meal-kcal">${r0(t.kcal)} ккал</span>
        <span class="meal-macros"><span style="--c:var(--color-protein)">Б ${r0(t.p)}</span><span style="--c:var(--color-fat)">Ж ${r0(t.f)}</span><span style="--c:var(--color-carb)">У ${r0(t.c)}</span></span></span>`;
      if (m.thumb) b.querySelector('img').src = m.thumb;
      b.querySelector('.meal-title').textContent = m.name;
      b.querySelector('.meal-time').textContent = `${m.type} · ${time}`;
      b.onclick = () => openMeal(m);
      li.appendChild(b); list.appendChild(li);
    }
  }

  function render() { renderWeek(); renderSummary(); renderWater(); renderMeals(); renderTop(); if (tab === 'activity') renderActivity(); if (tab === 'profile') renderProfile(); }

  /* ---------- dialogs: focus trap + scroll lock ---------- */
  const stack = [];
  function setInert() {
    const top = stack[stack.length - 1]?.el;
    for (const el of [document.querySelector('.app'), ...document.querySelectorAll('.sheet-wrap, .cam, .chat')]) el.inert = !!top && el !== top;
  }
  function openDialog(el, focusSel) {
    stack.push({ el, back: document.activeElement });
    el.hidden = false; document.body.style.overflow = 'hidden'; setInert();
    (el.querySelector(focusSel || '[data-close]:not(.scrim), button') || el).focus();
  }
  function closeDialog(el) {
    const i = stack.findIndex(s => s.el === el); if (i < 0) return;
    const [{ back }] = stack.splice(i, 1);
    el.hidden = true; if (!stack.length) document.body.style.overflow = ''; setInert();
    if (el === sheet) abortAnalysis();
    back?.focus?.();
  }
  document.querySelectorAll('.sheet-wrap').forEach(w => w.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeDialog(w); }));
  document.addEventListener('keydown', e => {
    const top = stack[stack.length - 1]; if (!top) return;
    if (e.key === 'Escape') { top.el === camEl ? closeCamera() : closeDialog(top.el); return; }
    if (e.key !== 'Tab') return;
    const f = [...top.el.querySelectorAll('button, input, summary, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });

  /* ---------- images ---------- */
  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); };
      img.src = url;
    });
  }
  function toJpeg(src, w, h, max, q) {
    const s = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  }

  /* ---------- camera ---------- */
  const camEl = $('#cam'), video = $('#camVideo');
  const cam = { stream: null, torch: false, starting: false };

  async function startStream() {
    if (cam.stream && cam.stream.getVideoTracks().some(t => t.readyState === 'live')) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'Unsupported' });
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = cam.stream;
    await video.play().catch(() => {});
    const track = cam.stream.getVideoTracks()[0];
    track.addEventListener('ended', () => { if (!camEl.hidden && !camEl.classList.contains('shot')) { cam.stream = null; showResume(); } });
    $('#camResume').hidden = true; $('#camShutter').disabled = false;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $('#camTorch').hidden = !caps.torch; cam.torch = false; $('#camTorch').setAttribute('aria-pressed', 'false');
  }
  function stopStream() {
    cam.stream?.getTracks().forEach(t => t.stop());
    cam.stream = null; video.srcObject = null;
  }
  async function openCamera() {
    camEl.classList.remove('shot'); $('#camFrozen').hidden = true; $('#camFallback').hidden = true; $('#camResume').hidden = true;
    $('#camShutter').disabled = false; video.hidden = false; $('.cam-frame').hidden = false;
    $('#camHint').textContent = 'Вся тарелка в кадре, снимайте сверху';
    openDialog(camEl, '#camShutter');
    try { await startStream(); }
    catch (e) {
      stopStream(); video.hidden = true; $('.cam-frame').hidden = true; $('#camShutter').disabled = true;
      $('#camHint').textContent = '';
      $('#camFbText').textContent = e.name === 'NotAllowedError'
        ? 'Доступ к камере запрещён. Разрешите его в настройках браузера для этого сайта или снимите фото обычной камерой.'
        : e.name === 'NotFoundError' ? 'Камера не найдена. Выберите фото из галереи.'
        : 'Встроенная камера здесь недоступна. Снимите фото камерой телефона или выберите из галереи.';
      $('#camFallback').hidden = false; $('#camNative').focus();
    }
  }
  function showResume() { $('#camResume').hidden = false; $('#camShutter').disabled = true; $('#camResume').focus(); }
  $('#camResume').onclick = () => startStream().catch(() => openCamera());
  function closeCamera() { stopStream(); closeDialog(camEl); }

  $('#openCamera').onclick = openCamera;
  $('#camClose').onclick = closeCamera;
  $('#camGallery').onclick = () => $('#photoInput').click();
  $('#camNative').onclick = () => $('#cameraInput').click();
  $('#camTorch').onclick = async () => {
    const track = cam.stream?.getVideoTracks()[0]; if (!track) return;
    try { cam.torch = !cam.torch; await track.applyConstraints({ advanced: [{ torch: cam.torch }] }); }
    catch { cam.torch = false; }
    $('#camTorch').setAttribute('aria-pressed', String(cam.torch));
  };
  $('#camShutter').onclick = () => {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) { toast('Камера ещё запускается'); return; }
    const image = toJpeg(video, w, h, 1024, 0.85), thumb = toJpeg(video, w, h, 320, 0.7);
    const fl = document.createElement('div'); fl.className = 'flash'; camEl.appendChild(fl); setTimeout(() => fl.remove(), 300);
    $('#camFrozen').src = thumb; $('#camFrozen').hidden = false; camEl.classList.add('shot');
    stopStream();
    setTimeout(() => { closeDialog(camEl); startAnalysis(image, thumb); }, 180);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (cam.stream) stopStream(); return; }
    if (!camEl.hidden && !camEl.classList.contains('shot') && $('#camFallback').hidden && !cam.stream) showResume();
    rollDay(); render();
  });

  async function onFile(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    let img;
    try { img = await loadImage(file); } catch { toast('Не удалось открыть фото. Попробуйте JPEG или PNG.'); return; }
    if (!camEl.hidden) closeCamera();
    startAnalysis(toJpeg(img, img.naturalWidth, img.naturalHeight, 1024, 0.85), toJpeg(img, img.naturalWidth, img.naturalHeight, 320, 0.7));
  }
  $('#photoInput').addEventListener('change', onFile);
  $('#cameraInput').addEventListener('change', onFile);

  /* ---------- analysis ---------- */
  const sheet = $('#mealSheet');
  let draft = null, inflight = null, reqSeq = 0;

  function sheetMode(editing) {
    $('#refine').hidden = editing; $('#deleteMeal').hidden = !editing;
    $('#saveMeal').textContent = editing ? 'Сохранить' : 'Добавить в дневник';
  }
  function showState(state) {
    $('#mealLoading').hidden = state !== 'loading';
    $('#mealError').hidden = state !== 'error';
    $('#mealResult').hidden = state !== 'result';
    $('#mealFoot').hidden = state !== 'result';
  }
  function abortAnalysis() { inflight?.abort(); inflight = null; reqSeq++; }

  function startAnalysis(image, thumb) {
    draft = { image, thumb, items: [], question: '', options: [], caption: '', editing: false, day: selected };
    $('#caption').value = ''; $('#refine').open = false; sheetMode(false);
    $('#mealPhoto').src = thumb;
    openDialog(sheet, '#cancelAnalyze');
    analyze();
  }

  const DEMO = {
    model: 'Демо-режим', confidence: 'medium', question: 'Гречка с маслом?', options: ['Без масла', 'Немного', 'Много'],
    items: [
      { name: 'Гречка отварная', role: 'food', fat: 'none', grams: 180, kcal_100: 110, p_100: 4.2, f_100: 1.1, c_100: 21.3 },
      { name: 'Котлета куриная', role: 'food', fat: 'included', grams: 95, kcal_100: 190, p_100: 16, f_100: 11, c_100: 7 },
      { name: 'Огурец', role: 'food', fat: 'none', grams: 60, kcal_100: 15, p_100: 0.8, f_100: 0.1, c_100: 2.8 },
    ],
  };

  async function analyze() {
    abortAnalysis();
    const my = ++reqSeq, ctrl = new AbortController(), d = draft;
    inflight = ctrl;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 45000);
    const slow = setTimeout(() => { if (my === reqSeq) $('#loadingHint').textContent = 'Почти готово, нейросеть внимательно смотрит на тарелку…'; }, 12000);
    $('#loadingHint').textContent = 'Определяю продукты и вес. Обычно 5–15 секунд.';
    showState('loading');
    try {
      let data;
      if (CFG.demo) {
        await new Promise((res, rej) => { const t = setTimeout(res, 1400); ctrl.signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error(), { name: 'AbortError' })); }); });
        data = JSON.parse(JSON.stringify(DEMO));
      } else {
        const r = await fetch(API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ image: d.image, caption: d.caption, model: db.settings.model }),
        });
        data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'Сервер не ответил. Попробуйте ещё раз.');
      }
      if (my !== reqSeq || d !== draft) return; // stale response
      if (!data.items || !data.items.length) throw new Error('Не вижу еды на фото. Сфотографируйте тарелку сверху, целиком.');
      Object.assign(d, { items: data.items, question: data.question || '', options: data.options || [], model: data.model, confidence: data.confidence });
      renderDraft(); showState('result'); $('#saveMeal').focus();
    } catch (err) {
      if (my !== reqSeq || d !== draft) return;
      if (err.name === 'AbortError' && !timedOut) return;
      $('#mealErrorText').textContent = timedOut ? 'Нейросеть отвечает слишком долго. Попробуйте ещё раз или переснимите.'
        : navigator.onLine === false ? 'Нет интернета. Проверьте подключение.' : err.message;
      showState('error'); $('#retryBtn').focus();
    } finally { clearTimeout(timer); clearTimeout(slow); if (inflight === ctrl) inflight = null; }
  }
  $('#cancelAnalyze').onclick = () => closeDialog(sheet);
  $('#retryBtn').onclick = analyze;
  $('#retakeBtn').onclick = () => { closeDialog(sheet); openCamera(); };
  $('#reanalyze').onclick = () => { draft.caption = $('#caption').value.trim(); analyze(); };
  $('#caption').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#reanalyze').click(); } });

  const FAT_LABEL = { none: 'без масла', light: 'немного масла', heavy: 'много масла' };
  const FAT_NEXT = { none: 'light', light: 'heavy', heavy: 'none' };
  const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
  const titleOf = items => capFirst(items.filter(i => i.role !== 'sauce').map(i => i.name).slice(0, 3).join(', ') || 'Блюдо');

  function renderDraft() {
    $('#mealName').textContent = draft.editing && draft.name ? draft.name : titleOf(draft.items);
    const conf = { low: 'низкая', medium: 'средняя', high: 'высокая' }[draft.confidence] || '';
    $('#mealMeta').textContent = [draft.model, conf && `уверенность ${conf}`].filter(Boolean).join(' · ');
    renderTotals();

    const q = $('#question');
    q.hidden = !(draft.question && draft.options.length) || draft.editing;
    if (!q.hidden) {
      $('#qText').textContent = draft.question;
      const box = $('#qOptions'); box.innerHTML = '';
      draft.options.forEach(o => {
        const c = document.createElement('button');
        c.className = 'chip'; c.textContent = o;
        c.onclick = () => { draft.caption = [draft.caption, `${draft.question} — ${o}`].filter(Boolean).join('. '); $('#caption').value = draft.caption; analyze(); };
        box.appendChild(c);
      });
    }

    const ul = $('#items'); ul.innerHTML = '';
    draft.items.forEach((it, idx) => {
      const li = document.createElement('li'); li.className = 'item';
      const fatBtn = it.fat === 'included' ? '<span>жир в составе</span>'
        : `<button class="fat-tag" data-fat>${FAT_LABEL[it.fat]}</button>`;
      li.innerHTML = `<div><p class="item-name"></p><p class="item-sub"><span class="ikcal"></span>${fatBtn}</p></div>
        <div class="stepper"><button data-d="-1" aria-label="Меньше на 10 грамм"><svg><use href="#i-minus"/></svg></button>
        <input inputmode="decimal" enterkeyhint="done" aria-label="Граммы"><button data-d="1" aria-label="Больше на 10 грамм"><svg><use href="#i-plus"/></svg></button></div>
        <button class="item-del" data-del>Убрать</button>`;
      li.querySelector('.item-name').textContent = it.name;
      const input = li.querySelector('input'), fb = li.querySelector('[data-fat]');
      const upd = g => {
        it.grams = Math.max(0, Math.min(2000, g)); input.value = r0(it.grams);
        li.querySelector('.ikcal').textContent = `${r0(itemTotals(it).kcal)} ккал`;
        if (fb) { fb.textContent = FAT_LABEL[it.fat]; fb.setAttribute('aria-label', `Масло: ${FAT_LABEL[it.fat]}. Нажмите, чтобы изменить`); }
        renderTotals();
      };
      upd(it.grams);
      li.querySelectorAll('[data-d]').forEach(b => b.onclick = () => upd(it.grams + (it.grams < 50 ? 5 : 10) * +b.dataset.d));
      input.addEventListener('change', () => upd(parseFloat(input.value.replace(',', '.')) || 0));
      input.addEventListener('focus', () => input.select());
      fb?.addEventListener('click', () => { it.fat = FAT_NEXT[it.fat]; upd(it.grams); });
      li.querySelector('[data-del]').onclick = () => {
        const [removed] = draft.items.splice(idx, 1); renderDraft();
        toast(`Убрано: ${removed.name}`, 'Вернуть', () => { draft.items.splice(idx, 0, removed); renderDraft(); });
      };
      ul.appendChild(li);
    });
    $('#saveMeal').disabled = !draft.items.length;
  }
  function renderTotals() {
    const t = mealTotals(draft.items);
    $('#tKcal').textContent = r0(t.kcal); $('#tP').textContent = r0(t.p); $('#tF').textContent = r0(t.f); $('#tC').textContent = r0(t.c);
  }

  $('#saveMeal').onclick = () => {
    if (draft.editing) {
      const m = day(draft.day).meals.find(x => x.id === draft.id);
      if (m) m.items = draft.items.map(i => ({ ...i }));
      const ok = save(); closeDialog(sheet); render(); toast(ok ? 'Сохранено' : STORAGE_FULL, null, null, ok ? 2200 : 6000);
      return;
    }
    const now = new Date(), target = draft.day;
    const time = target === today() ? now : new Date(`${target}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`);
    const meal = { id: Math.random().toString(36).slice(2), time: time.getTime(), type: mealType(time), name: titleOf(draft.items),
      thumb: draft.thumb, items: draft.items.map(i => ({ ...i })), model: draft.model || '' };
    day(target).meals.push(meal);
    const ok = save();
    closeDialog(sheet); render();
    if (!ok) { toast(STORAGE_FULL, null, null, 7000); return; }
    toast(`Добавлено · ${r0(mealTotals(meal.items).kcal)} ккал`, 'Отменить', () => {
      day(target).meals = day(target).meals.filter(x => x.id !== meal.id); save(); render();
    });
  };

  function openMeal(m) {
    abortAnalysis();
    draft = { id: m.id, name: m.name, thumb: m.thumb, items: m.items.map(i => ({ ...i })), editing: true, day: selected, model: m.model, question: '', options: [] };
    if (m.thumb) $('#mealPhoto').src = m.thumb; else $('#mealPhoto').removeAttribute('src');
    sheetMode(true); renderDraft(); showState('result'); openDialog(sheet, '#saveMeal');
  }
  $('#deleteMeal').onclick = () => {
    const d = day(draft.day), idx = d.meals.findIndex(x => x.id === draft.id); if (idx < 0) return;
    const [removed] = d.meals.splice(idx, 1); save(); closeDialog(sheet); render();
    toast('Приём пищи удалён', 'Вернуть', () => { d.meals.splice(idx, 0, removed); save(); render(); });
  };

  /* ---------- water ---------- */
  $('#waterPlus').onclick = () => setWater(day(selected).water + db.settings.glass);
  $('#waterMinus').onclick = () => setWater(day(selected).water - db.settings.glass);

  /* ---------- settings ---------- */
  const settingsSheet = $('#settingsSheet');
  const numFields = { goalKcal: 'goal', goalP: 'p', goalF: 'f', goalC: 'c', glassMl: 'glass', waterGoal: 'waterGoal' };
  function openSettings(focusSel) {
    for (const [id, k] of Object.entries(numFields)) $('#' + id).value = db.settings[k];
    document.querySelectorAll('input[name="model"]').forEach(r => { r.checked = r.value === db.settings.model; });
    openDialog(settingsSheet, focusSel);
  }
  $('#openSettings').onclick = () => openSettings();
  $('#editGoal').onclick = () => showTab('profile');
  $('#setupBanner').onclick = () => window.HFOnboarding ? window.HFOnboarding.open() : showTab('profile');
  for (const [id, k] of Object.entries(numFields)) {
    $('#' + id).addEventListener('change', e => {
      const el = e.target, v = Math.round(parseFloat(el.value));
      if (!Number.isFinite(v) || v < +el.min || v > +el.max) { el.value = db.settings[k]; toast(`Допустимо от ${el.min} до ${el.max}`); return; }
      db.settings[k] = v;
      if (!save()) toast(STORAGE_FULL, null, null, 6000);
      render();
    });
  }
  document.querySelectorAll('input[name="model"]').forEach(r => r.addEventListener('change', () => { db.settings.model = r.value; save(); }));

  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(db)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `healthy-fit-${today()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#importBtn').onclick = () => $('#importInput').click();
  $('#importInput').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    let next;
    try { next = validDb(JSON.parse(await f.text())); } catch { next = null; }
    if (!next) { toast('Файл не похож на экспорт дневника'); return; }
    const prev = db; db = next; save(); render();
    const n = Object.values(next.days).reduce((a, d) => a + d.meals.length, 0);
    toast(`Дневник загружен: ${n} приёмов пищи`, 'Отменить', () => { db = prev; save(); render(); }, 8000);
  });

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(text, actionLabel, action, ms) {
    const t = $('#toast'); t.innerHTML = '';
    const s = document.createElement('span'); s.textContent = text; t.appendChild(s);
    if (actionLabel) { const b = document.createElement('button'); b.textContent = actionLabel; b.onclick = () => { action(); t.classList.remove('show'); }; t.appendChild(b); }
    t.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || (actionLabel ? 5000 : 2200));
  }


  /* ================= v3: tabs ================= */
  let tab = 'today';
  function showTab(name) {
    tab = name;
    for (const t of ['today', 'activity', 'chats', 'profile']) $('#tab-' + t).hidden = t !== name;
    window.HFSocial?.onTab(name);
    document.querySelectorAll('.tabbtn').forEach(b => { if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    window.scrollTo(0, 0);
    render();
  }
  document.querySelectorAll('.tabbtn').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#avatarBtn').onclick = () => showTab('profile');
  $('#streakChip').onclick = () => showTab('profile');

  /* ================= v3: streak ================= */
  // День засчитывается, если записан хотя бы один приём пищи. Пропуск закрывается «заморозкой»:
  // 1 заморозка за каждые 7 дней серии, не больше 2. Сегодня не ломает серию до полуночи.
  function streakInfo() {
    const logged = k => (db.days[k]?.meals?.length || 0) > 0;
    const back = (d, n) => keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n));
    const now = new Date(), t = today();
    let count = 0, freezes = 0, used = 0, i = logged(t) ? 0 : 1;
    const marks = {};
    for (; i < 3650; i++) {
      const k = back(now, i);
      if (logged(k)) { count++; marks[k] = 'on'; if (count % 7 === 0 && freezes < 2) freezes++; continue; }
      if (freezes > 0 && count > 0 && logged(back(now, i + 1))) { freezes--; used++; marks[k] = 'frz'; continue; }
      break;
    }
    // заморозки «вперёд» считаются по хронологии; для простоты берём запас, накопленный к концу
    const best = Math.max(count, db.settings.bestStreak || 0);
    if (best !== db.settings.bestStreak) { db.settings.bestStreak = best; save(); }
    const risk = count > 0 && !logged(t) && now.getHours() >= 17;
    return { count, best, freezes, used, marks, todayDone: logged(t), risk };
  }
  function renderTop() {
    const s = streakInfo(), chip = $('#streakChip');
    $('#streakNum').textContent = s.count;
    chip.classList.toggle('on', s.count > 0 && s.todayDone);
    chip.classList.toggle('risk', s.risk);
    chip.setAttribute('aria-label', `Серия: ${s.count} дн.${s.risk ? ' Запишите еду сегодня, чтобы не потерять' : ''}`);
    paintAvatar($('#avatarTop'));
  }
  function paintAvatar(el) {
    const p = db.profile;
    if (p.avatar) { el.style.backgroundImage = `url("${p.avatar}")`; el.textContent = ''; }
    else { el.style.backgroundImage = ''; el.textContent = (p.name || '').trim().charAt(0).toUpperCase() || '·'; }
  }
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };

  /* ================= v3: activity calendar ================= */
  let calMonth = new Date(); calMonth.setDate(1);
  let actDay = today();
  const ACT_ICON = { gym: 'i-bolt', street: 'i-bolt', hiit: 'i-bolt', martial: 'i-bolt' };
  function renderActivity() {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    $('#calMonth').textContent = calMonth.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
    const first = new Date(y, m, 1), shift = (first.getDay() + 6) % 7, t = today();
    const grid = $('#calGrid'); grid.innerHTML = '';
    let monthKcal = 0, monthDays = 0, monthMin = 0;
    for (let i = 0; i < 42; i++) {
      const d = new Date(y, m, 1 - shift + i), k = keyOf(d);
      if (i >= 35 && d.getMonth() !== m) break;
      const acts = db.days[k]?.acts || [];
      const kcal = acts.length ? acts.reduce((a, x) => a + HFCalc.activityKcal(x.type, x.level, x.min, db.profile.weight || 75), 0) : 0;
      if (d.getMonth() === m && acts.length) { monthDays++; monthKcal += kcal; monthMin += acts.reduce((a, x) => a + x.min, 0); }
      const b = document.createElement('button');
      b.className = 'cday' + (d.getMonth() !== m ? ' out' : '') + (k > t ? ' future' : '') + (acts.length ? ' done' + (kcal >= 300 ? ' lvl2' : '') : '') + (k === t ? ' today' : '');
      b.textContent = d.getDate();
      b.setAttribute('aria-label', d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + (acts.length ? `, тренировок: ${acts.length}` : ''));
      b.setAttribute('aria-selected', String(k === actDay));
      b.disabled = k > t;
      b.onclick = () => { actDay = k; renderActivity(); };
      grid.appendChild(b);
    }
    $('#calStats').innerHTML = `<div><b>${monthDays}</b><span>${plural(monthDays, 'день', 'дня', 'дней')} с тренировкой</span></div>
      <div><b>${Math.round(monthMin / 60 * 10) / 10}</b><span>часов</span></div><div><b>≈${monthKcal}</b><span>ккал</span></div>`;
    const dd = new Date(actDay + 'T12:00');
    $('#dayActTitle').textContent = actDay === t ? 'Сегодня' : dd.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, c => c.toUpperCase());
    const list = $('#actList'); list.innerHTML = '';
    const dayObj = day(actDay);
    if (!dayObj.acts.length) list.innerHTML = '<li class="act-empty">Нет тренировок. Нажмите «Тренировка», чтобы отметить.</li>';
    dayObj.acts.forEach(a => {
      const def = HFCalc.ACTIVITIES[a.type], li = document.createElement('li'), b = document.createElement('button');
      b.className = 'act-item';
      b.innerHTML = `<span class="act-ico"><svg><use href="#${ACT_ICON[a.type] || 'i-flame'}"/></svg></span><span><b></b><small>${HFCalc.INTENSITY[a.level]} · ${a.min} мин</small></span><span class="act-kcal">≈${HFCalc.activityKcal(a.type, a.level, a.min, db.profile.weight || 75)} ккал</span>`;
      b.querySelector('b').textContent = def.label;
      b.onclick = () => openAct(a);
      li.appendChild(b); list.appendChild(li);
    });
    const hd = (db.health || {})[actDay] || {};
    const st = $('#stepsInput'); if (document.activeElement !== st) { st.value = dayObj.steps || ''; st.placeholder = hd.steps ? String(hd.steps) : '0'; }
    const stepsUsed = dayObj.steps || hd.steps || 0;
    $('#stepsKcal').textContent = (stepsUsed ? `≈${HFCalc.stepsKcal(stepsUsed, db.profile.weight || 75)} ккал` : 'не учтены') + (hd.active_kcal ? ` · «Здоровье»: ${Math.round(hd.active_kcal)} ккал активности` : hd.steps && !dayObj.steps ? ' · из «Здоровья»' : '');
  }
  $('#calPrev').onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); renderActivity(); };
  $('#calNext').onclick = () => { const n = new Date(calMonth); n.setMonth(n.getMonth() + 1); if (n <= new Date()) { calMonth = n; renderActivity(); } };
  $('#stepsInput').addEventListener('change', e => {
    const v = Math.max(0, Math.min(100000, Math.round(+e.target.value || 0)));
    day(actDay).steps = v; save(); render();
  });

  // activity sheet
  const actSheet = $('#actSheet');
  let actDraft = null;
  const DURS = [20, 30, 45, 60, 90];
  function openAct(existing) {
    const last = db.settings.lastAct || { type: 'gym', level: 1, min: 60 };
    actDraft = existing ? { ...existing, editing: true } : { id: Math.random().toString(36).slice(2), type: last.type, level: last.level, min: last.min, editing: false };
    $('#actDelete').hidden = !existing; $('#actSave').textContent = existing ? 'Сохранить' : 'Отметить';
    renderActSheet(); openDialog(actSheet, '#actSave');
  }
  function renderActSheet() {
    const box = $('#actTypes'); box.innerHTML = '';
    for (const [k, a] of Object.entries(HFCalc.ACTIVITIES)) {
      const b = document.createElement('button');
      b.className = 'act-type'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(k === actDraft.type));
      b.innerHTML = `<span></span>`; b.firstChild.textContent = a.label;
      b.onclick = () => { actDraft.type = k; renderActSheet(); };
      box.appendChild(b);
    }
    const hints = HFCalc.ACTIVITIES[actDraft.type].hint.split(' / ');
    $('#actHint').textContent = hints.length === 3 ? `· ${hints[actDraft.level]}` : `· ${HFCalc.ACTIVITIES[actDraft.type].hint}`;
    const seg = $('#actIntensity'); seg.innerHTML = '';
    HFCalc.INTENSITY.forEach((label, i) => {
      const b = document.createElement('button'); b.textContent = label; b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === actDraft.level)); b.onclick = () => { actDraft.level = i; renderActSheet(); };
      seg.appendChild(b);
    });
    const chips = $('#actDurChips'); chips.innerHTML = '';
    DURS.forEach(m => {
      const c = document.createElement('button'); c.className = 'chip'; c.textContent = m; c.setAttribute('role', 'radio');
      c.setAttribute('aria-checked', String(m === actDraft.min)); c.onclick = () => { actDraft.min = m; renderActSheet(); };
      chips.appendChild(c);
    });
    const inp = $('#actDur'); if (document.activeElement !== inp) inp.value = actDraft.min;
    $('#actKcal').textContent = `≈ ${HFCalc.activityKcal(actDraft.type, actDraft.level, actDraft.min, db.profile.weight || 75)}`;
  }
  $('#actDur').addEventListener('input', e => { const v = Math.round(+e.target.value); if (v >= 5 && v <= 600) { actDraft.min = v; renderActSheet(); } });
  $('#actSave').onclick = () => {
    const d = day(actDay), rec = { id: actDraft.id, type: actDraft.type, level: actDraft.level, min: actDraft.min };
    const i = d.acts.findIndex(x => x.id === rec.id);
    if (i >= 0) d.acts[i] = rec; else d.acts.push(rec);
    db.settings.lastAct = { type: rec.type, level: rec.level, min: rec.min };
    const ok = save(); closeDialog(actSheet); render();
    toast(ok ? `${HFCalc.ACTIVITIES[rec.type].label} · ≈${HFCalc.activityKcal(rec.type, rec.level, rec.min, db.profile.weight || 75)} ккал` : STORAGE_FULL);
  };
  $('#actDelete').onclick = () => {
    const d = day(actDay), i = d.acts.findIndex(x => x.id === actDraft.id); if (i < 0) return;
    const [rm] = d.acts.splice(i, 1); save(); closeDialog(actSheet); render();
    toast('Тренировка удалена', 'Вернуть', () => { d.acts.splice(i, 0, rm); save(); render(); });
  };
  $('#addActBtn').onclick = () => openAct(null);

  /* ================= v3: profile ================= */
  const GOAL_ORDER = ['lose_healthy', 'lose_fast', 'maintain', 'gain_lean'];
  function renderProfile() {
    const p = db.profile;
    paintAvatar($('#avatarBig'));
    const ni = $('#nameInput'); if (document.activeElement !== ni) ni.value = p.name;

    const s = streakInfo(), now = new Date(), wd = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    let dots = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i), k = keyOf(d);
      const cls = s.marks[k] === 'on' || (k === today() && s.todayDone) ? 'on' : s.marks[k] === 'frz' ? 'frz' : '';
      dots += `<span><i class="${cls}">${cls === 'on' ? '<svg width="14" height="14" style="color:var(--color-on-ink)"><use href="#i-flame"/></svg>' : ''}</i>${wd[i]}</span>`;
    }
    const msg = s.count === 0 ? 'Запишите приём пищи — начнётся серия.'
      : s.todayDone ? `Сегодня засчитан. Рекорд — ${s.best} ${plural(s.best, 'день', 'дня', 'дней')}.`
      : s.risk ? `Серия сгорит в полночь — запишите хотя бы один приём пищи.`
      : `Запишите еду сегодня, чтобы продолжить серию.`;
    $('#streakCard').innerHTML = `<svg class="flame"><use href="#i-flame"/></svg><div><b>${s.count} ${plural(s.count, 'день', 'дня', 'дней')}</b><p>${msg}${s.freezes ? ` Заморозок в запасе: ${s.freezes}.` : ''}</p></div><div class="streak-dots">${dots}</div>`;

    const safe = HFCalc.safety(p);
    const gg = $('#goalGrid'); gg.innerHTML = '';
    for (const k of GOAL_ORDER) {
      const g = HFCalc.GOALS[k], b = document.createElement('button');
      const blocked = !safe.deficitAllowed && k.startsWith('lose');
      b.className = 'goal'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(p.goal === k));
      if (blocked) b.setAttribute('aria-disabled', 'true');
      b.innerHTML = '<b></b><small></small>'; b.querySelector('b').textContent = g.label; b.querySelector('small').textContent = g.hint;
      b.onclick = () => { if (blocked) { toast('Дефицит не рекомендуется: ' + safe.reasons.join(', ')); return; } p.goal = k; applyProfile(); };
      gg.appendChild(b);
    }
    document.querySelectorAll('[data-sex]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.sex === p.sex)));
    const fields = { pAge: 'age', pHeight: 'height', pWeight: 'weight', pTarget: 'target', pFat: 'bodyFat' };
    for (const [id, k] of Object.entries(fields)) { const el = $('#' + id); if (document.activeElement !== el) el.value = p[k] || ''; }
    const al = $('#actLevel'); al.innerHTML = '';
    for (const [k, a] of Object.entries(HFCalc.ACTIVITY)) {
      const b = document.createElement('button'); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(p.activity === k));
      b.innerHTML = '<span></span><small></small>'; b.firstChild.textContent = a.label; b.lastChild.textContent = a.hint;
      b.onclick = () => { p.activity = k; applyProfile(); };
      al.appendChild(b);
    }
    renderPlan(); renderWeight(); renderWeekBars();
  }
  function renderPlan() {
    const p = db.profile, t = HFCalc.targets(p), kc = t.p * 4 + t.f * 9 + t.c * 4;
    const pct = v => Math.round(v / kc * 100);
    let eta = '';
    if (t.weeks) {
      const d1 = new Date(Date.now() + t.weeksRange[0] * 7 * 864e5), d2 = new Date(Date.now() + t.weeksRange[1] * 7 * 864e5);
      const f = d => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      eta = `<div><b>${f(d1)} – ${f(d2)}</b><span>цель ${p.target} кг (прогноз)</span></div>`;
    }
    $('#planCard').innerHTML = `
      <div class="plan-top"><h2 class="h2">Ваша норма</h2><span class="sub">${HFCalc.GOALS[t.goal].label}</span></div>
      <p class="plan-kcal">${t.kcal} <span class="sub">ккал в день</span></p>
      <div class="plan-bar" aria-hidden="true"><i style="width:${pct(t.p * 4)}%;background:var(--color-protein)"></i><i style="width:${pct(t.f * 9)}%;background:var(--color-fat)"></i><i style="width:${pct(t.c * 4)}%;background:var(--color-carb)"></i></div>
      <div class="plan-legend"><span><b>${t.p} г</b>белки</span><span><b>${t.f} г</b>жиры</span><span><b>${t.c} г</b>углеводы</span></div>
      <div class="plan-meta">
        <div><b>${t.bmr}</b><span>базовый обмен</span></div><div><b>${t.tdee}</b><span>расход без тренировок</span></div>
        <div><b>${t.weeklyKg > 0 ? '+' : ''}${t.weeklyKg} кг</b><span>в неделю</span></div><div><b>${(t.water / 1000).toFixed(2).replace('.', ',')} л</b><span>воды</span></div>
        ${eta}<div><b>${t.bmi}</b><span>ИМТ</span></div>
      </div>
      ${t.safety.reasons.length ? `<p class="plan-warn">Без дефицита: ${t.safety.reasons.join(', ')}. Посоветуйтесь с врачом.</p>` : ''}
      <p class="sub small">Формула ${p.bodyFat ? 'Каннингема (по % жира)' : 'Миффлина — Сан Жеора'}. Тренировки из календаря добавляются к норме в свой день. Через 2–3 недели сверьте с трендом веса.</p>`;
  }
  function applyProfile() {
    const p = db.profile, t = HFCalc.targets(p);
    p.configured = true;
    Object.assign(db.settings, { goal: t.kcal, p: t.p, f: t.f, c: t.c, waterGoal: t.water });
    if (!save()) toast(STORAGE_FULL);
    render();
  }
  $('#nameInput').addEventListener('change', e => { db.profile.name = e.target.value.trim().slice(0, 30); save(); render(); });
  document.querySelectorAll('[data-sex]').forEach(b => b.onclick = () => { db.profile.sex = b.dataset.sex; applyProfile(); });
  const LIMITS = { pAge: ['age', 14, 99], pHeight: ['height', 120, 230], pWeight: ['weight', 30, 300], pTarget: ['target', 0, 300], pFat: ['bodyFat', 0, 60] };
  for (const [id, [k, lo, hi]] of Object.entries(LIMITS)) {
    $('#' + id).addEventListener('change', e => {
      const raw = e.target.value.trim().replace(',', '.'), v = raw === '' ? 0 : +raw;
      if (!Number.isFinite(v) || (v !== 0 && (v < lo || v > hi)) || ((k === 'age' || k === 'height' || k === 'weight') && !v)) {
        e.target.value = db.profile[k] || ''; toast(`Допустимо от ${lo || 1} до ${hi}`); return;
      }
      db.profile[k] = Math.round(v * 10) / 10;
      if (k === 'weight') logWeight(db.profile.weight, false);
      applyProfile();
    });
  }
  $('#avatarInput').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const img = await loadImage(f), s = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement('canvas');
      c.width = c.height = 192;
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 192, 192);
      db.profile.avatar = c.toDataURL('image/jpeg', 0.8);
      if (!save()) toast(STORAGE_FULL); render();
    } catch { toast('Не удалось открыть фото'); }
  });

  /* weight */
  function logWeight(kg, announce = true) {
    const t = today(), i = db.weights.findIndex(w => w.date === t);
    if (i >= 0) db.weights[i].kg = kg; else db.weights.push({ date: t, kg });
    db.weights.sort((a, b) => a.date.localeCompare(b.date));
    if (announce) { db.profile.weight = kg; applyProfile(); toast(`Записано: ${kg} кг`); }
  }
  $('#weighBtn').onclick = () => {
    const v = +String($('#weighInput').value).replace(',', '.');
    if (!(v >= 30 && v <= 300)) { toast('Введите вес от 30 до 300 кг'); return; }
    logWeight(Math.round(v * 10) / 10); $('#weighInput').value = '';
  };
  function renderWeight() {
    const box = $('#wChart'), pts = HFCalc.weightTrend(db.weights.slice(-60));
    if (pts.length < 2) { box.innerHTML = `<p class="wchart-empty">Записывайте вес утром натощак 2–3 раза в неделю — покажем тренд без скачков воды.</p>`; return; }
    const W = 320, H = 150, pl = 30, pr = 8, pt = 10, pb = 20;
    const vals = pts.flatMap(p => [p.kg, p.trend]).concat(db.profile.target ? [db.profile.target] : []);
    let lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5); if (hi - lo < 2) { hi += 1; lo -= 1; }
    const t0 = Date.parse(pts[0].date), t1 = Date.parse(pts[pts.length - 1].date) || t0 + 1;
    const x = d => pl + (Date.parse(d) - t0) / Math.max(1, t1 - t0) * (W - pl - pr), y = v => pt + (hi - v) / (hi - lo) * (H - pt - pb);
    const ticks = [lo, Math.round((lo + hi) / 2 * 10) / 10, hi];
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)} ${y(p.trend).toFixed(1)}`).join(' ');
    const area = line + ` L${x(pts[pts.length - 1].date).toFixed(1)} ${H - pb} L${x(pts[0].date).toFixed(1)} ${H - pb} Z`;
    const f = d => new Date(d + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    const last = pts[pts.length - 1], first = pts[0], diff = Math.round((last.trend - first.trend) * 10) / 10;
    box.innerHTML = `<p class="sub">Тренд: <b>${last.trend} кг</b> · ${diff > 0 ? '+' : ''}${diff} кг с ${f(first.date)}</p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="График веса: тренд ${last.trend} кг">
      ${ticks.map(v => `<line class="w-grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text class="w-lbl" x="${pl - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join('')}
      ${db.profile.target && db.profile.target >= lo && db.profile.target <= hi ? `<line class="w-goal" x1="${pl}" x2="${W - pr}" y1="${y(db.profile.target)}" y2="${y(db.profile.target)}"/>` : ''}
      <path class="w-area" d="${area}" opacity="0.7"/>
      ${pts.map(p => `<circle class="w-dot" cx="${x(p.date).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="2.5"/>`).join('')}
      <path class="w-trend" d="${line}"/>
      <text class="w-lbl" x="${pl}" y="${H - 4}">${f(first.date)}</text><text class="w-lbl" x="${W - pr}" y="${H - 4}" text-anchor="end">${f(last.date)}</text>
      </svg>`;
  }
  function renderWeekBars() {
    const now = new Date(), box = $('#weekBars'), wd = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const rows = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i), k = keyOf(d);
      const goal = db.settings.goal + actKcal(k);
      rows.push({ k, wd: wd[d.getDay()], eaten: db.days[k] ? dayTotals(k).kcal : 0, goal });
    }
    const max = Math.max(...rows.map(r => Math.max(r.eaten, r.goal))) * 1.1 || 1;
    box.innerHTML = rows.map(r => `<div class="bar" title="${Math.round(r.eaten)} из ${r.goal} ккал"><div class="bar-col"><i class="${r.eaten > r.goal * 1.05 ? 'over' : ''}" style="height:${r.eaten / max * 100}%"></i><b style="bottom:${r.goal / max * 100}%"></b></div><span>${r.wd}</span></div>`).join('');
    box.setAttribute('aria-label', 'Калории за неделю: ' + rows.map(r => `${r.wd} ${Math.round(r.eaten)}`).join(', '));
  }

  $('#shareMeal').onclick = () => window.HFSocial?.shareMeal({ name: $('#mealName').textContent, thumb: draft.thumb, items: draft.items.map(i => ({ ...i })), totals: mealTotals(draft.items) });
  window.HF = { get db() { return db; }, set db(v) { db = v; }, validDb, save, day, mealTotals, openDialog, closeDialog, toast, render, streakInfo, keyOf, today, showTab, loadImage, paintAvatar, actKcal };

  /* ---------- day rollover ---------- */
  function rollDay() {
    const t = today();
    if (t !== lastToday) { if (selected === lastToday) selected = t; lastToday = t; return true; }
    return false;
  }
  setInterval(() => { if (rollDay()) render(); }, 60000);

  render();
})();
