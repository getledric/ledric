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
  const [allTags, setAllTags] = useState([]);
  const [tagFilter, setTagFilter] = useState('');

  useEffect(() => {
    api.tags().then((t) => setAllTags(t ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTypeDef(null);
    setList(null);
    setError(null);
    const opts = { limit: 200 };
    if (tagFilter) opts.tags = [tagFilter];
    Promise.all([api.type(type), api.find(type, opts)])
      .then(([t, l]) => {
        if (cancelled) return;
        setTypeDef(t);
        setList(l);
      })
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [type, tagFilter]);

  if (error) {
    return html`<div className="text-red-700 border border-red-200 rounded p-4">${error.message}</div>`;
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
          <${Link} to="/types" className="text-sm text-zinc-500 hover:text-zinc-700">←</${Link}>
          <h1 className="text-2xl font-semibold">${type}</h1>
          <span className="text-xs text-zinc-500 tracking-widest uppercase">v${typeDef.version}</span>
        </div>
        <${Link}
          to=${`/types/${type}/new`}
          className="bg-amber-500 text-zinc-950 hover:bg-amber-400 transition px-3 py-1.5 rounded text-sm font-medium"
        >+ new ${type}</${Link}>
      </div>
      ${typeDef.description &&
        html`<p className="text-sm text-zinc-600 mb-4">${typeDef.description}</p>`}

      ${allTags.length > 0 && html`
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-zinc-500 uppercase tracking-widest">Filter</span>
          <select
            value=${tagFilter}
            onChange=${(e) => setTagFilter(e.target.value)}
            className="bg-zinc-100 border border-zinc-300 text-zinc-700 text-xs rounded px-2 py-1 focus:border-amber-500 outline-none"
          >
            <option value="">all tags</option>
            ${allTags.map((t) => html`<option key=${t.slug} value=${t.slug}>${t.label}</option>`)}
          </select>
          ${tagFilter && html`
            <button
              type="button"
              onClick=${() => setTagFilter('')}
              className="text-xs text-zinc-500 hover:text-zinc-700"
            >clear</button>
          `}
        </div>
      `}

      ${list.results.length === 0
        ? html`<div className="text-zinc-500 border border-zinc-200 rounded p-8 text-center">
            No entries yet.
          </div>`
        : html`
          <div className="border border-zinc-200 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-zinc-600 uppercase tracking-widest text-xs">
                <tr>
                  ${summary.map((f) => html`<th key=${f} className="text-left font-medium px-4 py-2">${f}</th>`)}
                  <th className="px-4 py-2 w-20 text-right">version</th>
                </tr>
              </thead>
              <tbody>
                ${list.results.map((entry) =>
                  html`
                    <tr key=${entry.id} className="border-t border-zinc-200 hover:bg-zinc-100/50">
                      ${summary.map((f, i) => {
                        const val = fieldPreview(entry.fields[f], typeDef.fields[f]);
                        const link = i === 0;
                        const cell = link
                          ? html`<${Link} to=${`/types/${type}/${entry.slug}`} className="text-amber-600 hover:text-amber-700">${val}</${Link}>`
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
