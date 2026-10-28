/* matrix-notify 1.0.0: send messages to Matrix rooms from a web page or from Node.
 * https://github.com/thunderbird/matrix-notify · Mozilla Public License 2.0
 *
 * Two ways to log in, with the same send code:
 *  - People: login() opens the single sign-on page of the Matrix server. The access
 *    token is kept in this browser only (localStorage), and messages come from that person.
 *  - Bots (automated jobs, for example GitHub Actions): pass accessToken to create().
 *    Keep the token in a secret, never in a web page.
 *
 * Load it with a script tag (global MatrixNotify), with require(), or with import.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MatrixNotify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const DEFAULT_HOMESERVER = 'https://mozilla.modular.im'; // chat.mozilla.org

  class MatrixError extends Error {
    constructor(status, body) {
      super(body?.error || `Matrix request failed (HTTP ${status})`);
      this.name = 'MatrixError';
      this.status = status;
      this.errcode = body?.errcode || null;
    }
  }

  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // The message format that every tool shares: a title (a link when url is given) and
  // optional lines of plain text. Returns { text, html }.
  function format({ title, url, lines = [] }) {
    const extra = lines.filter(l => l != null && l !== '').map(String);
    const text = [url ? `${title} ${url}` : title, ...extra].join('\n');
    const head = url ? `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>` : escapeHtml(title);
    const html = [head, ...extra.map(escapeHtml)].join('<br>');
    return { text, html };
  }

  // Finds the client API address of a server name, for example "mozilla.org".
  async function discover(serverName) {
    const res = await fetch(`https://${serverName}/.well-known/matrix/client`);
    if (!res.ok) throw new Error(`No Matrix client configuration for ${serverName} (HTTP ${res.status})`);
    const base = (await res.json())?.['m.homeserver']?.base_url;
    if (!base) throw new Error(`No homeserver in the Matrix configuration of ${serverName}`);
    return base.replace(/\/+$/, '');
  }

  function memoryStorage() {
    const m = new Map();
    return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  }

  function create(options = {}) {
    const homeserver = (options.homeserver || DEFAULT_HOMESERVER).replace(/\/+$/, '');
    const key = options.storageKey || 'matrix-notify';
    const hasBrowser = typeof window !== 'undefined' && typeof location !== 'undefined';
    // A bot token is never written to storage.
    const storage = options.accessToken ? memoryStorage()
      : options.storage || (hasBrowser && window.localStorage) || memoryStorage();
    const read = (name, fallback) => { try { return JSON.parse(storage.getItem(`${key}:${name}`)) ?? fallback; } catch { return fallback; } };
    const write = (name, value) => value == null ? storage.removeItem(`${key}:${name}`) : storage.setItem(`${key}:${name}`, JSON.stringify(value));

    let session = options.accessToken ? { access_token: options.accessToken, user_id: options.userId || null } : read('session', null);
    if (session && session.homeserver && session.homeserver !== homeserver) session = null;
    const rooms = new Map(); // room alias or id -> room id, after a join in this page

    async function request(method, path, body, retried) {
      if (!session?.access_token && !path.startsWith('/login')) throw new MatrixError(401, { errcode: 'M_MISSING_TOKEN', error: 'Not logged in to Matrix' });
      const res = await fetch(homeserver + '/_matrix/client/v3' + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429 && !retried) {
        await sleep(Math.min(data.retry_after_ms || 1000, 10000));
        return request(method, path, body, true);
      }
      if (!res.ok) {
        const err = new MatrixError(res.status, data);
        // A token that the server no longer accepts is removed, so isLoggedIn() is honest.
        if (err.errcode === 'M_UNKNOWN_TOKEN' && !options.accessToken) { session = null; write('session', null); }
        throw err;
      }
      return data;
    }

    async function roomId(room) {
      if (rooms.has(room)) return rooms.get(room);
      // Joining a room that you are in already does nothing, so it is safe on every page load.
      const { room_id } = await request('POST', `/join/${encodeURIComponent(room)}`, {});
      rooms.set(room, room_id);
      return room_id;
    }

    // Sends a message to a room alias (#room:server) or room id (!id:server).
    // message is a string or { text, html }. Returns the event id.
    async function send(room, message) {
      const m = typeof message === 'string' ? { text: message } : message;
      const content = { msgtype: m.msgtype || 'm.text', body: m.text };
      if (m.html) Object.assign(content, { format: 'org.matrix.custom.html', formatted_body: m.html });
      const id = await roomId(room);
      const txn = `mn${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
      return (await request('PUT', `/rooms/${encodeURIComponent(id)}/send/m.room.message/${txn}`, content)).event_id;
    }

    // Opens the single sign-on page. Messages in "pending" are kept in this browser and
    // sent by completeLogin() when the person comes back.
    function login({ returnTo, pending } = {}) {
      if (!hasBrowser) throw new Error('login() needs a browser. Bots pass accessToken to create().');
      if (pending?.length) write('pending', [...read('pending', []), ...pending]);
      const back = new URL(returnTo || location.href);
      back.searchParams.delete('loginToken');
      location.assign(`${homeserver}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(back.href)}`);
    }

    // Call on every page load. If the address has a loginToken from the single sign-on
    // page, it gets an access token, removes loginToken from the address, and sends the
    // pending messages. Returns { completed, loggedIn, userId, sent, failed }. completed is
    // true when this call finished a login.
    async function completeLogin() {
      const result = { completed: false, loggedIn: !!session, userId: session?.user_id || null, sent: [], failed: [] };
      if (!hasBrowser) return result;
      const url = new URL(location.href);
      const token = url.searchParams.get('loginToken');
      if (!token) return result;
      url.searchParams.delete('loginToken');
      history.replaceState(history.state, '', url.href);
      const data = await request('POST', '/login', {
        type: 'm.login.token', token,
        initial_device_display_name: options.deviceName || `matrix-notify on ${location.host}`,
      });
      session = { access_token: data.access_token, user_id: data.user_id, device_id: data.device_id, homeserver };
      write('session', session);
      Object.assign(result, { completed: true, loggedIn: true, userId: data.user_id });
      const pending = read('pending', []);
      write('pending', null);
      for (const p of pending) {
        try { result.sent.push({ ...p, eventId: await send(p.room, p.message) }); }
        catch (e) { result.failed.push({ ...p, error: e.message }); }
      }
      return result;
    }

    // Ends the session on the server too, so the token cannot be used again.
    async function logout() {
      if (options.accessToken) throw new Error('A bot token cannot log out here.');
      try { if (session) await request('POST', '/logout', {}); } catch { /* the local logout still happens */ }
      session = null;
      write('session', null);
      write('pending', null);
      rooms.clear();
    }

    return {
      homeserver,
      isLoggedIn: () => !!session?.access_token,
      userId: () => session?.user_id || null,
      pending: () => read('pending', []),
      send, login, completeLogin, logout,
    };
  }

  return { VERSION, DEFAULT_HOMESERVER, MatrixError, create, format, discover, escapeHtml };
});
