// Tiny fetch wrapper for the ledric HTTP API. Mirrors @ledric/sdk's surface
// but uses the page origin (since the GUI is mounted on the same server).

const ROOT = window.location.origin;

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

  types: () => fetch(`${ROOT}/types`).then(jsonOrThrow),

  type: (name) => fetch(`${ROOT}/types/${encodeURIComponent(name)}`).then(jsonOrThrow),

  find: (type, opts = {}) =>
    fetch(`${ROOT}/entries/${encodeURIComponent(type)}${qs(opts)}`).then(jsonOrThrow),

  read: (type, slug, opts = {}) =>
    fetch(
      `${ROOT}/entries/${encodeURIComponent(type)}/${encodeURIComponent(slug)}${qs({
        expand_assets: opts.expandAssets,
        version: opts.version,
        locale: opts.locale,
        resolve_refs: opts.resolveRefs
      })}`
    ).then(jsonOrThrow),

  assets: (opts = {}) =>
    fetch(`${ROOT}/assets${qs(opts)}`).then(jsonOrThrow),

  asset: (id) => fetch(`${ROOT}/assets/${encodeURIComponent(id)}/meta`).then(jsonOrThrow),

  assetUrl: (id) => `${ROOT}/assets/${encodeURIComponent(id)}`,

  uploadAsset: async (file, { alt, kind } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (alt !== undefined) fd.append('alt', alt);
    if (kind !== undefined) fd.append('kind', kind);
    const res = await fetch(`${ROOT}/assets`, { method: 'POST', body: fd });
    return jsonOrThrow(res);
  },

  rpc: async (tool, args = {}) => {
    const res = await fetch(`${ROOT}/rpc`, {
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
