import { useState, useRef, useMemo, useEffect } from 'react';
import { html } from 'htm/react';
import { marked } from 'marked';
import { api } from '../lib/api.js';
import {
  wrapInValue,
  linePrefixInValue,
  insertAt,
  assetSnippet
} from '../lib/markdown-edit.js';

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const labelClass = 'block text-xs uppercase tracking-widest text-zinc-500 mb-1';
const inputClass =
  'w-full bg-zinc-100 border border-zinc-200 focus:border-zinc-400 outline-none rounded px-3 py-2 text-sm';

function FieldShell({ name, def, children, hint }) {
  return html`
    <div className="mb-4">
      <label className=${labelClass}>
        ${name}${def.required && html`<span className="text-amber-600"> *</span>`}
        ${def.localized && html`<span className="ml-2 text-zinc-400 normal-case tracking-normal text-xs">localized</span>`}
      </label>
      ${children}
      ${hint && html`<p className="text-xs text-zinc-400 mt-1">${hint}</p>`}
      ${def.description && html`<p className="text-xs text-zinc-500 mt-1">${def.description}</p>`}
    </div>
  `;
}

function StringField({ name, def, value, onChange }) {
  const long = (def.max ?? 80) > 200;
  return html`
    <${FieldShell} name=${name} def=${def}>
      ${long
        ? html`<textarea className=${inputClass} rows=${3} value=${value ?? ''} onChange=${(e) => onChange(e.target.value)} maxLength=${def.max} />`
        : html`<input type="text" className=${inputClass} value=${value ?? ''} onChange=${(e) => onChange(e.target.value)} maxLength=${def.max} pattern=${def.pattern} />`}
    </${FieldShell}>
  `;
}

function SlugField({ name, def, value, onChange, content }) {
  const source = def.from ? content[def.from] : undefined;
  const canDerive = typeof source === 'string' && source.length > 0;
  return html`
    <${FieldShell} name=${name} def=${def} hint=${def.from ? `Derives from "${def.from}" if blank.` : null}>
      <div className="flex gap-2">
        <input
          type="text"
          className=${inputClass}
          value=${value ?? ''}
          onChange=${(e) => onChange(e.target.value)}
          placeholder=${def.from ? '(auto-derived)' : ''}
        />
        ${canDerive && html`
          <button
            type="button"
            onClick=${() => onChange(slugify(source))}
            className="text-xs px-2 py-1 border border-zinc-200 hover:border-zinc-400 rounded text-zinc-600 hover:text-zinc-900"
          >derive</button>
        `}
      </div>
    </${FieldShell}>
  `;
}

function NumberField({ name, def, value, onChange }) {
  return html`
    <${FieldShell} name=${name} def=${def}>
      <input
        type="number"
        className=${inputClass}
        value=${value ?? ''}
        min=${def.min}
        max=${def.max}
        step=${def.integer ? 1 : 'any'}
        onChange=${(e) => {
          const n = e.target.value === '' ? undefined : Number(e.target.value);
          onChange(n);
        }}
      />
    </${FieldShell}>
  `;
}

function BooleanField({ name, def, value, onChange }) {
  return html`
    <div className="mb-4">
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked=${value === true}
          onChange=${(e) => onChange(e.target.checked)}
        />
        <span className="text-zinc-700">${name}${def.required && html`<span className="text-amber-600"> *</span>`}</span>
      </label>
      ${def.description && html`<p className="text-xs text-zinc-500 mt-1 ml-6">${def.description}</p>`}
    </div>
  `;
}

function DateField({ name, def, value, onChange }) {
  // Reduce ISO timestamps to YYYY-MM-DD for the date picker.
  const v = typeof value === 'string' ? value.slice(0, 10) : '';
  return html`
    <${FieldShell} name=${name} def=${def}>
      <input
        type="date"
        className=${inputClass}
        value=${v}
        onChange=${(e) => onChange(e.target.value || undefined)}
      />
    </${FieldShell}>
  `;
}

function ToolbarButton({ onClick, title, children, disabled, bold, italic, mono }) {
  const cls = [
    'text-xs px-2 py-1 rounded transition select-none',
    'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200',
    'disabled:opacity-40 disabled:hover:bg-transparent',
    bold ? 'font-bold' : '',
    italic ? 'italic' : '',
    mono ? 'font-mono' : ''
  ].filter(Boolean).join(' ');
  return html`
    <button type="button" onClick=${onClick} title=${title} disabled=${disabled} className=${cls}>
      ${children}
    </button>
  `;
}

function MarkdownField({ name, def, value, onChange }) {
  const textareaRef = useRef(null);
  const fileRef = useRef(null);
  const [tab, setTab] = useState('edit');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  function applyResult(r) {
    onChange(r.value);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(r.selectionStart, r.selectionEnd);
    });
  }

  function withSelection(fn) {
    const ta = textareaRef.current;
    if (!ta) return null;
    return fn(value ?? '', ta.selectionStart, ta.selectionEnd);
  }

  function wrap(before, after) {
    const r = withSelection((v, s, e) => wrapInValue(v, s, e, before, after));
    if (r) applyResult(r);
  }

  function linePrefix(prefix) {
    const r = withSelection((v, s, e) => linePrefixInValue(v, s, e, prefix));
    if (r) applyResult(r);
  }

  function onLink() {
    const url = window.prompt('Link URL?');
    if (!url) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const v = value ?? '';
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = v.slice(s, e) || 'link text';
    const next = v.slice(0, s) + `[${sel}](${url})` + v.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const labelStart = s + 1;
      ta.setSelectionRange(labelStart, labelStart + sel.length);
    });
  }

  async function onAssetFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const result = await api.uploadAsset(file);
      const isImage = (file.type ?? '').startsWith('image/');
      const snippet = assetSnippet(
        isImage ? 'image' : 'file',
        file.name,
        result.url ?? `${api.baseUrl}/assets/${result.ref_key}`
      );
      const ta = textareaRef.current;
      const v = value ?? '';
      const pos = ta ? ta.selectionStart : v.length;
      applyResult(insertAt(v, pos, snippet));
    } catch (err) {
      setUploadError(err.message ?? 'upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onKeyDown(e) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); wrap('**'); }
    else if (k === 'i') { e.preventDefault(); wrap('_'); }
    else if (k === 'k') { e.preventDefault(); onLink(); }
  }

  const previewHtml = useMemo(() => {
    if (tab !== 'preview') return '';
    try {
      return marked.parse(value ?? '', { async: false, breaks: true, gfm: true });
    } catch (err) {
      return `<p style="color:#f87171">preview error: ${err.message}</p>`;
    }
  }, [tab, value]);

  const tabBtnClass = (active) =>
    `text-xs px-2 py-0.5 rounded transition ${
      active
        ? 'bg-zinc-200 text-zinc-900'
        : 'text-zinc-500 hover:text-zinc-800'
    }`;

  return html`
    <${FieldShell} name=${name} def=${def} hint=${def.html ? `HTML policy: ${def.html}` : null}>
      <div className="border border-zinc-200 rounded overflow-hidden bg-zinc-100">
        <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-zinc-200 bg-zinc-50/50 flex-wrap">
          <${ToolbarButton} onClick=${() => wrap('**')} title="Bold (⌘B)" bold>B</${ToolbarButton}>
          <${ToolbarButton} onClick=${() => wrap('_')} title="Italic (⌘I)" italic>I</${ToolbarButton}>
          <span className="w-px h-4 bg-zinc-200 mx-1"></span>
          <${ToolbarButton} onClick=${() => linePrefix('## ')} title="Heading 2">H2</${ToolbarButton}>
          <${ToolbarButton} onClick=${() => linePrefix('### ')} title="Heading 3">H3</${ToolbarButton}>
          <span className="w-px h-4 bg-zinc-200 mx-1"></span>
          <${ToolbarButton} onClick=${onLink} title="Link (⌘K)">link</${ToolbarButton}>
          <${ToolbarButton} onClick=${() => wrap('\`')} title="Inline code" mono>code</${ToolbarButton}>
          <${ToolbarButton} onClick=${() => linePrefix('> ')} title="Quote">quote</${ToolbarButton}>
          <${ToolbarButton} onClick=${() => linePrefix('- ')} title="Bulleted list">list</${ToolbarButton}>
          <span className="w-px h-4 bg-zinc-200 mx-1"></span>
          <input
            ref=${fileRef}
            type="file"
            onChange=${onAssetFile}
            style=${{ display: 'none' }}
          />
          <${ToolbarButton}
            onClick=${() => fileRef.current?.click()}
            title="Upload and insert an asset"
            disabled=${uploading}
          >${uploading ? '…' : 'asset'}</${ToolbarButton}>
          <div className="flex-1"></div>
          <button
            type="button"
            onClick=${() => setTab('edit')}
            className=${tabBtnClass(tab === 'edit')}
          >edit</button>
          <button
            type="button"
            onClick=${() => setTab('preview')}
            className=${tabBtnClass(tab === 'preview')}
          >preview</button>
        </div>
        ${tab === 'edit' && html`
          <textarea
            ref=${textareaRef}
            className="w-full bg-zinc-100 outline-none px-3 py-2 text-sm font-mono leading-relaxed resize-y"
            rows=${12}
            value=${value ?? ''}
            onChange=${(e) => onChange(e.target.value)}
            onKeyDown=${onKeyDown}
            maxLength=${def.max}
            spellCheck=${false}
          />
        `}
        ${tab === 'preview' && html`
          <div
            className="prose prose-invert prose-sm max-w-none px-4 py-3 min-h-[12rem] bg-zinc-50"
            dangerouslySetInnerHTML=${{ __html: previewHtml || '<p class="text-zinc-400">empty</p>' }}
          />
        `}
      </div>
      ${uploadError && html`<p className="text-xs text-red-700 mt-1">${uploadError}</p>`}
    </${FieldShell}>
  `;
}

function EnumField({ name, def, value, onChange }) {
  return html`
    <${FieldShell} name=${name} def=${def}>
      <select
        className=${inputClass}
        value=${value ?? ''}
        onChange=${(e) => onChange(e.target.value || undefined)}
      >
        <option value="">— pick one —</option>
        ${def.values.map((v) => html`<option key=${v} value=${v}>${v}</option>`)}
      </select>
    </${FieldShell}>
  `;
}

function AssetField({ name, def, value, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [library, setLibrary] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState('');
  const fileInput = useRef(null);

  const isHexId = typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
  const isPlaceholder = typeof value === 'string' && value.length > 0 && !isHexId;
  const allowedKinds =
    Array.isArray(def.kinds) && def.kinds.length > 0 ? new Set(def.kinds) : null;

  useEffect(() => {
    if (!isHexId) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    api
      .asset(value)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch(() => {
        if (!cancelled) setMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, isHexId]);

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    setLibraryLoading(true);
    api
      .assets({ limit: 200 })
      .then((r) => {
        if (cancelled) return;
        setLibrary(r?.results ?? []);
        setLibraryLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLibraryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const result = await api.uploadAsset(file);
      setMeta(result);
      onChange(result.id);
    } catch (err) {
      setError(err.message ?? 'upload failed');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function pickFromLibrary(asset) {
    setMeta(asset);
    onChange(asset.id);
    setPickerOpen(false);
    setLibraryQuery('');
  }

  const term = libraryQuery.trim().toLowerCase();
  const candidates = library
    .filter((a) => (allowedKinds ? allowedKinds.has(a.kind) : true))
    .filter((a) => {
      if (term === '') return true;
      const m = a.meta ?? {};
      const filename = String(m.filename ?? '').toLowerCase();
      const alt = String(m.alt ?? '').toLowerCase();
      const tags = (a.tags ?? []).map((t) => String(t.label ?? t.slug ?? '').toLowerCase());
      return filename.includes(term) || alt.includes(term) || tags.some((t) => t.includes(term));
    });

  const previewUrl = meta?.ref_key ? `${api.baseUrl}/assets/${meta.ref_key}` : null;
  const kind = meta?.kind;

  return html`
    <${FieldShell} name=${name} def=${def} hint=${def.kinds ? `Allowed kinds: ${def.kinds.join(', ')}` : null}>
      ${isHexId && html`
        <div className="flex items-start gap-3 mb-2">
          ${previewUrl && kind === 'image'
            ? html`<img src=${previewUrl} alt="" className="w-24 h-16 object-cover rounded border border-zinc-200" />`
            : html`<div className="w-24 h-16 rounded border border-zinc-200 bg-zinc-100 flex items-center justify-center text-[10px] uppercase tracking-wider text-zinc-500">${kind ?? '…'}</div>`}
          <div className="flex-1 text-xs text-zinc-500 min-w-0">
            <div className="font-mono break-all">${value}</div>
            ${previewUrl &&
            html`<a
              href=${previewUrl}
              target="_blank"
              rel="noreferrer"
              className="text-zinc-600 hover:text-amber-600 underline-offset-2 hover:underline break-all"
            >${meta?.url ?? previewUrl}</a>`}
          </div>
          <button
            type="button"
            onClick=${() => onChange(undefined)}
            className="text-xs px-2 py-1 border border-zinc-200 hover:border-red-300 hover:text-red-700 rounded text-zinc-500"
          >clear</button>
        </div>
      `}
      ${isPlaceholder && html`
        <div className="mb-2 text-xs text-amber-600 border border-amber-200 bg-amber-50 rounded px-3 py-2">
          Placeholder string: <code className="font-mono">${value}</code> · upload a real asset to replace.
        </div>
      `}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          ref=${fileInput}
          type="file"
          accept=${def.kinds && def.kinds.includes('image') ? 'image/*' : undefined}
          onChange=${onFile}
          className="text-xs text-zinc-600 file:mr-3 file:px-3 file:py-1.5 file:text-xs file:border file:border-zinc-200 file:bg-zinc-100 file:text-zinc-800 file:hover:bg-zinc-200 file:rounded file:cursor-pointer file:transition"
        />
        <button
          type="button"
          onClick=${() => setPickerOpen((v) => !v)}
          className="text-xs px-3 py-1.5 border border-zinc-200 hover:border-zinc-400 rounded text-zinc-700"
        >${pickerOpen ? 'close library' : 'pick from library'}</button>
        ${uploading && html`<span className="text-xs text-zinc-500">uploading…</span>`}
      </div>
      ${pickerOpen && html`
        <div className="mt-2 border border-zinc-200 rounded bg-white p-3">
          <input
            type="text"
            value=${libraryQuery}
            onChange=${(e) => setLibraryQuery(e.target.value)}
            placeholder=${`Search ${allowedKinds ? [...allowedKinds].join(' / ') + ' ' : ''}assets by filename, alt, or tag…`}
            className=${`${inputClass} mb-3`}
          />
          ${libraryLoading
            ? html`<div className="text-xs text-zinc-500">loading…</div>`
            : candidates.length === 0
              ? html`<div className="text-xs text-zinc-500">${
                  library.length === 0
                    ? 'No assets uploaded yet.'
                    : allowedKinds
                      ? `No ${[...allowedKinds].join(' / ')} assets match.`
                      : 'No matches.'
                }</div>`
              : html`<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-72 overflow-y-auto">
                  ${candidates.map((a) => {
                    const url = `${api.baseUrl}/assets/${a.ref_key}`;
                    const filename = (a.meta?.filename ?? '').toString();
                    const alt = (a.meta?.alt ?? '').toString();
                    const isImage = a.kind === 'image';
                    return html`
                      <button
                        key=${a.id}
                        type="button"
                        onClick=${() => pickFromLibrary(a)}
                        className=${`text-left border rounded overflow-hidden hover:border-amber-500 transition ${
                          a.id === value ? 'border-amber-500 ring-1 ring-amber-500' : 'border-zinc-200'
                        }`}
                        title=${filename || a.id}
                      >
                        ${isImage
                          ? html`<img src=${url} alt=${alt} className="w-full h-20 object-cover bg-zinc-100" />`
                          : html`<div className="w-full h-20 bg-zinc-100 flex items-center justify-center text-[10px] uppercase tracking-wider text-zinc-500">${a.kind}</div>`}
                        <div className="px-2 py-1 text-[10px] text-zinc-700 truncate">${filename || a.id.slice(0, 8) + '…'}</div>
                      </button>
                    `;
                  })}
                </div>`}
        </div>
      `}
      ${error && html`<p className="text-xs text-red-700 mt-1">${error}</p>`}
    </${FieldShell}>
  `;
}

function refLabel(entry) {
  const f = entry.fields ?? {};
  return f.title || f.name || f.label || f.headline || entry.slug;
}

function ReferencesField({ name, def, value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const allowedTypes = Array.isArray(def.to) ? def.to : [];
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [pool, setPool] = useState([]);
  const [resolved, setResolved] = useState({});
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const max = def.max;
  const atMax = max !== undefined && arr.length >= max;
  const readOnly = !onChange;

  useEffect(() => {
    if (allowedTypes.length === 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const lists = await Promise.all(
        allowedTypes.map((t) => api.find(t, { limit: 100 }).catch(() => null))
      );
      if (cancelled) return;
      const flat = [];
      for (let i = 0; i < allowedTypes.length; i++) {
        const list = lists[i];
        if (!list?.results) continue;
        for (const e of list.results) {
          flat.push({
            type: allowedTypes[i],
            slug: e.slug,
            label: refLabel(e)
          });
        }
      }
      setPool(flat);
      const map = {};
      for (const item of flat) map[`${item.type}/${item.slug}`] = item;
      setResolved((prev) => ({ ...map, ...prev }));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [allowedTypes.join(',')]);

  const term = input.trim().toLowerCase();
  const selectedKeys = new Set(arr.map((s) => String(s).split('@')[0]));
  const candidates = pool
    .filter((c) => !selectedKeys.has(`${c.type}/${c.slug}`))
    .filter(
      (c) =>
        term === '' ||
        c.label.toLowerCase().includes(term) ||
        c.slug.toLowerCase().includes(term) ||
        c.type.toLowerCase().includes(term)
    )
    .slice(0, 12);

  function add(c) {
    if (atMax) return;
    onChange([...arr, `${c.type}/${c.slug}`]);
    setResolved((prev) => ({ ...prev, [`${c.type}/${c.slug}`]: c }));
    setInput('');
    setOpen(false);
    inputRef.current?.blur();
  }
  function removeAt(i) {
    onChange(arr.filter((_, j) => j !== i));
  }

  function refKey(ref) {
    return String(ref).split('@')[0];
  }
  function displayFor(ref) {
    const key = refKey(ref);
    const r = resolved[key];
    if (r) return { label: r.label, type: r.type, slug: r.slug, missing: false };
    const slash = key.indexOf('/');
    if (slash > 0) {
      return {
        type: key.slice(0, slash),
        slug: key.slice(slash + 1),
        label: key.slice(slash + 1),
        missing: pool.length > 0
      };
    }
    return { type: '?', slug: key, label: key, missing: true };
  }

  return html`
    <${FieldShell}
      name=${name}
      def=${def}
      hint=${allowedTypes.length === 0
        ? 'No allowed types declared on this field.'
        : `References to ${allowedTypes.join(' / ')}${max !== undefined ? ` · up to ${max}` : ''}`}
    >
      <div className="flex flex-wrap gap-1.5 items-center mb-2">
        ${arr.map((ref, i) => {
          const d = displayFor(ref);
          return html`
            <span
              key=${i}
              className=${`inline-flex items-center gap-1.5 text-xs rounded px-2 py-1 border ${d.missing
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : 'border-zinc-200 bg-zinc-100 text-zinc-800'}`}
              title=${`${d.type}/${d.slug}`}
            >
              <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-wider">${d.type}</span>
              <span>${d.label}</span>
              ${!readOnly &&
              html`<button
                type="button"
                onClick=${() => removeAt(i)}
                className="text-zinc-500 hover:text-red-700 leading-none"
                title="Remove"
              >×</button>`}
            </span>
          `;
        })}
        ${arr.length === 0 && readOnly && html`<span className="text-xs text-zinc-500">none</span>`}
      </div>
      ${!readOnly &&
      html`<div className="relative">
        <input
          ref=${inputRef}
          type="text"
          className=${`${inputClass} ${atMax ? 'opacity-50 cursor-not-allowed' : ''}`}
          value=${input}
          placeholder=${atMax
            ? `Maximum of ${max} reached`
            : allowedTypes.length === 0
              ? 'No allowed types'
              : `Pick a ${allowedTypes.join(' or ')}…`}
          disabled=${atMax || allowedTypes.length === 0}
          onChange=${(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus=${() => setOpen(true)}
          onBlur=${() => setTimeout(() => setOpen(false), 150)}
        />
        ${open &&
        !atMax &&
        html`<div className="absolute left-0 right-0 top-full mt-1 z-50 bg-white border border-zinc-200 rounded shadow-lg max-h-72 overflow-y-auto">
          ${loading && pool.length === 0
            ? html`<div className="px-3 py-2 text-xs text-zinc-500">loading…</div>`
            : candidates.length === 0
              ? html`<div className="px-3 py-2 text-xs text-zinc-500">${
                  pool.length === 0 ? 'No entries yet for these types.' : 'No matches.'
                }</div>`
              : candidates.map(
                  (c) => html`
                    <button
                      key=${`${c.type}/${c.slug}`}
                      type="button"
                      onMouseDown=${(e) => {
                        e.preventDefault();
                        add(c);
                      }}
                      className="flex items-baseline gap-2 w-full text-left text-xs px-3 py-1.5 hover:bg-zinc-100"
                    >
                      <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-wider">${c.type}</span>
                      <span className="text-zinc-800 flex-1 truncate">${c.label}</span>
                      ${c.label !== c.slug &&
                      html`<span className="text-zinc-400 font-mono">${c.slug}</span>`}
                    </button>
                  `
                )}
        </div>`}
      </div>`}
    </${FieldShell}>
  `;
}

function ArrayOfPrimitiveField({ name, def, value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const itemDef = def.of;
  const [pending, setPending] = useState('');

  function commit(raw) {
    if (itemDef.type === 'number') {
      const trimmed = String(raw).trim();
      if (trimmed === '') return null;
      const n = Number(trimmed);
      if (Number.isNaN(n)) return null;
      if (itemDef.integer && !Number.isInteger(n)) return null;
      return n;
    }
    if (itemDef.type === 'string') {
      const t = String(raw).trim();
      return t === '' ? null : t;
    }
    return raw;
  }

  function add() {
    const v = commit(pending);
    if (v === null) return;
    if (arr.includes(v)) return;
    onChange([...arr, v]);
    setPending('');
  }

  function remove(i) {
    const next = arr.filter((_, j) => j !== i);
    onChange(next.length > 0 ? next : undefined);
  }

  // Enum-of-values: a select beats a freeform input.
  if (itemDef.type === 'enum') {
    const remaining = (itemDef.values ?? []).filter((v) => !arr.includes(v));
    return html`
      <${FieldShell} name=${name} def=${def}>
        <div className="flex flex-wrap gap-1 mb-2">
          ${arr.map((v, i) => html`
            <span key=${i} className="inline-flex items-center gap-1 text-xs bg-zinc-100 border border-zinc-200 rounded-full px-2 py-1">
              ${v}
              <button
                type="button"
                onClick=${() => remove(i)}
                className="text-zinc-500 hover:text-red-700"
              >×</button>
            </span>
          `)}
          ${arr.length === 0 && html`<span className="text-xs text-zinc-500">none</span>`}
        </div>
        ${remaining.length > 0 && html`<select
          className=${inputClass}
          value=""
          onChange=${(e) => {
            if (e.target.value) onChange([...arr, e.target.value]);
          }}
        >
          <option value="">— add ${name} —</option>
          ${remaining.map((v) => html`<option key=${v} value=${v}>${v}</option>`)}
        </select>`}
      </${FieldShell}>
    `;
  }

  const inputType = itemDef.type === 'number' ? 'number' : 'text';
  const placeholder =
    itemDef.type === 'number' ? 'add a number and press enter' : 'add an item and press enter';

  return html`
    <${FieldShell} name=${name} def=${def}>
      <div className="flex flex-wrap gap-1 mb-2">
        ${arr.map((v, i) => html`
          <span key=${i} className="inline-flex items-center gap-1 text-xs bg-zinc-100 border border-zinc-200 rounded-full px-2 py-1">
            ${String(v)}
            <button
              type="button"
              onClick=${() => remove(i)}
              className="text-zinc-500 hover:text-red-700"
            >×</button>
          </span>
        `)}
      </div>
      <div className="flex gap-2">
        <input
          type=${inputType}
          className=${inputClass}
          value=${pending}
          onChange=${(e) => setPending(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder=${placeholder}
        />
        <button
          type="button"
          onClick=${add}
          className="text-xs px-3 py-1 border border-zinc-200 hover:border-zinc-400 rounded text-zinc-600"
        >add</button>
      </div>
    </${FieldShell}>
  `;
}

function ObjectField({ name, def, value, onChange }) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fields = def.fields ?? {};

  function setNested(key, v) {
    const next = { ...obj };
    if (v === undefined) {
      delete next[key];
    } else {
      next[key] = v;
    }
    onChange(Object.keys(next).length > 0 ? next : undefined);
  }

  return html`
    <${FieldShell} name=${name} def=${def}>
      <div className="border-l-2 border-zinc-200 pl-4 pt-1 space-y-1">
        ${Object.keys(fields).length === 0
          ? html`<div className="text-xs text-zinc-500">No fields declared on this object.</div>`
          : Object.entries(fields).map(([k, fdef]) => html`
            <${FieldRenderer}
              key=${k}
              name=${k}
              def=${fdef}
              value=${obj[k]}
              content=${obj}
              onChange=${(v) => setNested(k, v)}
            />
          `)}
      </div>
    </${FieldShell}>
  `;
}

function ArrayOfObjectField({ name, def, value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const itemDef = def.of ?? { type: 'object', fields: {} };
  const itemFields = itemDef.fields ?? {};

  function updateAt(i, v) {
    const next = [...arr];
    if (v === undefined) {
      next.splice(i, 1);
    } else {
      next[i] = v;
    }
    onChange(next.length > 0 ? next : undefined);
  }
  function setNestedAt(i, key, v) {
    const item = { ...(arr[i] ?? {}) };
    if (v === undefined) {
      delete item[key];
    } else {
      item[key] = v;
    }
    updateAt(i, Object.keys(item).length > 0 ? item : {});
  }
  function add() {
    onChange([...arr, {}]);
  }
  function remove(i) {
    const next = arr.filter((_, j) => j !== i);
    onChange(next.length > 0 ? next : undefined);
  }
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    const next = [...arr];
    const tmp = next[i];
    next[i] = next[j];
    next[j] = tmp;
    onChange(next);
  }

  return html`
    <${FieldShell} name=${name} def=${def}>
      ${arr.length === 0 && html`<div className="text-xs text-zinc-500 mb-2">No items.</div>`}
      ${arr.map((item, i) => html`
        <div key=${i} className="border border-zinc-200 rounded p-3 mb-2 bg-white">
          <div className="flex items-center justify-between mb-2 pb-1 border-b border-zinc-100">
            <span className="text-xs uppercase tracking-widest text-zinc-500">#${i + 1}</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                disabled=${i === 0}
                onClick=${() => move(i, -1)}
                className="text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-30 px-2 py-0.5"
                title="Move up"
              >↑</button>
              <button
                type="button"
                disabled=${i === arr.length - 1}
                onClick=${() => move(i, 1)}
                className="text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-30 px-2 py-0.5"
                title="Move down"
              >↓</button>
              <button
                type="button"
                onClick=${() => remove(i)}
                className="text-xs text-zinc-500 hover:text-red-700 px-2 py-0.5"
                title="Remove"
              >×</button>
            </div>
          </div>
          <div className="space-y-1">
            ${Object.entries(itemFields).map(([k, fdef]) => html`
              <${FieldRenderer}
                key=${k}
                name=${k}
                def=${fdef}
                value=${item?.[k]}
                content=${item ?? {}}
                onChange=${(v) => setNestedAt(i, k, v)}
              />
            `)}
          </div>
        </div>
      `)}
      <button
        type="button"
        onClick=${add}
        className="text-xs px-3 py-1 border border-zinc-300 hover:border-zinc-500 rounded text-zinc-700"
      >+ add item</button>
    </${FieldShell}>
  `;
}

function FallbackField({ name, def, value }) {
  return html`
    <${FieldShell} name=${name} def=${def} hint=${`Field type "${def.type}" — read-only in this admin UI for now.`}>
      <pre className="text-xs bg-zinc-100 border border-zinc-200 rounded p-3 overflow-auto">${JSON.stringify(value, null, 2)}</pre>
    </${FieldShell}>
  `;
}

// JSS — JSON-aware textarea. Stored value is the parsed object; the
// editor surface is a string buffer so the user can have transient
// invalid JSON while typing without us throwing the input away.
function JssField({ name, def, value, onChange }) {
  const initial = useMemo(() => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }, []); // run once — we control draft state from here on
  const [draft, setDraft] = useState(initial);
  const [parseError, setParseError] = useState(null);

  function commit(text) {
    setDraft(text);
    if (text.trim() === '') {
      setParseError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setParseError('JSS must be a JSON object (selector → rules)');
        return;
      }
      setParseError(null);
      onChange(parsed);
    } catch (e) {
      setParseError(e.message);
    }
  }

  function format() {
    if (draft.trim() === '') return;
    try {
      const parsed = JSON.parse(draft);
      const formatted = JSON.stringify(parsed, null, 2);
      setDraft(formatted);
      setParseError(null);
      onChange(parsed);
    } catch (e) {
      setParseError(e.message);
    }
  }

  function minify() {
    if (draft.trim() === '') return;
    try {
      const parsed = JSON.parse(draft);
      const minified = JSON.stringify(parsed);
      setDraft(minified);
      setParseError(null);
      onChange(parsed);
    } catch (e) {
      setParseError(e.message);
    }
  }

  return html`
    <${FieldShell} name=${name} def=${def} hint="CSS-in-JS object. @apply: \"...\" composes Tailwind utilities at the consumer.">
      <div className="border border-zinc-200 rounded overflow-hidden bg-zinc-100">
        <div className="flex items-center gap-2 px-2 py-1 border-b border-zinc-200 bg-zinc-50/50">
          <span className=${`text-xs ${parseError ? 'text-red-700' : 'text-green-600'}`}>
            ${draft.trim() === '' ? 'empty' : parseError ? 'invalid JSON' : 'valid JSON'}
          </span>
          <div className="flex-1"></div>
          <button
            type="button"
            onClick=${format}
            disabled=${draft.trim() === ''}
            className="text-xs px-2 py-0.5 rounded text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200 disabled:opacity-40"
            title="Pretty-print"
          >format</button>
          <button
            type="button"
            onClick=${minify}
            disabled=${draft.trim() === ''}
            className="text-xs px-2 py-0.5 rounded text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200 disabled:opacity-40"
            title="Minify"
          >minify</button>
        </div>
        <textarea
          className="w-full bg-zinc-100 outline-none px-3 py-2 text-xs font-mono leading-relaxed resize-y"
          rows=${10}
          spellCheck=${false}
          value=${draft}
          onChange=${(e) => commit(e.target.value)}
          placeholder=${'{\n  ".hero": {\n    "@apply": "text-2xl font-bold",\n    "color": "var(--brand)"\n  }\n}'}
        />
      </div>
      ${parseError && html`<p className="text-xs text-red-700 mt-1 font-mono">${parseError}</p>`}
    </${FieldShell}>
  `;
}

function CssField({ name, def, value, onChange }) {
  const v = value ?? '';
  const overLimit = def.max !== undefined && v.length > def.max;
  return html`
    <${FieldShell} name=${name} def=${def} hint="Raw CSS source. The consumer scopes/applies it at render time.">
      <textarea
        className=${`${inputClass} font-mono text-xs leading-relaxed resize-y`}
        rows=${10}
        spellCheck=${false}
        value=${v}
        onChange=${(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        placeholder=${'.hero { color: var(--brand); }'}
        maxLength=${def.max}
      />
      ${def.max !== undefined && html`
        <div className=${`text-xs mt-1 text-right ${overLimit ? 'text-red-700' : 'text-zinc-400'}`}>
          ${v.length} / ${def.max}
        </div>
      `}
    </${FieldShell}>
  `;
}

export function FieldRenderer(props) {
  const { def } = props;
  switch (def.type) {
    case 'string': return html`<${StringField} ...${props} />`;
    case 'slug':   return html`<${SlugField} ...${props} />`;
    case 'number': return html`<${NumberField} ...${props} />`;
    case 'boolean':return html`<${BooleanField} ...${props} />`;
    case 'date':   return html`<${DateField} ...${props} />`;
    case 'markdown': return html`<${MarkdownField} ...${props} />`;
    case 'enum':   return html`<${EnumField} ...${props} />`;
    case 'asset':  return html`<${AssetField} ...${props} />`;
    case 'references': return html`<${ReferencesField} ...${props} />`;
    case 'jss':    return html`<${JssField} ...${props} />`;
    case 'css':    return html`<${CssField} ...${props} />`;
    case 'object': return html`<${ObjectField} ...${props} />`;
    case 'array': {
      const ofType = def.of && def.of.type;
      if (ofType === 'object') return html`<${ArrayOfObjectField} ...${props} />`;
      if (ofType === 'string' || ofType === 'number' || ofType === 'enum') {
        return html`<${ArrayOfPrimitiveField} ...${props} />`;
      }
      return html`<${FallbackField} ...${props} />`;
    }
    default:
      return html`<${FallbackField} ...${props} />`;
  }
}
