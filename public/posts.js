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
      <img src="${esc(p.media)}" alt="" loading="lazy">
      ${p.likes ? `<span class="pg-likes"><svg aria-hidden="true"><use href="#i-heart"/></svg>${compact(p.likes)}</span>` : ''}<span class="pg-meta"><span class="pg-kcal">${r0(p.meta?.kcal)}<small>ккал</small></span></span></button>`).join('')}</div>`;
  }
  const bindGrid = root => root.querySelectorAll('[data-post]').forEach(b => b.onclick = () => openPost(+b.dataset.post));

  /* ---------- свой профиль ---------- */
  let ptab = 'posts';
  async function renderOwn() {
    const me = S().me, tabs = $('#profTabs');
    tabs.hidden = !me; $('#profHandle').hidden = !me; $('#profStats').hidden = !me;
    if (!me) { $('#profPosts').hidden = true; $('#profParams').hidden = false; return; }
    $('#profHandle').textContent = '@' + me.username;
    tabs.querySelectorAll('[data-ptab]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.ptab === ptab)));
    $('#profPosts').hidden = ptab !== 'posts'; $('#profParams').hidden = ptab !== 'params';
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
  let scope = 'all', feedPosts = [], feedEnd = false, feedLoading = false;
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
  async function loadFeed(reset) {
    if (!feedGate() || feedLoading || (!reset && feedEnd)) return;
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
  function card(p) {
    return `<article class="fcard" data-id="${p.id}">
      <header class="fc-head"><button class="fc-author" data-user="${p.author.id}">${avaHTML(p.author)}<span><b>${esc(p.author.name)}</b><small>${ago(p.created)}${p.mine && p.vis === 'friends' ? ' · только друзьям' : ''}</small></span></button>
        ${p.mine ? `<button class="icon-btn fc-del" data-del="${p.id}" aria-label="Удалить публикацию"><svg><use href="#i-trash"/></svg></button>` : ''}</header>
      <div class="fc-photo" data-dbl="${p.id}"><img src="${esc(p.media)}" alt="${esc(p.meta?.title || 'Еда')}" loading="lazy"><i class="fc-burst"><svg><use href="#i-heart"/></svg></i></div>
      <div class="fc-actions">
        <button class="fc-btn like ${p.liked ? 'on' : ''}" data-like="${p.id}" aria-pressed="${p.liked}" aria-label="Нравится"><svg><use href="#${p.liked ? 'i-heart' : 'i-heart-o'}"/></svg><span>${p.likes || ''}</span></button>
        <button class="fc-btn" data-open="${p.id}" aria-label="Комментарии${p.comments ? `: ${p.comments}` : ''}"><svg><use href="#i-comment"/></svg><span>${p.comments || ''}</span></button>
        <button class="fc-btn" data-send="${p.id}" aria-label="Отправить другу"><svg><use href="#i-send"/></svg></button>
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
    if ($('#postSheet').hidden) HF.openDialog($('#postSheet'), focusComment ? '#commentInput' : '[data-close]:not(.scrim)');
    try {
      const r = await api(`/api/posts/${id}`); post = r.post; comments = r.comments;
      $('#postBody').innerHTML = `<button class="icon-btn icon-btn-float post-close" data-close aria-label="Закрыть"><svg><use href="#i-x"/></svg></button>
        ${card(post).replace('<article class="fcard"', '<article class="fcard in-sheet"')}
        <h3 class="cmt-title" id="cmtTitle"></h3><ul class="comments" id="comments"></ul>`;
      bindCards($('#postBody'), [post]);
      renderComments();
      if (focusComment) $('#commentInput').focus();
    } catch (e) { $('#postBody').innerHTML = `<button class="icon-btn icon-btn-float post-close" data-close aria-label="Закрыть"><svg><use href="#i-x"/></svg></button><p class="sub uv-err">${esc(e.message)}</p>`; }
  }
  function commentHTML(c) {
    const me = S().me, own = c.author.id === me?.id;
    return `<li class="cmt${c.parent ? ' is-reply' : ''}" data-cid="${c.id}">
      <span class="cmt-swipe" aria-hidden="true"><svg><use href="#i-reply"/></svg></span>
      <div class="cmt-row">
        <button class="cmt-ava" data-user="${c.author.id}" aria-label="Профиль: ${esc(c.author.name)}">${avaHTML(c.author)}</button>
        <div class="cmt-main" data-tap="${c.id}">
          <p class="cmt-name">${esc(c.author.name)}${c.author.id === post.author.id ? '<span class="cmt-badge">Автор</span>' : ''}</p>
          <p class="cmt-text">${c.replyTo && c.parent ? `<span class="cmt-to">@${esc(c.replyTo.username)}</span> ` : ''}${esc(c.body)}</p>
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
    bindComments();
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
    // тап по комментарию — ответить; свайп влево — тоже ответить (как в TikTok)
    box.querySelectorAll('.cmt').forEach(li => {
      const c = comments.find(x => x.id === +li.dataset.cid), row = li.querySelector('.cmt-row');
      let x0 = 0, y0 = 0, dx = 0, drag = false, moved = false;
      li.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; x0 = e.clientX; y0 = e.clientY; dx = 0; drag = true; moved = false; });
      li.addEventListener('pointermove', e => {
        if (!drag) return;
        const ddx = e.clientX - x0, ddy = e.clientY - y0;
        if (!moved && Math.abs(ddy) > 10 && Math.abs(ddy) > Math.abs(ddx)) { drag = false; return; }   // это вертикальная прокрутка
        if (ddx < -8) { moved = true; dx = Math.max(-84, ddx); row.style.transform = `translateX(${dx}px)`; li.classList.toggle('armed', dx < -56); li.style.setProperty('--sw', Math.min(1, -dx / 56)); }
      });
      const end = () => {
        if (!drag) return; drag = false;
        row.style.transform = ''; li.style.removeProperty('--sw');
        if (li.classList.contains('armed')) { li.classList.remove('armed'); try { navigator.vibrate?.(15); } catch {} setReply(c); }
      };
      li.addEventListener('pointerup', end); li.addEventListener('pointercancel', end); li.addEventListener('pointerleave', end);
      li.querySelector('.cmt-main').addEventListener('click', () => { if (!moved) setReply(c); });
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
    inp.value = ''; const to = replyTo;
    try {
      const r = await api(`/api/posts/${post.id}/comments`, { method: 'POST', body: to ? { body, parent: to.id } : { body } });
      comments.push(r.comment); if (r.comment.parent) openThreads.add(r.comment.parent);
      post.comments++; setReply(null); renderComments(); syncCount();
      const el = $(`#comments [data-cid="${r.comment.id}"]`); el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el?.classList.add('fresh');
    } catch (err) { inp.value = body; HF.toast(err.message); }
  };

  /* ---------- хуки ---------- */
  const prevOnTab = S().onTab;
  S().onTab = name => { prevOnTab(name); if (name === 'profile') renderOwn(); if (name === 'feed') loadFeed(true); };
  window.HFPosts = { openUser, openPost, refresh() { renderOwn(); if (!$('#tab-feed').hidden) loadFeed(true); } };
})();
