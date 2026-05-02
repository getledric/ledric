import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { html } from 'htm/react';
import { api } from '../lib/api.js';

export function TypeList() {
  const [model, setModel] = useState(null);
  const [counts, setCounts] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.types()
      .then(async (m) => {
        if (cancelled) return;
        setModel(m);
        const c = {};
        for (const name of Object.keys(m.types)) {
          if (cancelled) return;
          const r = await api.find(name, { limit: 1 });
          c[name] = r.total;
        }
        if (!cancelled) setCounts(c);
      })
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return html`<div className="text-red-700 border border-red-200 rounded p-4">${error.message}</div>`;
  }
  if (!model) {
    return html`<div className="text-zinc-500">loading…</div>`;
  }

  const types = Object.entries(model.types);
  if (types.length === 0) {
    return html`<div className="text-zinc-500">No types yet. Create one via MCP or with <code className="text-amber-600">create_type</code>.</div>`;
  }

  return html`
    <div>
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-semibold">Content types</h1>
        <span className="text-xs text-zinc-500 tracking-widest uppercase">schema v${model.schema_version}</span>
      </div>
      <ul className="space-y-2">
        ${types.map(([name, t]) =>
          html`
            <li key=${name}>
              <${Link}
                to=${`/types/${name}`}
                className="block border border-zinc-200 hover:border-zinc-400 rounded p-4 transition"
              >
                <div className="flex items-baseline justify-between">
                  <h2 className="text-lg font-medium tracking-tight">${name}</h2>
                  <span className="text-sm text-zinc-500">
                    ${counts[name] ?? '…'} ${counts[name] === 1 ? 'entry' : 'entries'} · v${t.version}
                  </span>
                </div>
                ${t.description &&
                  html`<p className="text-sm text-zinc-600 mt-1">${t.description}</p>`}
              </${Link}>
            </li>
          `
        )}
      </ul>
    </div>
  `;
}
