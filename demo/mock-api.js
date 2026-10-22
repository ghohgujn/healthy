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
        { id: 3, from: 3, to: 1, kind: 'text', body: 'Завтра на площадку в 8?', created: t - 9e5 },
        { id: 4, from: 2, to: 1, kind: 'voice', body: '', media: '', meta: { dur: 14 }, created: t - 29e5 },
        { id: 5, from: 2, to: 1, kind: 'video', body: '', media: '', meta: { dur: 9 }, created: t - 28e5 },
        { id: 6, from: 1, to: 2, kind: 'text', body: 'Выглядит супер! Сколько белка вышло?', created: t - 27e5 },
        { id: 7, from: 1, to: 2, kind: 'text', body: '🔥', created: t - 26.9e5 } ], media: {} };
    const pubU = u => ({ ...u, state: st.fr[u.id] || 'none' });
    return async (path, o) => {
      await new Promise(r => setTimeout(r, 120));
      const u = new URL(path, 'http://demo.local'), p = u.pathname, M = o.method || 'GET', body = typeof o.body === 'string' ? JSON.parse(o.body || '{}') : o.body;
      if (p === '/api/auth/check') { const n = (u.searchParams.get('username') || '').trim(); const ok = /^[a-z0-9_.]{3,20}$/i.test(n);
        return { available: ok && !users.some(x => x.username === n.toLowerCase()), reason: ok ? '' : 'Только латиница, цифры, точка и _, 3–20 символов' }; }
      if (p === '/api/auth/register' || p === '/api/auth/login') {
        if (!body.username || String(body.password || '').length < 6) throw new Error(p.endsWith('login') ? 'Неверный логин или пароль' : 'Пароль — минимум 6 символов');
        st.me = { id: 1, username: body.username, name: body.name || body.username, avatar: '', bio: '', stats: {}, healthToken: 'demo-token', admin: body.username === 'papa' }; return { me: st.me }; }
      if (p === '/api/auth/logout') { st.me = null; return { ok: true }; }
      if (p === '/api/reports' && M === 'POST') {
        st.reports ||= []; if (!(body.reasons || []).length && !body.comment) throw new Error('Отметьте, что не так, или напишите пару слов');
        st.reports.unshift({ id: st.reports.length + 1, created: Date.now(), status: 'new', username: st.me?.username || null, ...body, media: body.image || '' }); return { ok: true };
      }
      if (!st.me) throw Object.assign(new Error('Войдите в аккаунт'), { status: 401 });
      if (p === '/api/admin/stats') return { runs: 0 };
      if (p === '/api/admin/reports') { const sx = u.searchParams.get('status'); const all = st.reports || [];
        return { counts: { new: all.filter(r => r.status === 'new').length }, reports: all.filter(r => sx === 'all' || r.status === sx) }; }
      const arm = /^\/api\/admin\/reports\/(\d+)$/.exec(p); if (arm) { const r = (st.reports || []).find(x => x.id === +arm[1]); if (r) r.status = body.status; return { ok: true }; }
      if (p === '/api/me') { if (M === 'PATCH') Object.assign(st.me, { name: body.name || st.me.name, username: body.username || st.me.username }); return { me: st.me }; }
      if (p === '/api/users') { const q = (u.searchParams.get('q') || '').toLowerCase(); return { users: users.filter(x => (x.username + x.name).toLowerCase().includes(q)).map(pubU) }; }
      const SUM = { 2: { kcal: 1480, goal: 2100, p: 92, f: 51, c: 160, pGoal: 130, fGoal: 70, cGoal: 240, water: 1500, waterGoal: 2250, meals: 3, workouts: 1, updated: Date.now() - 12 * 60000 },
        3: { kcal: 2460, goal: 2300, p: 140, f: 88, c: 260, pGoal: 150, fGoal: 75, cGoal: 250, water: 2750, waterGoal: 2500, meals: 4, workouts: 0, updated: Date.now() - 95 * 60000 } };
      if (p === '/api/friends') return { friends: users.filter(x => st.fr[x.id] === 'friends').map(x => ({ ...x, today: SUM[x.id] ? { kcal: SUM[x.id].kcal, goal: SUM[x.id].goal, meals: SUM[x.id].meals } : null })), incoming: users.filter(x => st.fr[x.id] === 'incoming'), sent: users.filter(x => st.fr[x.id] === 'sent') };
      const rs = /^\/api\/friends\/(\d+)\/restore$/.exec(p);
      if (rs) { const f = users.find(x => x.id === +rs[1]); if (!f.flame.canRestore) throw new Error('Огонёк уже восстанавливали — второй раз нельзя'); f.flame = { count: f.flame.count + 1, state: 'risk', canRestore: false }; return { flame: f.flame }; }
      const fm = /^\/api\/friends\/(\d+)$/.exec(p);
      if (fm) { const id = +fm[1]; st.fr[id] = M === 'DELETE' ? 'none' : st.fr[id] === 'incoming' ? 'friends' : st.fr[id] === 'friends' ? 'friends' : 'friends'; return { state: st.fr[id] }; }
      if (p === '/api/media') { const id = 'demo' + (++st.id); st.media[id] = o.body instanceof Blob ? URL.createObjectURL(o.body) : body.data; return { id, url: st.media[id] }; }
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
          return { messages: ms, peer: users.find(x => x.id === pid), peerRead: pid === 2 ? 6 : 0, friends: st.fr[pid] === 'friends' }; }
        let media = body.media ? st.media[body.media] : '', meta = body.meta || null;
        if (body.kind === 'post') { const x = st.posts.find(q => q.id === +body.post), au = x.user_id === 1 ? st.me : users.find(y => y.id === x.user_id); media = x.media; meta = { ...x.meta, postId: x.id, author: { name: au.name, username: au.username } }; }
        const ro = body.reply && st.msgs.find(x => x.id === +body.reply);
        const reply = ro ? { id: ro.id, from: ro.from, kind: ro.kind, text: ro.kind === 'text' ? ro.body : ro.kind === 'meal' || ro.kind === 'post' ? `🍽 ${ro.meta?.title || ''}` : ro.kind === 'voice' ? '🎤 Голосовое сообщение' : '📹 Видеосообщение' } : null;
        const m = { id: ++st.id, from: 1, to: pid, kind: body.kind, body: body.body || '', media, meta, created: Date.now(), reply };
        st.msgs.push(m); return { message: m };
      }
      if (/^\/api\/messages\//.test(p)) { const id = +p.split('/').pop(); st.msgs = st.msgs.filter(m => m.id !== id); return { ok: true }; }

      // ---- публикации (демо) ----
      if (!st.posts) {
        const img = (a, b, e) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><radialGradient id="g" cx=".5" cy=".45" r=".6"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient></defs><rect width="400" height="400" fill="#efe6d8"/><circle cx="200" cy="205" r="150" fill="#fff"/><circle cx="200" cy="205" r="122" fill="url(#g)"/><text x="200" y="232" font-size="96" text-anchor="middle">${e}</text></svg>`);
        const P = (id, uid, ago, e, a, b, title, kcal, pp, f, c, cap, likes, liked, v = 'public') => ({ id, user_id: uid, media: img(a, b, e), caption: cap, meta: { title, kcal, p: pp, f, c }, created: t - ago, likers: new Set(liked ? [1] : []), likesBase: likes, vis: v });
        users.push({ id: 5, username: 'lena.fit', name: 'Лена (демо)', avatar: '', bio: 'Готовлю ПП без скуки', stats: { streak: 31 }, flame: null },
                   { id: 6, username: 'dima.run', name: 'Дима (демо)', avatar: '', bio: '', stats: { streak: 8 }, flame: null });
        st.posts = [P(1, 2, 2e6, '🥗', '#9bd37a', '#4f9a3a', 'Боул с киноа и лососем', 520, 34, 18, 52, 'После тренировки 💪', 6, true),
          P(5, 5, 9e5, '🥞', '#f3c98b', '#c98a3e', 'Сырники из духовки', 340, 24, 9, 38, 'Без масла, 15 минут', 41, false),
          P(2, 3, 9e6, '🍳', '#ffd36b', '#e69a2e', 'Омлет с овощами', 380, 26, 24, 12, 'Завтрак чемпиона', 3, false),
          P(6, 6, 2e7, '🍜', '#f2a65a', '#b6582b', 'Удон с курицей', 610, 38, 14, 80, 'Перед длинной пробежкой', 17, false),
          P(3, 2, 6e7, '🍝', '#f6a36b', '#c9572f', 'Паста болоньезе', 690, 32, 22, 88, '', 9, false, 'friends'),
          P(4, 3, 9e7, '🥣', '#e8d3b0', '#b8945e', 'Овсянка с ягодами', 310, 11, 7, 52, 'Каждое утро', 2, false)];
        const C = (id, post_id, user_id, body, ago, parent = null, reply_to = null, likes = 0) => ({ id, post_id, user_id, body, created: t - ago, parent, reply_to, likers: new Set(), likesBase: likes });
        st.comments = [C(1, 1, 3, 'Выглядит огонь 🔥', 15e5, null, null, 4), C(2, 1, 2, 'Спасибо! Рецепт скину в чат', 12e5, 1, 3, 1), C(7, 1, 5, 'А соус какой?', 10e5, 1, 2),
          C(8, 1, 6, 'Сколько белка на порцию?', 9e5, null, null, 2), C(3, 2, 2, 'Сколько яиц?', 8e6), C(9, 5, 2, 'Беру рецепт!', 6e5, null, null, 3)];
        st.id = 100;
      }
      const who = id => id === 1 ? st.me : users.find(x => x.id === id);
      const shapeP = x => ({ id: x.id, author: who(x.user_id), media: x.media, gallery: x.gallery || [], caption: x.caption, meta: x.meta, created: x.created, vis: x.vis,
        likes: x.likesBase + x.likers.size, liked: x.likers.has(1), comments: st.comments.filter(c => c.post_id === x.id).length, mine: x.user_id === 1 });
      const friendOk = uid => uid === 1 || st.fr[uid] === 'friends';
      const vis = x => x.vis === 'public' || friendOk(x.user_id);
      const shapeC = c => { const to = c.reply_to ? who(c.reply_to) : null;
        return { id: c.id, body: c.body, created: c.created, parent: c.parent, replyTo: to && { id: to.id, name: to.name, username: to.username }, author: who(c.user_id), likes: c.likesBase + c.likers.size, liked: c.likers.has(1) }; };
      const um = /^\/api\/users\/(\d+)$/.exec(p);
      if (um) { const id = +um[1], x = who(id), visible = friendOk(id);
        const posts = st.posts.filter(q => q.user_id === id && (visible || q.vis === 'public')).sort((a, b) => b.created - a.created).map(shapeP);
        return { user: { ...x, summary: st.fr[id] === 'friends' ? (SUM[id] || null) : null, state: id === 1 ? 'self' : st.fr[id] || 'none', postsCount: st.posts.filter(q => q.user_id === id).length, friendsCount: id === 1 ? users.filter(y => st.fr[y.id] === 'friends').length : 3 + id }, posts, visible }; }
      if (p === '/api/feed') { const all = u.searchParams.get('scope') === 'all';
        return { posts: st.posts.filter(x => all ? vis(x) : friendOk(x.user_id)).sort((a, b) => b.created - a.created).map(shapeP) }; }
      if (p === '/api/posts' && M === 'POST') { const x = { id: ++st.id, user_id: 1, media: st.media[body.media], gallery: body.gallery?.length ? [st.media[body.media], ...body.gallery.map(g => st.media[g])] : [], caption: body.caption || '', meta: body.meta || {}, created: Date.now(), likers: new Set(), likesBase: 0, vis: body.vis === 'friends' ? 'friends' : 'public' }; st.posts.push(x); return { post: shapeP(x) }; }
      const pm = /^\/api\/posts\/(\d+)(\/like|\/comments)?$/.exec(p);
      if (pm) { const x = st.posts.find(q => q.id === +pm[1]); if (!x || !vis(x)) throw new Error('Публикация не найдена');
        if (!pm[2] && M === 'GET') return { post: shapeP(x), comments: st.comments.filter(c => c.post_id === x.id).sort((a, b) => a.created - b.created).map(shapeC) };
        if (!pm[2] && M === 'DELETE') { st.posts = st.posts.filter(q => q !== x); return { ok: true }; }
        if (pm[2] === '/like') { M === 'POST' ? x.likers.add(1) : x.likers.delete(1); const s2 = shapeP(x); return { likes: s2.likes, liked: s2.liked }; }
        if (pm[2] === '/comments') { let parent = null, reply_to = null;
          if (body.parent) { const pc = st.comments.find(c => c.id === +body.parent); parent = pc.parent || pc.id; reply_to = pc.user_id; }
          const c = { id: ++st.id, post_id: x.id, user_id: 1, body: body.body, created: Date.now(), parent, reply_to, likers: new Set(), likesBase: 0 }; st.comments.push(c); return { comment: shapeC(c) }; } }
      const clm = /^\/api\/comments\/(\d+)\/like$/.exec(p);
      if (clm) { const c = st.comments.find(x => x.id === +clm[1]); M === 'POST' ? c.likers.add(1) : c.likers.delete(1); const s2 = shapeC(c); return { likes: s2.likes, liked: s2.liked }; }
      const dcm = /^\/api\/comments\/(\d+)$/.exec(p);
      if (dcm) { const id = +dcm[1], removed = [id, ...st.comments.filter(c => c.parent === id).map(c => c.id)]; st.comments = st.comments.filter(c => !removed.includes(c.id)); return { ok: true, removed }; }
      if (p === '/api/health') return { days: [] };
      if (p === '/api/sync') return M === 'GET' ? { data: null } : { ok: true };
      throw new Error('Недоступно в демо');
    };
  })();
