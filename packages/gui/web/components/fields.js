import { useState, useRef } from 'react';
import { html } from 'htm/react';
import { api } from '../lib/api.js';

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
  'w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-600 outline-none rounded px-3 py-2 text-sm';

function FieldShell({ name, def, children, hint }) {
  return html`
    <div className="mb-4">
      <label className=${labelClass}>
        ${name}${def.required && html`<span className="text-amber-500"> *</span>`}
        ${def.localized && html`<span className="ml-2 text-zinc-600 normal-case tracking-normal text-xs">localized</span>`}
      </label>
      ${children}
      ${hint && html`<p className="text-xs text-zinc-600 mt-1">${hint}</p>`}
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
            className="text-xs px-2 py-1 border border-zinc-800 hover:border-zinc-600 rounded text-zinc-400 hover:text-zinc-100"
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
        <span className="text-zinc-300">${name}${def.required && html`<span className="text-amber-500"> *</span>`}</span>
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

function MarkdownField({ name, def, value, onChange }) {
  return html`
    <${FieldShell} name=${name} def=${def} hint=${def.html ? `HTML policy: ${def.html}` : null}>
      <textarea
        className=${`${inputClass} font-mono text-xs`}
        rows=${10}
        value=${value ?? ''}
        onChange=${(e) => onChange(e.target.value)}
        maxLength=${def.max}
      />
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
  const fileInput = useRef(null);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const result = await api.uploadAsset(file);
      onChange(result.id);
    } catch (err) {
      setError(err.message ?? 'upload failed');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const isHexId = typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
  const isPlaceholder = typeof value === 'string' && value.length > 0 && !isHexId;

  return html`
    <${FieldShell} name=${name} def=${def} hint=${def.kinds ? `Allowed kinds: ${def.kinds.join(', ')}` : null}>
      ${isHexId && html`
        <div className="flex items-start gap-3 mb-2">
          <img src=${api.assetUrl(value)} alt="" className="w-24 h-16 object-cover rounded border border-zinc-800" />
          <div className="flex-1 text-xs text-zinc-500">
            <div className="font-mono break-all">${value}</div>
          </div>
          <button
            type="button"
            onClick=${() => onChange(undefined)}
            className="text-xs px-2 py-1 border border-zinc-800 hover:border-red-900 hover:text-red-400 rounded text-zinc-500"
          >clear</button>
        </div>
      `}
      ${isPlaceholder && html`
        <div className="mb-2 text-xs text-amber-500 border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2">
          Placeholder string: <code className="font-mono">${value}</code> · upload a real asset to replace.
        </div>
      `}
      <div className="flex items-center gap-2">
        <input
          ref=${fileInput}
          type="file"
          accept=${def.kinds && def.kinds.includes('image') ? 'image/*' : undefined}
          onChange=${onFile}
          className="text-xs text-zinc-400 file:mr-3 file:px-3 file:py-1.5 file:text-xs file:border file:border-zinc-800 file:bg-zinc-900 file:text-zinc-200 file:hover:bg-zinc-800 file:rounded file:cursor-pointer file:transition"
        />
        ${uploading && html`<span className="text-xs text-zinc-500">uploading…</span>`}
      </div>
      ${error && html`<p className="text-xs text-red-400 mt-1">${error}</p>`}
    </${FieldShell}>
  `;
}

function ReferencesField({ name, def, value }) {
  const arr = Array.isArray(value) ? value : [];
  return html`
    <${FieldShell} name=${name} def=${def} hint=${`References to ${def.to.join(', ')} (read-only in v1)`}>
      ${arr.length === 0
        ? html`<div className="text-xs text-zinc-500">none</div>`
        : html`<ul className="text-xs font-mono space-y-1">
            ${arr.map((id, i) => html`<li key=${i} className="text-zinc-400">${String(id)}</li>`)}
          </ul>`}
    </${FieldShell}>
  `;
}

function ArrayOfStringField({ name, def, value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const [pending, setPending] = useState('');

  function add() {
    const v = pending.trim();
    if (!v) return;
    onChange([...arr, v]);
    setPending('');
  }

  return html`
    <${FieldShell} name=${name} def=${def}>
      <div className="flex flex-wrap gap-1 mb-2">
        ${arr.map((v, i) => html`
          <span key=${i} className="inline-flex items-center gap-1 text-xs bg-zinc-900 border border-zinc-800 rounded-full px-2 py-1">
            ${v}
            <button
              type="button"
              onClick=${() => onChange(arr.filter((_, j) => j !== i))}
              className="text-zinc-500 hover:text-red-400"
            >×</button>
          </span>
        `)}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          className=${inputClass}
          value=${pending}
          onChange=${(e) => setPending(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="add tag and press enter"
        />
        <button
          type="button"
          onClick=${add}
          className="text-xs px-3 py-1 border border-zinc-800 hover:border-zinc-600 rounded text-zinc-400"
        >add</button>
      </div>
    </${FieldShell}>
  `;
}

function FallbackField({ name, def, value }) {
  return html`
    <${FieldShell} name=${name} def=${def} hint=${`Field type "${def.type}" — read-only in this admin UI for now.`}>
      <pre className="text-xs bg-zinc-900 border border-zinc-800 rounded p-3 overflow-auto">${JSON.stringify(value, null, 2)}</pre>
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
    case 'array':
      if (def.of && def.of.type === 'string') return html`<${ArrayOfStringField} ...${props} />`;
      return html`<${FallbackField} ...${props} />`;
    default:
      return html`<${FallbackField} ...${props} />`;
  }
}
