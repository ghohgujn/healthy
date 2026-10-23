// Healthy Fit — публикации: профиль как в соцсети, лента друзей, лайки и комментарии.
(() => {
  'use strict';
  const HF = window.HF, S = () => window.HFSocial; if (!HF || !S()) return;
  const $ = s => document.querySelector(s);
  const api = (...a) => S().api(...a), esc = s => S().esc(s), avaHTML = (u, c) => S().avaHTML(u, c);
  const r0 = n => Math.round(+n || 0);
  const ago = t => {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'только что'; if (m < 60) return `${m} мин`; const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч`; const d = Math.floor(h / 24); if (d < 7) return `${d} дн`;
    return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  };
  const plural = (n, a, b, c) => S().plural(n, a, b, c);
  // 1250 → «1,3 тыс», чтобы счётчики не наезжали друг на друга в маленькой плитке
  const compact = n => n < 1000 ? String(n) : n < 1e6 ? `${String(Math.round(n / 100) / 10).replace('.', ',')} тыс` : `${String(Math.round(n / 1e5) / 10).replace('.', ',')} млн`;
  const macros = x => `<span class="pm"><b>${r0(x?.kcal)}</b> ккал</span><span class="pm" style="--c:var(--color-protein)">Б ${r0(x?.p)}</span><span class="pm" style="--c:var(--color-fat)">Ж ${r0(x?.f)}</span><span class="pm" style="--c:var(--color-carb)">У ${r0(x?.c)}</span>`;

  /* ---------- сетка публикаций ---------- */
  function grid(posts, empty) {
    if (!posts.length) return `<div class="grid-empty"><svg><use href="#i-grid"/></svg><p>${empty}</p></div>`;
    return `<div class="post-grid">${posts.map(p => `<button class="pg-item" data-post="${p.id}" aria-label="${esc(p.meta?.title || 'Публикация')}, ${r0(p.meta?.kcal)} ккал">
      <img src="${esc(p.media)}" alt="" loading="lazy">${(p.gallery || []).length > 1 ? `<span class="pg-multi" aria-hidden="true"><svg><use href="#i-grid"/></svg></span>` : ''}
      ${p.likes ? `<span class="pg-likes"><svg aria-hidden="true"><use href="#i-heart"/></svg>${compact(p.likes)}</span>` : ''}<span class="pg-meta"><span class="pg-kcal">${r0(p.meta?.kcal)}<small>ккал</small></span></span></button>`).join('')}</div>`;
  }
  const bindGrid = root => root.querySelectorAll('[data-post]').forEach(b => b.onclick = () => openPost(+b.dataset.post));

  /* ---------- сводка дня друга: кольцо калорий + БЖУ ---------- */
  function summaryCard(u) {
    const s = u.summary, first = esc((u.name || '').split(' ')[0]);
    const pct = s.goal ? s.kcal / s.goal : 0, over = s.kcal - s.goal, R = 42, L = 2 * Math.PI * R;
    const ago = s.updated ? Math.round((Date.now() - s.updated) / 60000) : null;
    const when = ago == null ? '' : ago < 2 ? 'только что' : ago < 60 ? `${ago} мин назад` : ago < 1440 ? `${Math.round(ago / 60)} ч назад` : 'давно';
    const bar = (lbl, v, goal, cls) => `<div class="sm-mac"><span class="sm-lbl"><i class="${cls}"></i>${lbl}</span>
      <span class="sm-track"><i class="${cls}" style="transform:scaleX(${Math.min(1, goal ? v / goal : 0)})"></i></span><span class="sm-val"><b>${v}</b>/${goal} г</span></div>`;
    if (!s.meals) return `<section class="sm-card sm-empty" aria-label="Сводка за сегодня"><p><b>${first} сегодня ещё ничего не записал(а)</b></p><p class="sub small">Норма — ${s.goal} ккал${when ? ` · обновлено ${when}` : ''}</p></section>`;
    return `<section class="sm-card" aria-label="Сводка ${first} за сегодня: ${s.kcal} из ${s.goal} ккал">
      <header class="sm-head"><b>Сегодня у ${first}</b><span class="sub small">${s.meals} ${plural(s.meals, 'приём', 'приёма', 'приёмов')} пищи${s.workouts ? ` · ${s.workouts} ${plural(s.workouts, 'тренировка', 'тренировки', 'тренировок')}` : ''}${when ? ` · ${when}` : ''}</span></header>
      <div class="sm-body">
        <div class="sm-ring${over > 0 ? ' over' : ''}">
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="sm-bg" cx="50" cy="50" r="${R}"/><circle class="sm-fg" cx="50" cy="50" r="${R}" stroke-dasharray="${L.toFixed(1)}" stroke-dashoffset="${(L * (1 - Math.min(1, pct))).toFixed(1)}"/></svg>
          <div class="sm-num"><b>${s.kcal}</b><span>${over > 0 ? `+${over} сверх` : `из ${s.goal}`}</span></div>
        </div>
        <div class="sm-macs">${bar('Белки', s.p, s.pGoal, 'p')}${bar('Жиры', s.f, s.fGoal, 'f')}${bar('Углеводы', s.c, s.cGoal, 'c')}
          <p class="sm-water"><svg aria-hidden="true"><use href="#i-drop"/></svg>${String(Math.round(s.water / 100) / 10).replace('.', ',')} из ${String(Math.round(s.waterGoal / 100) / 10).replace('.', ',')} л воды</p></div>
      </div></section>`;
  }

  /* ---------- свой профиль ---------- */
  let ptab = 'posts';
  async function renderOwn() {
    const me = S().me, tabs = $('#profTabs');
    tabs.hidden = !me; $('#profHandle').hidden = !me; $('#profStats').hidden = !me;
    if (!me) { $('#profPosts').hidden = true; $('#profParams').hidden = false; $('#profProgress').hidden = false; return; }
    $('#profHandle').textContent = '@' + me.username;
    tabs.querySelectorAll('[data-ptab]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.ptab === ptab)));
    $('#profPosts').hidden = ptab !== 'posts'; $('#profParams').hidden = ptab !== 'params'; $('#profProgress').hidden = ptab !== 'progress';
    if (ptab === 'progress') HF.renderStats?.();
    try {
      const r = await api(`/api/users/${me.id}`);
      const u = r.user, streak = HF.streakInfo().count;
      $('#profStats').innerHTML = `<span><b>${u.postsCount}</b>${plural(u.postsCount, 'публикация', 'публикации', 'публикаций')}</span>
        <span><b>${u.friendsCount}</b>${plural(u.friendsCount, 'друг', 'друга', 'друзей')}</span><span><b>${streak}</b>серия</span>`;
      if (ptab === 'posts') { $('#profPosts').innerHTML = grid(r.posts, 'Сфотографируйте еду и нажмите «Поделиться» → «В мой профиль». Публикации видят только друзья.'); bindGrid($('#profPosts')); }
    } catch {}
  }
  $('#profTabs').querySelectorAll('[data-ptab]').forEach(b => b.onclick = () => { ptab = b.dataset.ptab; renderOwn(); });

  /* ---------- чужой профиль ---------- */
  const uv = $('#userView');
  let uvId = null;
  async function openUser(id) {
    const me = S().me; if (!me) return;
    if (id === me.id) { HF.closeDialog(uv); HF.showTab('profile'); return; }
    uvId = id; $('#uvBody').innerHTML = '<div class="uv-loading"><div class="scan"></div></div>'; $('#uvHandle').textContent = '';
    if (uv.hidden) HF.openDialog(uv, '#uvBack');
    try {
      const r = await api(`/api/users/${id}`); if (uvId !== id) return;
      const u = r.user; $('#uvHandle').textContent = '@' + u.username;
      const act = { none: ['Добавить в друзья', 'primary'], sent: ['Заявка отправлена', 'ghost', true], incoming: ['Принять заявку', 'primary'], friends: ['Друзья ✓', 'ghost'] }[u.state];
      $('#uvBody').innerHTML = `<div class="uv-hero">
          ${avaHTML(u, 'uv-ava')}
          <div class="uv-stats"><span><b>${u.postsCount}</b>${plural(u.postsCount, 'публикация', 'публикации', 'публикаций')}</span><span><b>${u.friendsCount}</b>${plural(u.friendsCount, 'друг', 'друга', 'друзей')}</span><span><b>${u.stats?.streak || 0}</b>серия</span></div>
        </div>
        <p class="uv-name">${esc(u.name)} ${S().flameBadge(u.flame)}</p>
        ${u.bio ? `<p class="uv-bio">${esc(u.bio)}</p>` : ''}
        ${u.summary ? summaryCard(u) : ''}
        <div class="uv-actions">
          <button class="btn btn-${act[1]} btn-sm" id="uvFriend" ${act[2] ? 'disabled' : ''}>${act[0]}</button>
          ${u.state === 'friends' ? '<button class="btn btn-primary btn-sm" id="uvChat">Написать</button>' : ''}
        </div>
        <div class="uv-grid">${r.posts.length ? grid(r.posts, '') + (!r.visible && u.postsCount > r.posts.length ? '<p class="sub small grid-note">Остальные публикации видят только друзья</p>' : '')
          : r.visible || !u.postsCount ? grid([], 'Пока нет публикаций') : '<div class="grid-empty"><svg><use href="#i-grid"/></svg><p>Публикации видны только друзьям</p></div>'}</div>`;
      bindGrid($('#uvBody'));
      $('#uvChat')?.addEventListener('click', () => { HF.closeDialog(uv); S().openChat(u); });
      $('#uvFriend').onclick = async () => {
        if (u.state === 'friends') {
          HF.toast(`Удалить ${u.name} из друзей?`, 'Удалить', async () => { await api(`/api/friends/${u.id}`, { method: 'DELETE' }).catch(e => HF.toast(e.message)); S().refreshSocial(); openUser(u.id); }, 5000);
          return;
        }
        try { const x = await api(`/api/friends/${u.id}`, { method: 'POST' }); HF.toast(x.state === 'friends' ? `${u.name} теперь в друзьях` : 'Заявка отправлена'); S().refreshSocial(); openUser(u.id); }
        catch (e) { HF.toast(e.message); }
      };
    } catch (e) { $('#uvBody').innerHTML = `<p class="sub uv-err">${esc(e.message)}</p>`; }
  }
  $('#uvBack').onclick = () => HF.closeDialog(uv); uv._back = () => HF.closeDialog(uv);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !uv.hidden && $('#postSheet').hidden) { e.stopPropagation(); HF.closeDialog(uv); } }, true);

  /* ---------- лента: «Для вас» (все открытые посты по свежести) и «Друзья» ---------- */
  let scope = 'all', feedPosts = [], feedEnd = false, feedLoading = false, feedAt = 0, feedScope = '';
  try { scope = localStorage.getItem('hf.feedScope') || 'all'; } catch {}
  const segBtns = () => $('#feedSeg').querySelectorAll('[data-scope]');
  segBtns().forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.scope === scope));
    b.onclick = () => {
      if (scope === b.dataset.scope) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      scope = b.dataset.scope; try { localStorage.setItem('hf.feedScope', scope); } catch {}
      segBtns().forEach(x => x.setAttribute('aria-checked', String(x === b)));
      loadFeed(true);
    };
  });
  function feedGate() {
    const me = S().me, gate = $('#feedAuth');
    gate.hidden = !!me; $('#feedView').hidden = !me;
    if (!me) gate.innerHTML = `<div class="card auth feed-gate"><svg aria-hidden="true"><use href="#i-spark"/></svg><p class="h2">Лента еды</p>
      <p class="sub">Смотрите, что едят другие, ставьте лайки и делитесь своими блюдами. Нужен аккаунт — это 20 секунд.</p>
      <button class="btn btn-primary" id="feedLogin">Войти или создать аккаунт</button></div>`, $('#feedLogin').onclick = () => HF.showTab('chats');
    return !!me;
  }
  async function loadFeed(reset, soft) {
    if (!feedGate() || feedLoading || (!reset && feedEnd)) return;
    if (soft && feedScope === scope && Date.now() - feedAt < 30000) return;   // только что грузили — не дёргаем сеть и не перерисовываем
    feedAt = Date.now(); feedScope = scope;
    feedLoading = true;
    if (reset && !feedPosts.length) $('#feedView').innerHTML = '<div class="uv-loading"><div class="scan"></div></div>';
    try {
      const before = reset || !feedPosts.length ? '' : `&before=${feedPosts[feedPosts.length - 1].id}`;
      const r = await api(`/api/feed?scope=${scope}${before}`);
      feedPosts = reset ? r.posts : feedPosts.concat(r.posts); feedEnd = r.posts.length < 20;
      renderFeed();
    } catch (e) { $('#feedView').innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
    feedLoading = false;
  }
  // одно фото или карусель «мой день»: листаешь блюда, на каждом — его название, время и калории
  function photoBlock(p) {
    const g = p.gallery || [];
    if (g.length < 2) return `<div class="fc-photo" data-dbl="${p.id}"><img src="${esc(p.media)}" alt="${esc(p.meta?.title || 'Еда')}" loading="lazy"><i class="fc-burst"><svg><use href="#i-heart"/></svg></i></div>`;
    const ms = p.meta?.meals || [];
    return `<div class="fc-photo fc-gal" data-dbl="${p.id}" data-gal>
      <div class="gal-track" role="group" aria-roledescription="карусель" aria-label="${esc(p.meta?.title || 'Мой день')}: ${g.length} фото">
        ${g.map((u, i) => { const m = ms[i] || {}; return `<figure class="gal-slide" aria-label="${i + 1} из ${g.length}"><img src="${esc(u)}" alt="${esc(m.title || 'Блюдо')}" loading="lazy">
          ${m.title ? `<figcaption class="gal-cap"><b>${esc(m.title)}</b><span>${m.time ? esc(m.time) + ' · ' : ''}${r0(m.kcal)} ккал</span></figcaption>` : ''}</figure>`; }).join('')}
      </div>
      <span class="gal-count" aria-hidden="true">1/${g.length}</span>
      <span class="gal-dots" aria-hidden="true">${g.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</span>
      <i class="fc-burst"><svg><use href="#i-heart"/></svg></i></div>`;
  }
  function bindGal(root) {
    root.querySelectorAll('[data-gal]').forEach(el => {
      const tr = el.querySelector('.gal-track'), cnt = el.querySelector('.gal-count'), dots = [...el.querySelectorAll('.gal-dots i')];
      tr.addEventListener('scroll', () => { const i = Math.round(tr.scrollLeft / tr.clientWidth); cnt.textContent = `${i + 1}/${dots.length}`; dots.forEach((d, k) => d.classList.toggle('on', k === i)); }, { passive: true });
    });
  }
  function card(p) {
    return `<article class="fcard" data-id="${p.id}">
      <header class="fc-head"><button class="fc-author" data-user="${p.author.id}">${avaHTML(p.author)}<span><b>${esc(p.author.name)}</b><small>${ago(p.created)}${p.mine && p.vis === 'friends' ? ' · только друзьям' : ''}</small></span></button>
        ${p.mine ? `<button class="icon-btn fc-del" data-del="${p.id}" aria-label="Удалить публикацию"><svg><use href="#i-trash"/></svg></button>` : ''}</header>
      ${photoBlock(p)}
      <div class="fc-actions">
        <button class="fc-btn like ${p.liked ? 'on' : ''}" data-like="${p.id}" aria-pressed="${p.liked}" aria-label="Нравится"><svg><use href="#${p.liked ? 'i-heart' : 'i-heart-o'}"/></svg><span>${p.likes || ''}</span></button>
        <button class="fc-btn" data-open="${p.id}" aria-label="Комментарии${p.comments ? `: ${p.comments}` : ''}"><svg><use href="#i-comment"/></svg><span>${p.comments || ''}</span></button>
        <button class="fc-btn" data-send="${p.id}" aria-label="Отправить другу"><svg><use href="#i-share"/></svg></button>
      </div>
      <div class="fc-text"><p class="fc-title">${esc(p.meta?.title || '')}</p><p class="fc-macros">${macros(p.meta)}</p>
        ${p.caption ? `<p class="fc-cap"><b>${esc(p.author.name)}</b> ${esc(p.caption)}</p>` : ''}
</div>
    </article>`;
  }
  function renderFeed() {
    const box = $('#feedView');
    box.innerHTML = feedPosts.length ? feedPosts.map(card).join('') + (feedEnd ? '' : '<button class="btn btn-ghost feed-more" id="feedMore">Показать ещё</button>')
      : `<div class="grid-empty"><svg><use href="#i-grid"/></svg><p>${scope === 'all' ? 'Пока никто не поделился едой. Будьте первым — сфотографируйте блюдо и нажмите «Поделиться».' : 'Здесь появятся публикации друзей. Найдите друзей во вкладке «Чаты» — поиск по логину.'}</p></div>`;
    bindCards(box, feedPosts);
    $('#feedMore')?.addEventListener('click', () => loadFeed(false));
  }
  function bindCards(root, list) {
    bindGal(root);
    root.querySelectorAll('[data-user]').forEach(b => b.onclick = () => openUser(+b.dataset.user));
    root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openPost(+b.dataset.open, true));
    root.querySelectorAll('[data-send]').forEach(b => b.onclick = () => {
      const p = list.find(x => x.id === +b.dataset.send); if (!p) return;
      S().shareMeal({ post: p.id, name: p.meta?.title || 'Публикация', thumb: p.media, items: [], totals: { kcal: p.meta?.kcal || 0, p: p.meta?.p || 0, f: p.meta?.f || 0, c: p.meta?.c || 0 } });
    });
    root.querySelectorAll('[data-like]').forEach(b => b.onclick = () => toggleLike(list.find(p => p.id === +b.dataset.like), b));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deletePost(+b.dataset.del));
    root.querySelectorAll('[data-dbl]').forEach(el => {
      let last = 0;
      el.addEventListener('click', () => {
        const t = Date.now(); if (t - last < 320) { const p = list.find(x => x.id === +el.dataset.dbl); burst(el); if (p && !p.liked) toggleLike(p, root.querySelector(`[data-like="${p.id}"]`)); } last = t;
      });
    });
  }
  function burst(el) { el.classList.remove('burst'); void el.offsetWidth; el.classList.add('burst'); }
  async function toggleLike(p, btn) {
    if (!p) return;
    const was = p.liked; p.liked = !was; p.likes += was ? -1 : 1; paintLike(p, btn);
    try { const r = await api(`/api/posts/${p.id}/like`, { method: was ? 'DELETE' : 'POST' }); p.likes = r.likes; p.liked = r.liked; paintLike(p, btn); }
    catch (e) { p.liked = was; p.likes += was ? 1 : -1; paintLike(p, btn); HF.toast(e.message); }
  }
  function paintLike(p, btn) {
    if (!btn) return;
    btn.classList.toggle('on', p.liked); btn.setAttribute('aria-pressed', String(p.liked));
    btn.innerHTML = `<svg><use href="#${p.liked ? 'i-heart' : 'i-heart-o'}"/></svg><span>${p.likes || ''}</span>`;
  }
  async function deletePost(id) {
    HF.toast('Удалить публикацию?', 'Удалить', async () => {
      try { await api(`/api/posts/${id}`, { method: 'DELETE' }); HF.closeDialog($('#postSheet')); feedPosts = feedPosts.filter(p => p.id !== id); renderFeed(); renderOwn(); HF.toast('Публикация удалена'); }
      catch (e) { HF.toast(e.message); }
    }, 5000);
  }

  /* ---------- публикация (детально) + комментарии как в TikTok ---------- */
  let post = null, comments = [], replyTo = null;
  const openThreads = new Set();
  async function openPost(id, focusComment) {
    $('#postBody').innerHTML = '<div class="uv-loading"><div class="scan"></div></div>';
    setReply(null); openThreads.clear();
    if ($('#postSheet').hidden) HF.openDialog($('#postSheet'), '[data-close]:not(.scrim)');   // клавиатуру не открываем сами
    try {
      const r = await api(`/api/posts/${id}`); post = r.post; comments = r.comments;
      $('#postBody').innerHTML = `<button class="icon-btn icon-btn-float post-close" data-close aria-label="Закрыть"><svg><use href="#i-x"/></svg></button>
        ${card(post).replace('<article class="fcard"', '<article class="fcard in-sheet"')}
        <h3 class="cmt-title" id="cmtTitle"></h3><ul class="comments" id="comments"></ul>`;
      bindCards($('#postBody'), [post]);
      renderComments();
      // пришли за комментариями — прокручиваем к ним, но не открываем клавиатуру
      if (focusComment) requestAnimationFrame(() => $('#cmtTitle')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } catch (e) { $('#postBody').innerHTML = `<button class="icon-btn icon-btn-float post-close" data-close aria-label="Закрыть"><svg><use href="#i-x"/></svg></button><p class="sub uv-err">${esc(e.message)}</p>`; }
  }
  const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // голосовой комментарий — плеер-пилюля; кружок — маленький круг, по тапу крупнее и со звуком
  function mediaHTML(c) {
    const d = Math.max(1, Math.round(c.dur || 0));
    if (c.kind === 'voice') return `<div class="cmt-voice" data-voice="${c.id}"><button class="cv-play" type="button" aria-label="Воспроизвести, ${fmtDur(d)}"><svg><use href="#i-play"/></svg></button>
      <span class="cv-wave" aria-hidden="true">${Array.from({ length: 22 }, (_, i) => `<i style="height:${25 + Math.abs(Math.sin(c.id * 5 + i * 1.9)) * 75}%"></i>`).join('')}</span><span class="cv-dur">${fmtDur(d)}</span></div>`;
    return `<div class="cmt-circle" data-circle="${c.id}" role="button" tabindex="0" aria-label="Кружок, ${fmtDur(d)}"><video playsinline muted preload="metadata" src="${esc(c.media)}#t=0.1"></video><span class="cc-play" aria-hidden="true"><svg><use href="#i-play"/></svg></span><span class="cc-dur">${fmtDur(d)}</span></div>`;
  }
  function bindMedia(box) {
    box.querySelectorAll('[data-voice]').forEach(el => {
      const c = comments.find(x => x.id === +el.dataset.voice), btn = el.querySelector('.cv-play'), bars = [...el.querySelectorAll('.cv-wave i')], dd = el.querySelector('.cv-dur');
      const a = new Audio(); a.preload = 'none'; a.src = c.media; const D = Math.max(1, c.dur || 0);
      btn.onclick = e => { e.stopPropagation(); document.querySelectorAll('audio, video').forEach(x => x !== a && x.pause()); a.paused ? a.play().catch(() => HF.toast('Не удалось воспроизвести')) : a.pause(); };
      a.onplay = () => { btn.innerHTML = '<svg><use href="#i-pause"/></svg>'; el.classList.add('playing'); };
      a.onpause = () => { btn.innerHTML = '<svg><use href="#i-play"/></svg>'; el.classList.remove('playing'); };
      a.onended = () => { a.onpause(); bars.forEach(b => b.classList.remove('on')); dd.textContent = fmtDur(D); };
      a.ontimeupdate = () => { const d = isFinite(a.duration) && a.duration ? a.duration : D, k = Math.round(a.currentTime / d * bars.length); bars.forEach((b, i) => b.classList.toggle('on', i < k)); dd.textContent = fmtDur(Math.max(0, d - a.currentTime)); };
      el.onclick = e => e.stopPropagation();
    });
    box.querySelectorAll('[data-circle]').forEach(el => {
      const v = el.querySelector('video');
      el.onclick = e => {
        e.stopPropagation();
        if (el.classList.contains('playing')) { v.pause(); el.classList.remove('playing'); v.muted = true; return; }
        document.querySelectorAll('audio').forEach(x => x.pause()); document.querySelectorAll('.cmt-circle.playing').forEach(o => o !== el && o.click());
        el.classList.add('playing'); v.muted = false; v.currentTime = 0; v.play().catch(() => el.classList.remove('playing'));
      };
      v.onended = () => { el.classList.remove('playing'); v.muted = true; };
    });
  }
  function commentHTML(c) {
    const me = S().me, own = c.author.id === me?.id;
    return `<li class="cmt${c.parent ? ' is-reply' : ''}" data-cid="${c.id}">
      <span class="cmt-swipe" aria-hidden="true"><svg><use href="#i-reply"/></svg></span>
      <div class="cmt-row">
        <button class="cmt-ava" data-user="${c.author.id}" aria-label="Профиль: ${esc(c.author.name)}">${avaHTML(c.author)}</button>
        <div class="cmt-main" data-tap="${c.id}">
          <p class="cmt-name">${esc(c.author.name)}${c.author.id === post.author.id ? '<span class="cmt-badge">Автор</span>' : ''}</p>
          ${c.kind === 'voice' || c.kind === 'video' ? `${c.replyTo && c.parent ? `<p class="cmt-text"><span class="cmt-to">@${esc(c.replyTo.username)}</span></p>` : ''}${mediaHTML(c)}`
            : `<p class="cmt-text">${c.replyTo && c.parent ? `<span class="cmt-to">@${esc(c.replyTo.username)}</span> ` : ''}${esc(c.body)}</p>`}
          <p class="cmt-meta"><span>${ago(c.created)}</span><button class="cmt-act" data-reply="${c.id}">Ответить</button>${own || post.mine ? `<button class="cmt-act" data-cdel="${c.id}">Удалить</button>` : ''}</p>
        </div>
        <button class="cmt-like${c.liked ? ' on' : ''}" data-clike="${c.id}" aria-pressed="${c.liked}" aria-label="Нравится комментарий${c.likes ? `, ${c.likes}` : ''}">
          <svg><use href="#${c.liked ? 'i-heart' : 'i-heart-o'}"/></svg><span>${c.likes || ''}</span></button>
      </div></li>`;
  }
  function renderComments() {
    const roots = comments.filter(c => !c.parent), box = $('#comments');
    $('#cmtTitle').textContent = comments.length ? `${comments.length} ${plural(comments.length, 'комментарий', 'комментария', 'комментариев')}` : '';
    if (!roots.length) { box.innerHTML = '<li class="sub no-comments">Комментариев пока нет — будьте первым.</li>'; return; }
    box.innerHTML = roots.map(c => {
      const reps = comments.filter(x => x.parent === c.id), open = openThreads.has(c.id) || reps.length <= 1;
      return commentHTML(c) + (reps.length ? `<li class="cmt-thread"><ul>${open ? reps.map(commentHTML).join('') : ''}</ul>
        ${open ? '' : `<button class="cmt-more" data-thread="${c.id}"><i></i>Показать ответы (${reps.length})</button>`}</li>` : '');
    }).join('');
    bindComments(); bindMedia(box);
  }
  function setReply(c) {
    replyTo = c;
    $('#replyChip').hidden = !c;
    $('#commentInput').placeholder = c ? `Ответ для @${c.author.username}` : 'Комментарий…';
    if (c) { $('#replyChipText').textContent = `Ответ для ${c.author.name}`; $('#commentInput').focus(); }
  }
  $('#replyCancel').onclick = () => setReply(null);
  function bindComments() {
    const box = $('#comments');
    box.querySelectorAll('[data-user]').forEach(b => b.onclick = e => { e.stopPropagation(); HF.closeDialog($('#postSheet')); openUser(+b.dataset.user); });
    box.querySelectorAll('[data-reply]').forEach(b => b.onclick = e => { e.stopPropagation(); setReply(comments.find(c => c.id === +b.dataset.reply)); });
    box.querySelectorAll('[data-thread]').forEach(b => b.onclick = () => { openThreads.add(+b.dataset.thread); renderComments(); });
    box.querySelectorAll('[data-cdel]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      HF.toast('Удалить комментарий?', 'Удалить', async () => {
        try { const r = await api(`/api/comments/${b.dataset.cdel}`, { method: 'DELETE' });
          const gone = new Set(r.removed || [+b.dataset.cdel]); comments = comments.filter(c => !gone.has(c.id));
          post.comments = Math.max(0, post.comments - gone.size); renderComments(); syncCount(); } catch (err) { HF.toast(err.message); }
      }, 5000);
    });
    box.querySelectorAll('[data-clike]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const c = comments.find(x => x.id === +b.dataset.clike), was = c.liked;
      c.liked = !was; c.likes += was ? -1 : 1; paintCLike(b, c);
      try { const r = await api(`/api/comments/${c.id}/like`, { method: was ? 'DELETE' : 'POST' }); c.likes = r.likes; c.liked = r.liked; paintCLike(b, c); }
      catch (err) { c.liked = was; c.likes += was ? 1 : -1; paintCLike(b, c); HF.toast(err.message); }
    });
    // свайп влево по комментарию — ответить, ровно как в сообщениях: строка едет за пальцем, справа появляется стрелка,
    // после 56 px — вибрация и «готово», дальше «резинка». Тянуть можно с любого места строки, кроме плеера.
    box.querySelectorAll('.cmt').forEach(li => {
      const c = comments.find(x => x.id === +li.dataset.cid), row = li.querySelector('.cmt-row');
      let x0 = 0, y0 = 0, dx = 0, on = false, moved = false, armed = false;
      const paint = () => { row.style.transform = dx ? `translateX(${dx}px)` : ''; li.style.setProperty('--sw', Math.min(1, -dx / 56).toFixed(3)); };
      li.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button) return;
        if (e.target.closest('.cmt-voice, .cmt-circle')) return;
        x0 = e.clientX; y0 = e.clientY; dx = 0; on = true; moved = false; armed = false;
      });
      li.addEventListener('pointermove', e => {
        if (!on) return;
        const ddx = e.clientX - x0, ddy = e.clientY - y0;
        if (!moved && Math.abs(ddy) > 10 && Math.abs(ddy) > Math.abs(ddx)) { on = false; return; }   // вертикальная прокрутка
        if (ddx < -6) {
          if (!moved) { moved = true; row.style.transition = 'none'; try { li.setPointerCapture(e.pointerId); } catch {} }
          dx = Math.max(-100, ddx > -64 ? ddx : -64 + (ddx + 64) * 0.4);
          paint();
          const a = dx < -56; if (a !== armed) { armed = a; li.classList.toggle('armed', a); if (a) try { navigator.vibrate?.(12); } catch {} }
        }
      });
      const end = () => {
        if (!on) return; on = false;
        row.style.transition = ''; dx = 0; paint(); li.style.removeProperty('--sw');
        if (armed) { armed = false; li.classList.remove('armed'); setReply(c); }
        if (moved) { li.dataset.swiped = '1'; setTimeout(() => delete li.dataset.swiped, 350); }   // после свайпа не срабатывают лайк и «Ответить» под пальцем
      };
      li.addEventListener('pointerup', end); li.addEventListener('pointercancel', end);
      li.addEventListener('click', e => { if (li.dataset.swiped) { e.stopPropagation(); e.preventDefault(); } }, true);
      li.querySelector('.cmt-main').addEventListener('click', e => { if (!moved && !e.target.closest('.cmt-voice, .cmt-circle')) setReply(c); });
    });
  }
  function paintCLike(b, c) {
    b.classList.toggle('on', c.liked); b.setAttribute('aria-pressed', String(c.liked));
    b.innerHTML = `<svg><use href="#${c.liked ? 'i-heart' : 'i-heart-o'}"/></svg><span>${c.likes || ''}</span>`;
  }
  function syncCount() {
    const f = feedPosts.find(p => p.id === post.id); if (f) { f.comments = post.comments; if (!$('#feedView').hidden) renderFeed(); }
    $('#postBody').querySelectorAll(`[data-open="${post.id}"] span`).forEach(s => s.textContent = post.comments || '');
  }
  $('#commentForm').onsubmit = async e => {
    e.preventDefault(); if (!post) return;
    const inp = $('#commentInput'), body = inp.value.trim(); if (!body) return;
    inp.value = ''; inp.dispatchEvent(new Event('input')); const to = replyTo;
    try {
      const r = await api(`/api/posts/${post.id}/comments`, { method: 'POST', body: to ? { body, parent: to.id } : { body } });
      comments.push(r.comment); if (r.comment.parent) openThreads.add(r.comment.parent);
      post.comments++; setReply(null); renderComments(); syncCount();
      const el = $(`#comments [data-cid="${r.comment.id}"]`); el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el?.classList.add('fresh');
    } catch (err) { inp.value = body; inp.dispatchEvent(new Event('input')); HF.toast(err.message); }
  };


  /* ---------- голосовые и кружки в комментариях ----------
     Поле пустое — на кнопке микрофон. Тап переключает «голос ↔ кружок», удержание пишет, отпустил — отправилось,
     увёл палец влево — отмена (как в чате). */
  {
    const btn = $('#cmtMain'), inp = $('#commentInput'), form = $('#commentForm');
    const pickType = list => (window.MediaRecorder && list.find(t => MediaRecorder.isTypeSupported(t))) || '';
    let mode = 'voice'; try { mode = localStorage.getItem('hf.cmtMode') === 'video' ? 'video' : 'voice'; } catch {}
    let R = null, press = null;
    const paint = () => {
      const has = inp.value.trim().length > 0;
      btn.innerHTML = `<svg><use href="#${has ? 'i-send' : mode === 'video' ? 'i-circle' : 'i-mic'}"/></svg>`;
      btn.setAttribute('aria-label', has ? 'Отправить комментарий' : mode === 'video' ? 'Кружок: удерживайте, чтобы записать; тап — голосовое' : 'Голосовое: удерживайте, чтобы записать; тап — кружок');
    };
    inp.addEventListener('input', paint); paint();
    const ui = on => {
      form.classList.toggle('recording', on); form.classList.toggle('rec-video', on && R?.mode === 'video');
      $('#cmtRec').hidden = !on; inp.hidden = on; $('#cmtCircle').hidden = !(on && R?.mode === 'video');
      if (on) { $('#cmtRecTime').textContent = '0:00'; form.classList.remove('rec-cancel'); }
      if (!on) paint();
    };
    async function start() {
      if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) { HF.toast('Запись не поддерживается в этом браузере'); return; }
      const r = R = { mode, chunks: [], ready: false };
      ui(true); try { navigator.vibrate?.(14); } catch {}
      try { r.stream = await navigator.mediaDevices.getUserMedia(mode === 'voice' ? { audio: { echoCancellation: true, noiseSuppression: true } } : { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } }); }
      catch { if (R === r) { R = null; ui(false); } HF.toast(mode === 'voice' ? 'Нет доступа к микрофону' : 'Нет доступа к камере'); return; }
      if (R !== r) { r.stream.getTracks().forEach(t => t.stop()); return; }
      if (r.mode === 'video') { const v = $('#cmtCircleVideo'); v.srcObject = r.stream; v.muted = true; v.play().catch(() => {}); }
      const type = r.mode === 'voice' ? pickType(['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']) : pickType(['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']);
      r.mr = new MediaRecorder(r.stream, type ? (r.mode === 'voice' ? { mimeType: type, audioBitsPerSecond: 48000 } : { mimeType: type, videoBitsPerSecond: 900_000 }) : undefined);
      r.mr.ondataavailable = e => e.data.size && r.chunks.push(e.data);
      r.mr.start(250); r.t0 = Date.now(); r.ready = true;
      const max = r.mode === 'voice' ? 120 : 60;
      r.timer = setInterval(() => { const s = (Date.now() - r.t0) / 1000; $('#cmtRecTime').textContent = fmtDur(s); if (s >= max) finish(true); }, 200);
    }
    function finish(send) {
      const r = R; if (!r) return; R = null; clearInterval(r.timer); ui(false);
      const v = $('#cmtCircleVideo'); v.pause(); v.srcObject = null;
      if (!r.ready) return;
      r.mr.onstop = async () => {
        r.stream.getTracks().forEach(t => t.stop());
        if (!send || !post) return;
        const dur = (Date.now() - r.t0) / 1000; if (dur < 0.8) { HF.toast('Слишком коротко — удерживайте кнопку'); return; }
        const blob = new Blob(r.chunks, { type: (r.mr.mimeType || (r.mode === 'voice' ? 'audio/webm' : 'video/webm')).split(';')[0] });
        const to = replyTo;
        try {
          const up = await api('/api/media', { method: 'POST', body: blob });
          const res = await api(`/api/posts/${post.id}/comments`, { method: 'POST', body: { kind: r.mode, media: up.id, meta: { dur }, ...(to ? { parent: to.id } : {}) } });
          comments.push(res.comment); if (res.comment.parent) openThreads.add(res.comment.parent);
          post.comments++; setReply(null); renderComments(); syncCount();
          $(`#comments [data-cid="${res.comment.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch (e) { HF.toast(e.message); }
      };
      try { r.mr.stop(); } catch { r.stream.getTracks().forEach(t => t.stop()); }
    }
    btn.addEventListener('pointerdown', e => {
      if (inp.value.trim()) return;
      e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch {}
      press = { x: e.clientX, timer: setTimeout(() => { if (press) { press.held = true; start(); } }, 220) };
    });
    btn.addEventListener('pointermove', e => { if (!press?.held || !R) return; const c = e.clientX - press.x < -80; R.cancel = c; form.classList.toggle('rec-cancel', c); });
    btn.addEventListener('pointerup', () => {
      if (!press) return; clearTimeout(press.timer); const p = press; press = null;
      if (!p.held) { mode = mode === 'voice' ? 'video' : 'voice'; try { localStorage.setItem('hf.cmtMode', mode); } catch {} paint(); HF.toast(mode === 'video' ? 'Кружок: удерживайте кнопку' : 'Голосовое: удерживайте кнопку'); return; }
      finish(!R?.cancel);
    });
    btn.addEventListener('pointercancel', () => { if (press) { clearTimeout(press.timer); if (press.held) finish(false); press = null; } });
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('click', e => { if (!inp.value.trim()) e.preventDefault(); });
    new MutationObserver(() => { if ($('#postSheet').hidden && R) finish(false); }).observe($('#postSheet'), { attributes: true, attributeFilter: ['hidden'] });
  }

  /* ---------- хуки ---------- */
  const prevOnTab = S().onTab;
  S().onTab = name => { prevOnTab(name); if (name === 'profile') renderOwn(); if (name === 'feed') loadFeed(true, true); };
  window.HFPosts = { openUser, openPost, refresh() { renderOwn(); if (!$('#tab-feed').hidden) loadFeed(true); } };
})();
