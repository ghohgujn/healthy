// Только для превью без сервера: локальная заглушка API с подписанными демо-друзьями.
// В production (public/) не подключается.
// Демо-режим (превью без сервера): локальная заглушка API с подписанными демо-друзьями
window.HFMockApi = (() => {
    const t = Date.now(), users = [
      { id: 2, username: 'masha.demo', name: 'Маша (демо)', avatar: '', bio: '', stats: { streak: 12 }, flame: { count: 12, state: 'active' } },
      { id: 3, username: 'artem.demo', name: 'Артём (демо)', avatar: '', bio: '', stats: { streak: 4 }, flame: { count: 4, state: 'out', canRestore: true } },
      { id: 4, username: 'katya.demo', name: 'Катя (демо)', avatar: '', bio: '', stats: {}, flame: { count: 0, state: 'none' } } ];
    const st = { me: null, fr: { 2: 'friends', 3: 'friends', 4: 'incoming' }, id: 10,
      msgs: [ { id: 1, from: 2, to: 1, kind: 'text', body: 'Привет! Как питание сегодня?', created: t - 36e5 },
        { id: 2, from: 2, to: 1, kind: 'meal', body: 'мой обед', media: '', meta: { title: 'Плов с салатом', kcal: 640, p: 28, f: 24, c: 76 }, created: t - 30e5 },
        { id: 3, from: 3, to: 1, kind: 'text', body: 'Завтра на площадку в 8?', created: t - 9e5 } ], media: {} };
    const pubU = u => ({ ...u, state: st.fr[u.id] || 'none' });
    return async (path, o) => {
      await new Promise(r => setTimeout(r, 120));
      const u = new URL(path, 'http://demo.local'), p = u.pathname, M = o.method || 'GET', body = typeof o.body === 'string' ? JSON.parse(o.body || '{}') : o.body;
      if (p === '/api/auth/check') { const n = (u.searchParams.get('username') || '').trim(); const ok = /^[a-z0-9_.]{3,20}$/i.test(n);
        return { available: ok && !users.some(x => x.username === n.toLowerCase()), reason: ok ? '' : 'Только латиница, цифры, точка и _, 3–20 символов' }; }
      if (p === '/api/auth/register' || p === '/api/auth/login') {
        if (!body.username || String(body.password || '').length < 6) throw new Error(p.endsWith('login') ? 'Неверный логин или пароль' : 'Пароль — минимум 6 символов');
        st.me = { id: 1, username: body.username, name: body.name || body.username, avatar: '', bio: '', stats: {}, healthToken: 'demo-token' }; return { me: st.me }; }
      if (p === '/api/auth/logout') { st.me = null; return { ok: true }; }
      if (!st.me) throw Object.assign(new Error('Войдите в аккаунт'), { status: 401 });
      if (p === '/api/me') { if (M === 'PATCH') Object.assign(st.me, { name: body.name || st.me.name, username: body.username || st.me.username }); return { me: st.me }; }
      if (p === '/api/users') { const q = (u.searchParams.get('q') || '').toLowerCase(); return { users: users.filter(x => (x.username + x.name).toLowerCase().includes(q)).map(pubU) }; }
      if (p === '/api/friends') return { friends: users.filter(x => st.fr[x.id] === 'friends'), incoming: users.filter(x => st.fr[x.id] === 'incoming'), sent: users.filter(x => st.fr[x.id] === 'sent') };
      const rs = /^\/api\/friends\/(\d+)\/restore$/.exec(p);
      if (rs) { const f = users.find(x => x.id === +rs[1]); if (!f.flame.canRestore) throw new Error('Огонёк уже восстанавливали — второй раз нельзя'); f.flame = { count: f.flame.count + 1, state: 'risk', canRestore: false }; return { flame: f.flame }; }
      const fm = /^\/api\/friends\/(\d+)$/.exec(p);
      if (fm) { const id = +fm[1]; st.fr[id] = M === 'DELETE' ? 'none' : st.fr[id] === 'incoming' ? 'friends' : st.fr[id] === 'friends' ? 'friends' : 'friends'; return { state: st.fr[id] }; }
      if (p === '/api/media') { const id = 'demo' + (++st.id); st.media[id] = URL.createObjectURL(o.body); return { id, url: st.media[id] }; }
      if (p === '/api/chats') {
        const peers = [...new Set(st.msgs.map(m => m.from === 1 ? m.to : m.from))];
        const chats = peers.map(pid => { const ms = st.msgs.filter(m => m.from === pid || m.to === pid); return { peer: users.find(x => x.id === pid), last: ms[ms.length - 1], unread: ms.filter(m => m.from === pid && !m.read).length }; })
          .sort((a, b) => b.last.created - a.last.created);
        return { chats, unreadTotal: chats.reduce((a, c) => a + c.unread, 0) };
      }
      const cm = /^\/api\/chats\/(\d+)$/.exec(p);
      if (cm) {
        const pid = +cm[1];
        if (M === 'GET') { const after = +u.searchParams.get('after') || 0; const ms = st.msgs.filter(m => (m.from === pid || m.to === pid) && m.id > after); ms.forEach(m => { if (m.from === pid) m.read = true; });
          return { messages: ms, peer: users.find(x => x.id === pid), peerRead: 0, friends: st.fr[pid] === 'friends' }; }
        const m = { id: ++st.id, from: 1, to: pid, kind: body.kind, body: body.body || '', media: body.media ? st.media[body.media] : '', meta: body.meta || null, created: Date.now() };
        st.msgs.push(m); return { message: m };
      }
      if (/^\/api\/messages\//.test(p)) { const id = +p.split('/').pop(); st.msgs = st.msgs.filter(m => m.id !== id); return { ok: true }; }

      // ---- публикации (демо) ----
      if (!st.posts) {
        const img = (a, b, e) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><radialGradient id="g" cx=".5" cy=".45" r=".6"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient></defs><rect width="400" height="400" fill="#efe6d8"/><circle cx="200" cy="205" r="150" fill="#fff"/><circle cx="200" cy="205" r="122" fill="url(#g)"/><text x="200" y="232" font-size="96" text-anchor="middle">${e}</text></svg>`);
        const P = (id, uid, ago, e, a, b, title, kcal, pp, f, c, cap, likes, liked) => ({ id, user_id: uid, media: img(a, b, e), caption: cap, meta: { title, kcal, p: pp, f, c }, created: t - ago, likers: new Set(liked ? [1] : []), likesBase: likes });
        st.posts = [P(1, 2, 2e6, '🥗', '#9bd37a', '#4f9a3a', 'Боул с киноа и лососем', 520, 34, 18, 52, 'После тренировки 💪', 6, true),
          P(2, 3, 9e6, '🍳', '#ffd36b', '#e69a2e', 'Омлет с овощами', 380, 26, 24, 12, 'Завтрак чемпиона', 3, false),
          P(3, 2, 6e7, '🍝', '#f6a36b', '#c9572f', 'Паста болоньезе', 690, 32, 22, 88, '', 9, false),
          P(4, 3, 9e7, '🥣', '#e8d3b0', '#b8945e', 'Овсянка с ягодами', 310, 11, 7, 52, 'Каждое утро', 2, false)];
        st.comments = [{ id: 1, post_id: 1, user_id: 3, body: 'Выглядит огонь 🔥', created: t - 15e5 }, { id: 2, post_id: 1, user_id: 2, body: 'Спасибо! Рецепт скину в чат', created: t - 12e5 }, { id: 3, post_id: 2, user_id: 2, body: 'Сколько яиц?', created: t - 8e6 }];
      }
      const who = id => id === 1 ? st.me : users.find(x => x.id === id);
      const shapeP = x => ({ id: x.id, author: who(x.user_id), media: x.media, caption: x.caption, meta: x.meta, created: x.created,
        likes: x.likesBase + x.likers.size, liked: x.likers.has(1), comments: st.comments.filter(c => c.post_id === x.id).length, mine: x.user_id === 1 });
      const vis = x => x.user_id === 1 || st.fr[x.user_id] === 'friends';
      const shapeC = c => ({ id: c.id, body: c.body, created: c.created, author: who(c.user_id) });
      const um = /^\/api\/users\/(\d+)$/.exec(p);
      if (um) { const id = +um[1], x = who(id), visible = id === 1 || st.fr[id] === 'friends';
        const posts = visible ? st.posts.filter(q => q.user_id === id).sort((a, b) => b.created - a.created).map(shapeP) : [];
        return { user: { ...x, state: id === 1 ? 'self' : st.fr[id] || 'none', postsCount: st.posts.filter(q => q.user_id === id).length, friendsCount: id === 1 ? users.filter(y => st.fr[y.id] === 'friends').length : 3 + id }, posts, visible }; }
      if (p === '/api/feed') return { posts: st.posts.filter(vis).sort((a, b) => b.created - a.created).map(shapeP) };
      if (p === '/api/posts' && M === 'POST') { const x = { id: ++st.id, user_id: 1, media: st.media[body.media], caption: body.caption || '', meta: body.meta || {}, created: Date.now(), likers: new Set(), likesBase: 0 }; st.posts.push(x); return { post: shapeP(x) }; }
      const pm = /^\/api\/posts\/(\d+)(\/like|\/comments)?$/.exec(p);
      if (pm) { const x = st.posts.find(q => q.id === +pm[1]); if (!x || !vis(x)) throw new Error('Публикация не найдена');
        if (!pm[2] && M === 'GET') return { post: shapeP(x), comments: st.comments.filter(c => c.post_id === x.id).map(shapeC) };
        if (!pm[2] && M === 'DELETE') { st.posts = st.posts.filter(q => q !== x); return { ok: true }; }
        if (pm[2] === '/like') { M === 'POST' ? x.likers.add(1) : x.likers.delete(1); const s2 = shapeP(x); return { likes: s2.likes, liked: s2.liked }; }
        if (pm[2] === '/comments') { const c = { id: ++st.id, post_id: x.id, user_id: 1, body: body.body, created: Date.now() }; st.comments.push(c); return { comment: shapeC(c) }; } }
      const dcm = /^\/api\/comments\/(\d+)$/.exec(p);
      if (dcm) { st.comments = st.comments.filter(c => c.id !== +dcm[1]); return { ok: true }; }
      if (p === '/api/health') return { days: [] };
      if (p === '/api/sync') return M === 'GET' ? { data: null } : { ok: true };
      throw new Error('Недоступно в демо');
    };
  })();
