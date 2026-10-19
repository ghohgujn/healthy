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
      if (p === '/api/health') return { days: [] };
      if (p === '/api/sync') return M === 'GET' ? { data: null } : { ok: true };
      throw new Error('Недоступно в демо');
    };
  })();
