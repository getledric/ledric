import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { html } from 'htm/react';
import { api } from '../lib/api.js';

function fieldPreview(value, fieldDef) {
  if (value === undefined || value === null) return '—';
  if (fieldDef && fieldDef.type === 'asset') {
    if (typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value)) {
      return html`<img src=${api.assetUrl(value)} alt="" className="w-12 h-8 object-cover rounded" />`;
    }
    return html`<span className="text-zinc-500 text-xs">${String(value)}</span>`;
  }
  if (fieldDef && fieldDef.type === 'boolean') return value ? '✓' : '—';
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).slice(0, 3).join(', ') + (value.length > 3 ? '…' : '');
  }
  if (typeof value === 'object') return '{…}';
  const s = String(value);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

export function EntryList() {
  const { type } = useParams();
  const [typeDef, setTypeDef] = useState(null);
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setTypeDef(null);
    setList(null);
    setError(null);
    Promise.all([api.type(type), api.find(type, { limit: 200 })])
      .then(([t, l]) => {
        if (cancelled) return;
        setTypeDef(t);
        setList(l);
      })
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [type]);

  if (error) {
    return html`<div className="text-red-400 border border-red-900 rounded p-4">${error.message}</div>`;
  }
  if (!typeDef || !list) {
    return html`<div className="text-zinc-500">loading…</div>`;
  }

  const summary = (typeDef.summary_fields && typeDef.summary_fields.length > 0)
    ? typeDef.summary_fields
    : Object.keys(typeDef.fields).slice(0, 4);

  return html`
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="flex items-baseline gap-3">
          <${Link} to="/types" className="text-sm text-zinc-500 hover:text-zinc-300">←</${Link}>
          <h1 className="text-2xl font-semibold">${type}</h1>
          <span className="text-xs text-zinc-500 tracking-widest uppercase">v${typeDef.version}</span>
        </div>
        <${Link}
          to=${`/types/${type}/new`}
          className="bg-amber-500 text-zinc-950 hover:bg-amber-400 transition px-3 py-1.5 rounded text-sm font-medium"
        >+ new ${type}</${Link}>
      </div>
      ${typeDef.description &&
        html`<p className="text-sm text-zinc-400 mb-4">${typeDef.description}</p>`}
      ${list.results.length === 0
        ? html`<div className="text-zinc-500 border border-zinc-800 rounded p-8 text-center">
            No entries yet.
          </div>`
        : html`
          <div className="border border-zinc-800 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-zinc-400 uppercase tracking-widest text-xs">
                <tr>
                  ${summary.map((f) => html`<th key=${f} className="text-left font-medium px-4 py-2">${f}</th>`)}
                  <th className="px-4 py-2 w-20 text-right">version</th>
                </tr>
              </thead>
              <tbody>
                ${list.results.map((entry) =>
                  html`
                    <tr key=${entry.id} className="border-t border-zinc-800 hover:bg-zinc-900/50">
                      ${summary.map((f, i) => {
                        const val = fieldPreview(entry.fields[f], typeDef.fields[f]);
                        const link = i === 0;
                        const cell = link
                          ? html`<${Link} to=${`/types/${type}/${entry.slug}`} className="text-amber-400 hover:text-amber-300">${val}</${Link}>`
                          : val;
                        return html`<td key=${f} className="px-4 py-2 align-middle">${cell}</td>`;
                      })}
                      <td className="px-4 py-2 text-right text-zinc-500">${entry.version}${entry.published_version != null ? ` · pub ${entry.published_version}` : ''}</td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          </div>
        `}
    </div>
  `;
}
