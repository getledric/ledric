// Tiny fetch wrapper for the ledric HTTP API. Mirrors @ledric/sdk's surface
// but uses the page origin (since the GUI is mounted on the same server).

const ROOT = window.location.origin;

// localStorage key the admin paste-prompt writes to. Same origin as
// the API, so the inline-editor iframe and the /admin SPA share it.
const KEY_STORAGE = 'ledric:admin-key';

export const auth = {
  get key() {
    try { return localStorage.getItem(KEY_STORAGE); } catch { return null; }
  },
  set(secret) {
    try { localStorage.setItem(KEY_STORAGE, secret); } catch { /* ignore */ }
  },
  clear() {
    try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
  },
  /**
   * Hit the public /auth/status probe so callers can decide whether to
   * show a key prompt without burning a 401.
   */
  async status() {
    try {
      const res = await fetch(`${ROOT}/auth/status`);
      if (!res.ok) return { required: false, reads_open: true };
      return await res.json();
    } catch {
      return { required: false, reads_open: true };
    }
  }
};

// Listeners that get fired when the server returns 401 — used by the
// React app to drop the stored key and re-show the prompt.
const onUnauthorizedListeners = new Set();
export function onUnauthorized(fn) {
  onUnauthorizedListeners.add(fn);
  return () => onUnauthorizedListeners.delete(fn);
}
function fireUnauthorized() {
  for (const fn of onUnauthorizedListeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

function authHeaders() {
  const k = auth.key;
  return k ? { Authorization: `Bearer ${k}` } : {};
}

async function authedFetch(url, init = {}) {
  const headers = { ...(init.headers ?? {}), ...authHeaders() };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    auth.clear();
    fireUnauthorized();
  }
  return res;
}

async function jsonOrThrow(res) {
  if (res.status === 404) return null;
  const ct = res.headers.get('content-type') ?? '';
  let body = null;
  if (ct.includes('application/json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }
  if (!res.ok) {
    const err = new Error(
      body && body.error && body.error.message
        ? body.error.message
        : `HTTP ${res.status}`
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false) continue;
    if (v === true) {
      p.set(k, '1');
    } else if (Array.isArray(v)) {
      p.set(k, v.join(','));
    } else {
      p.set(k, String(v));
    }
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  baseUrl: ROOT,

  types: () => authedFetch(`${ROOT}/types`).then(jsonOrThrow),

  type: (name) =>
    authedFetch(`${ROOT}/types/${encodeURIComponent(name)}`).then(jsonOrThrow),

  find: (type, opts = {}) =>
    authedFetch(`${ROOT}/entries/${encodeURIComponent(type)}${qs(opts)}`).then(jsonOrThrow),

  read: (type, slug, opts = {}) =>
    authedFetch(
      `${ROOT}/entries/${encodeURIComponent(type)}/${encodeURIComponent(slug)}${qs({
        expand_assets: opts.expandAssets,
        version: opts.version,
        locale: opts.locale,
        resolve_refs: opts.resolveRefs
      })}`
    ).then(jsonOrThrow),

  assets: (opts = {}) =>
    authedFetch(`${ROOT}/assets${qs(opts)}`).then(jsonOrThrow),

  asset: (id) =>
    authedFetch(`${ROOT}/assets/${encodeURIComponent(id)}/meta`).then(jsonOrThrow),

  // Asset bytes are typically loaded by <img src="..."> which the
  // browser fetches without our injected auth header. That's fine when
  // reads_open (default) but breaks under --require-reader-key. The
  // assetUrl helper stays headerless for backward compatibility; if a
  // strict-mode operator hits it, they'll need a SDK-level fetch.
  assetUrl: (id) => `${ROOT}/assets/${encodeURIComponent(id)}`,

  uploadAsset: async (file, { alt, kind } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (alt !== undefined) fd.append('alt', alt);
    if (kind !== undefined) fd.append('kind', kind);
    const res = await authedFetch(`${ROOT}/assets`, { method: 'POST', body: fd });
    return jsonOrThrow(res);
  },

  rpc: async (tool, args = {}) => {
    const res = await authedFetch(`${ROOT}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args })
    });
    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message ?? 'rpc failed');
      err.status = res.status;
      err.error = json.error;
      throw err;
    }
    return json.result;
  }
};
