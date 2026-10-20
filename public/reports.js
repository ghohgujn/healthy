// Healthy Fit — «Посчитано неточно»: форма заявки из карточки блюда + разбор заявок в панели разработчика.
(() => {
  'use strict';
  const HF = window.HF; if (!HF) return;
  const $ = s => document.querySelector(s);
  const CFG = window.KBJU_CONFIG || {};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const r0 = n => Math.round(+n || 0);
  const REASON = { dish: 'Не то блюдо', weight: 'Неверный вес', missing: 'Пропущен продукт', extra: 'Лишний продукт', macros: 'Калории или БЖУ', other: 'Другое' };

  async function call(path, opts = {}) {
    if (window.HFSocial?.api) return window.HFSocial.api(path, opts);
    const r = await fetch(path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: opts.body && JSON.stringify(opts.body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Нет связи с сервером'); return d;
  }

  /* ---------- форма заявки ---------- */
  const sheet = $('#reportSheet'), form = $('#reportForm');
  let snap = null;
  $('#reportMeal').onclick = () => {
    const d = HF.draft; if (!d || !d.items?.length) return;
    // снимок того, что видит человек сейчас: фото, ответ модели и его правки
    snap = { title: HF.mealTitle(), image: d.image || d.thumb || '', thumb: d.thumb || '', model: d.model || '', confidence: d.confidence || '',
      caption: d.caption || '', ai: d.ai || null, final: d.items.map(i => ({ ...i })), totals: HF.mealTotals(d.items) };
    $('#reportThumb').hidden = !snap.thumb; if (snap.thumb) $('#reportThumb').src = snap.thumb;
    $('#reportMealName').textContent = snap.title;
    $('#reportMacros').textContent = `${r0(snap.totals.kcal)} ккал · Б ${r0(snap.totals.p)} · Ж ${r0(snap.totals.f)} · У ${r0(snap.totals.c)}`;
    form.querySelectorAll('[data-r]').forEach(b => b.setAttribute('aria-checked', 'false'));
    $('#reportText').value = ''; $('#reportErr').textContent = '';
    const btn = $('#reportSend'); btn.disabled = false; btn.textContent = 'Отправить';
    HF.openDialog(sheet, '#reportReasons [data-r]');
  };
  form.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    b.setAttribute('aria-checked', String(b.getAttribute('aria-checked') !== 'true')); $('#reportErr').textContent = '';
  });
  form.onsubmit = async e => {
    e.preventDefault(); if (!snap) return;
    const reasons = [...form.querySelectorAll('[data-r][aria-checked="true"]')].map(b => b.dataset.r);
    const comment = $('#reportText').value.trim();
    if (!reasons.length && !comment) { $('#reportErr').textContent = 'Отметьте, что не так, или напишите пару слов'; form.querySelector('[data-r]').focus(); return; }
    const btn = $('#reportSend'); btn.disabled = true; btn.textContent = 'Отправляю…';
    try {
      const body = { reasons, comment, title: snap.title, image: snap.image, model: snap.model, confidence: snap.confidence, caption: snap.caption, ai: snap.ai, final: snap.final };
      if (CFG.demo && !window.HFMockApi) await new Promise(r => setTimeout(r, 500)); else await call('/api/reports', { method: 'POST', body });
      HF.closeDialog(sheet);
      HF.toast('Спасибо! Разберём этот случай и улучшим распознавание');
    } catch (err) { $('#reportErr').textContent = err.message; btn.disabled = false; btn.textContent = 'Отправить'; }
  };

  /* ---------- разбор заявок (админ, панель разработчика) ---------- */
  const cases = $('#casesSheet'); let st = 'new';
  const itemsTable = (list, other) => list?.length ? `<table class="case-items"><tbody>${list.map(i => {
      const o = other?.find(x => x.name === i.name), changed = o && r0(o.grams) !== r0(i.grams);
      return `<tr${changed ? ' class="chg"' : ''}><td>${esc(i.name)}</td><td>${r0(i.grams)} г</td><td>${r0(i.kcal_100)}</td></tr>`; }).join('')}</tbody></table>` : '<p class="sub small">—</p>';
  async function loadCases() {
    const box = $('#casesBody'); box.innerHTML = '<div class="uv-loading"><div class="scan"></div></div>';
    try {
      const r = await call(`/api/admin/reports?status=${st}`);
      $('#casesSeg').querySelector('[data-st=new]').textContent = `Новые${r.counts.new ? ` (${r.counts.new})` : ''}`;
      if (!r.reports.length) { box.innerHTML = '<p class="sub case-empty">Заявок нет.</p>'; return; }
      box.innerHTML = r.reports.map(c => `<article class="case card" data-id="${c.id}">
          <div class="case-top">${c.media ? `<img src="${esc(c.media)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
            <div><b>#${c.id} · ${esc(c.title || 'Блюдо')}</b><small>${new Date(c.created).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${c.username ? '@' + esc(c.username) : 'без аккаунта'} · ${esc(c.model)}${c.confidence ? ' · ' + esc(c.confidence) : ''}</small>
            <div class="case-tags">${c.reasons.map(x => `<span>${REASON[x] || esc(x)}</span>`).join('')}</div></div></div>
          ${c.comment ? `<p class="case-comment">«${esc(c.comment)}»</p>` : ''}${c.caption ? `<p class="sub small">Подпись: ${esc(c.caption)}</p>` : ''}
          <div class="case-cols"><div><p class="field-label">Ответ модели</p>${itemsTable(c.ai, c.final)}</div><div><p class="field-label">После правок</p>${itemsTable(c.final, c.ai)}</div></div>
          <div class="row-btns">${c.status === 'new' ? `<button class="btn btn-primary btn-sm" data-done="${c.id}">Разобрано</button>` : `<button class="btn btn-ghost btn-sm" data-new="${c.id}">Вернуть в новые</button>`}</div>
        </article>`).join('');
      box.querySelectorAll('[data-done],[data-new]').forEach(b => b.onclick = async () => {
        try { await call(`/api/admin/reports/${b.dataset.done || b.dataset.new}`, { method: 'PATCH', body: { status: b.dataset.done ? 'done' : 'new' } }); loadCases(); } catch (e) { HF.toast(e.message); }
      });
    } catch (e) {
      box.innerHTML = `<p class="sub case-empty">${esc(e.message)}${/администратор/.test(e.message) ? '<br>Добавьте свой логин в <code>ADMIN_USERS</code> в /etc/healthy.env и перезапустите сервер.' : ''}</p>`;
    }
  }
  $('#casesSeg').querySelectorAll('[data-st]').forEach(b => b.onclick = () => {
    st = b.dataset.st; $('#casesSeg').querySelectorAll('[data-st]').forEach(x => x.setAttribute('aria-checked', String(x === b))); loadCases();
  });
  $('#devCases')?.addEventListener('click', () => { HF.closeDialog($('#devSheet')); HF.openDialog(cases); loadCases(); });
})();
