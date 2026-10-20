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
  const macros = x => `<span class="pm"><b>${r0(x?.kcal)}</b> ккал</span><span class="pm" style="--c:var(--color-protein)">Б ${r0(x?.p)}</span><span class="pm" style="--c:var(--color-fat)">Ж ${r0(x?.f)}</span><span class="pm" style="--c:var(--color-carb)">У ${r0(x?.c)}</span>`;

  /* ---------- сетка публикаций ---------- */
  function grid(posts, empty) {
    if (!posts.length) return `<div class="grid-empty"><svg><use href="#i-grid"/></svg><p>${empty}</p></div>`;
    return `<div class="post-grid">${posts.map(p => `<button class="pg-item" data-post="${p.id}" aria-label="${esc(p.meta?.title || 'Публикация')}, ${r0(p.meta?.kcal)} ккал">
      <img src="${esc(p.media)}" alt="" loading="lazy"><span class="pg-kcal">${r0(p.meta?.kcal)}</span>
      ${p.likes ? `<span class="pg-likes"><svg><use href="#i-heart"/></svg>${p.likes}</span>` : ''}</button>`).join('')}</div>`;
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
        <div class="uv-grid">${r.visible ? grid(r.posts, 'Пока нет публикаций') : '<div class="grid-empty"><svg><use href="#i-grid"/></svg><p>Публикации видны только друзьям</p></div>'}</div>`;
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
  $('#uvBack').onclick = () => HF.closeDialog(uv);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !uv.hidden && $('#postSheet').hidden) { e.stopPropagation(); HF.closeDialog(uv); } }, true);

  /* ---------- лента ---------- */
  let view = 'chats', feedPosts = [], feedEnd = false, feedLoading = false;
  $('#chatsSeg').querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
    view = b.dataset.view; $('#chatsSeg').querySelectorAll('[data-view]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    $('#feedView').hidden = view !== 'feed'; $('#socialMain').hidden = view !== 'chats';
    if (view === 'feed') loadFeed(true);
  });
  $('#userSearch').addEventListener('input', e => {
    const has = !!e.target.value.trim();
    $('#chatsSeg').hidden = has; $('#feedView').hidden = has || view !== 'feed'; if (!has) $('#socialMain').hidden = view !== 'chats';
  });
  async function loadFeed(reset) {
    if (feedLoading || (!reset && feedEnd)) return;
    feedLoading = true;
    try {
      const before = reset || !feedPosts.length ? '' : `?before=${feedPosts[feedPosts.length - 1].id}`;
      const r = await api('/api/feed' + before);
      feedPosts = reset ? r.posts : feedPosts.concat(r.posts); feedEnd = r.posts.length < 20;
      renderFeed();
    } catch (e) { $('#feedView').innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
    feedLoading = false;
  }
  function card(p) {
    return `<article class="fcard" data-id="${p.id}">
      <header class="fc-head"><button class="fc-author" data-user="${p.author.id}">${avaHTML(p.author)}<span><b>${esc(p.author.name)}</b><small>${ago(p.created)}</small></span></button>
        ${p.mine ? `<button class="icon-btn fc-del" data-del="${p.id}" aria-label="Удалить публикацию"><svg><use href="#i-trash"/></svg></button>` : ''}</header>
      <div class="fc-photo" data-dbl="${p.id}"><img src="${esc(p.media)}" alt="${esc(p.meta?.title || 'Еда')}" loading="lazy"><i class="fc-burst"><svg><use href="#i-heart"/></svg></i></div>
      <div class="fc-actions">
        <button class="fc-btn like ${p.liked ? 'on' : ''}" data-like="${p.id}" aria-pressed="${p.liked}" aria-label="Нравится"><svg><use href="#${p.liked ? 'i-heart' : 'i-heart-o'}"/></svg><span>${p.likes || ''}</span></button>
        <button class="fc-btn" data-open="${p.id}" aria-label="Комментарии"><svg><use href="#i-comment"/></svg><span>${p.comments || ''}</span></button>
      </div>
      <div class="fc-text"><p class="fc-title">${esc(p.meta?.title || '')}</p><p class="fc-macros">${macros(p.meta)}</p>
        ${p.caption ? `<p class="fc-cap"><b>${esc(p.author.name)}</b> ${esc(p.caption)}</p>` : ''}
        ${p.comments ? `<button class="link-btn fc-more" data-open="${p.id}">Комментарии: ${p.comments}</button>` : ''}</div>
    </article>`;
  }
  function renderFeed() {
    const box = $('#feedView');
    box.innerHTML = feedPosts.length ? feedPosts.map(card).join('') + (feedEnd ? '' : '<button class="btn btn-ghost feed-more" id="feedMore">Показать ещё</button>')
      : `<div class="grid-empty"><svg><use href="#i-grid"/></svg><p>В ленте пока пусто. Здесь появятся публикации друзей — и ваши.</p></div>`;
    bindCards(box, feedPosts);
    $('#feedMore')?.addEventListener('click', () => loadFeed(false));
  }
  function bindCards(root, list) {
    root.querySelectorAll('[data-user]').forEach(b => b.onclick = () => openUser(+b.dataset.user));
    root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openPost(+b.dataset.open, true));
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

  /* ---------- публикация (детально) ---------- */
  let post = null;
  async function openPost(id, focusComment) {
    $('#postBody').innerHTML = '<div class="uv-loading"><div class="scan"></div></div>';
    if ($('#postSheet').hidden) HF.openDialog($('#postSheet'), focusComment ? '#commentInput' : '[data-close]:not(.scrim)');
    try {
      const r = await api(`/api/posts/${id}`); post = r.post;
      $('#postBody').innerHTML = `<button class="icon-btn icon-btn-float post-close" data-close aria-label="Закрыть"><svg><use href="#i-x"/></svg></button>
        ${card(post).replace('<article class="fcard"', '<article class="fcard in-sheet"')}
        <ul class="comments" id="comments">${r.comments.map(commentHTML).join('') || '<li class="sub no-comments">Комментариев пока нет — будьте первым.</li>'}</ul>`;
      bindCards($('#postBody'), [post]);
      bindComments();
      if (focusComment) $('#commentInput').focus();
    } catch (e) { $('#postBody').innerHTML = `<button class="icon-btn icon-btn-float post-close" data-close aria-label="Закрыть"><svg><use href="#i-x"/></svg></button><p class="sub uv-err">${esc(e.message)}</p>`; }
  }
  const commentHTML = c => `<li class="cmt" data-cid="${c.id}"><button class="cmt-ava" data-user="${c.author.id}" aria-label="${esc(c.author.name)}">${avaHTML(c.author)}</button>
    <div><p><b>${esc(c.author.name)}</b> ${esc(c.body)}</p><small>${ago(c.created)}${c.author.id === S().me?.id || post?.mine ? ` · <button class="link-btn cmt-del" data-cdel="${c.id}">удалить</button>` : ''}</small></div></li>`;
  function bindComments() {
    $('#comments').querySelectorAll('[data-user]').forEach(b => b.onclick = () => { HF.closeDialog($('#postSheet')); openUser(+b.dataset.user); });
    $('#comments').querySelectorAll('[data-cdel]').forEach(b => b.onclick = async () => {
      try { await api(`/api/comments/${b.dataset.cdel}`, { method: 'DELETE' }); b.closest('.cmt').remove(); post.comments--; syncCount(); } catch (e) { HF.toast(e.message); }
    });
  }
  function syncCount() {
    const f = feedPosts.find(p => p.id === post.id); if (f) { f.comments = post.comments; if (!$('#feedView').hidden) renderFeed(); }
    $('#postBody').querySelectorAll(`[data-open="${post.id}"] span`).forEach(s => s.textContent = post.comments || '');
  }
  $('#commentForm').onsubmit = async e => {
    e.preventDefault(); if (!post) return;
    const inp = $('#commentInput'), body = inp.value.trim(); if (!body) return;
    inp.value = '';
    try {
      const r = await api(`/api/posts/${post.id}/comments`, { method: 'POST', body: { body } });
      $('#comments .no-comments')?.remove();
      $('#comments').insertAdjacentHTML('beforeend', commentHTML(r.comment)); bindComments();
      post.comments++; syncCount();
      $('#postBody').scrollTop = $('#postBody').scrollHeight;
    } catch (err) { inp.value = body; HF.toast(err.message); }
  };

  /* ---------- хуки ---------- */
  const prevOnTab = S().onTab;
  S().onTab = name => { prevOnTab(name); if (name === 'profile') renderOwn(); if (name === 'chats' && view === 'feed') loadFeed(true); };
  window.HFPosts = { openUser, openPost, refresh() { renderOwn(); if (view === 'feed') loadFeed(true); } };
})();
