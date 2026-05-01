import { useRef, useState } from 'react';
import { html } from 'htm/react';

function normalize(s) {
  return s.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
}

export function TagChips({ tags = [], onAdd, onRemove, allTags = [], disabled = false }) {
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  const term = normalize(input).toLowerCase();
  const existingSlugs = new Set(tags.map((t) => t.slug));

  const candidates = allTags
    .filter(
      (t) =>
        !existingSlugs.has(t.slug) &&
        (term === '' || t.label.toLowerCase().includes(term) || t.slug.includes(term))
    )
    .slice(0, 8);

  function commit() {
    const val = normalize(input);
    if (val) {
      onAdd(val);
      setInput('');
    }
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      setInput('');
      setOpen(false);
    }
  }

  function pick(label) {
    onAdd(label);
    setInput('');
    setOpen(false);
    inputRef.current?.focus();
  }

  return html`
    <div className="flex flex-wrap gap-1.5 items-center min-h-[1.75rem]">
      ${tags.map(
        (t) => html`
          <span
            key=${t.slug}
            className="inline-flex items-center gap-1 bg-zinc-800 text-zinc-200 text-xs px-2 py-0.5 rounded-full border border-zinc-700"
          >
            ${t.label}
            ${!disabled &&
            html`<button
              type="button"
              onClick=${() => onRemove(t.slug)}
              className="text-zinc-500 hover:text-zinc-200 leading-none ml-0.5"
            >×</button>`}
          </span>
        `
      )}
      ${!disabled &&
      html`<div className="relative">
        <input
          ref=${inputRef}
          type="text"
          value=${input}
          placeholder="add tag…"
          onInput=${(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus=${() => setOpen(true)}
          onBlur=${() => setTimeout(() => setOpen(false), 150)}
          onKeyDown=${handleKeyDown}
          className="bg-transparent text-xs text-zinc-300 placeholder-zinc-600 border-b border-zinc-700 focus:border-amber-500 outline-none w-28 py-0.5"
        />
        ${open &&
        candidates.length > 0 &&
        html`<div className="absolute left-0 top-full mt-1 z-50 bg-zinc-900 border border-zinc-700 rounded shadow-lg min-w-max">
          ${candidates.map(
            (t) => html`
              <button
                key=${t.slug}
                type="button"
                onMouseDown=${() => pick(t.label)}
                className="block w-full text-left text-xs px-3 py-1.5 text-zinc-300 hover:bg-zinc-800"
              >${t.label}</button>
            `
          )}
        </div>`}
      </div>`}
    </div>
  `;
}
