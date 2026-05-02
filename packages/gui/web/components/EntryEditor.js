import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { html } from 'htm/react';
import { api } from '../lib/api.js';
import { FieldRenderer } from './fields.js';
import { TagChips } from './TagChips.js';

export function EntryEditor({ mode }) {
  const { type, slug } = useParams();
  const navigate = useNavigate();
  const [typeDef, setTypeDef] = useState(null);
  const [content, setContent] = useState({});
  const [parentVersion, setParentVersion] = useState(null);
  const [publishedVersion, setPublishedVersion] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState(null);
  const [tags, setTags] = useState([]);
  const [allTags, setAllTags] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInfo(null);
    (async () => {
      try {
        const t = await api.type(type);
        if (cancelled) return;
        setTypeDef(t);

        const allTagsData = await api.tags();
        if (cancelled) return;
        setAllTags(allTagsData ?? []);

        if (mode === 'edit') {
          const entry = await api.read(type, slug);
          if (cancelled) return;
          if (!entry) {
            setError(new Error(`No entry "${type}/${slug}".`));
            return;
          }
          setContent(entry.fields ?? {});
          setParentVersion(entry.version);
          setPublishedVersion(typeof entry.published_version === 'number' ? entry.published_version : null);
          setTags(entry.tags ?? []);
        } else {
          // initialise from the type's example if there is one
          setContent(t && t.example ? { ...t.example } : {});
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, slug, mode]);

  function setField(name, value) {
    setContent((prev) => {
      const next = { ...prev };
      if (value === undefined) {
        delete next[name];
      } else {
        next[name] = value;
      }
      return next;
    });
  }

  async function save() {
    if (!typeDef) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      const args = { type, fields: content };
      if (mode === 'edit') {
        args.ref = { type, slug };
        args.parent_version = parentVersion;
      }
      const result = await api.rpc('draft', args);
      setInfo(`Saved · v${result.version}`);
      setParentVersion(result.version);
      if (mode === 'new' && result.slug) {
        navigate(`/types/${type}/${result.slug}`, { replace: true });
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  async function addTag(label) {
    try {
      const result = await api.addEntryTags(type, slug, [label]);
      // returns TagInfo[] — full updated tag list for the entry
      setTags(result ?? []);
      setAllTags((prev) => {
        const slugs = new Set(prev.map((t) => t.slug));
        const newOnes = (result ?? []).filter((t) => !slugs.has(t.slug));
        return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
      });
    } catch (e) {
      setError(e);
    }
  }

  async function removeTag(tagSlug) {
    try {
      await api.removeEntryTags(type, slug, [tagSlug]);
      setTags((prev) => prev.filter((t) => t.slug !== tagSlug));
    } catch (e) {
      setError(e);
    }
  }

  async function publish() {
    if (!parentVersion) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      const result = await api.rpc('publish', {
        ref: { type, slug }
      });
      setPublishedVersion(result.published_version);
      setInfo(`Published · v${result.published_version}`);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return html`<div className="text-zinc-500">loading…</div>`;
  }
  if (error && !typeDef) {
    return html`<div className="text-red-700 border border-red-200 rounded p-4">${error.message}</div>`;
  }
  if (!typeDef) return null;

  const isPublished = mode === 'edit' && publishedVersion === parentVersion;
  const hasUnpublished = mode === 'edit' && publishedVersion !== null && publishedVersion !== parentVersion;

  return html`
    <div className="max-w-3xl">
      <div className="flex items-baseline gap-3 mb-1">
        <${Link} to=${`/types/${type}`} className="text-sm text-zinc-500 hover:text-zinc-700">←</${Link}>
        <h1 className="text-2xl font-semibold">${mode === 'new' ? `New ${type}` : (content[typeDef.display_field ?? 'title'] || slug)}</h1>
      </div>
      <div className="text-xs text-zinc-500 tracking-widest uppercase mb-6">
        ${type}${mode === 'edit' && parentVersion ? ` · v${parentVersion}` : ''}
        ${publishedVersion !== null ? ` · published v${publishedVersion}` : ''}
        ${hasUnpublished && html`<span className="ml-2 text-amber-600 normal-case tracking-normal">unpublished changes</span>`}
        ${isPublished && html`<span className="ml-2 text-green-600 normal-case tracking-normal">live</span>`}
      </div>

      ${info && html`<div className="text-sm text-green-700 border border-green-200 bg-green-50 rounded px-3 py-2 mb-4">${info}</div>`}
      ${error && html`<div className="text-sm text-red-700 border border-red-200 bg-red-50 rounded px-3 py-2 mb-4">${error.message}</div>`}

      <form
        onSubmit=${(e) => {
          e.preventDefault();
          save();
        }}
      >
        ${Object.entries(typeDef.fields).map(([name, def]) =>
          html`<${FieldRenderer}
            key=${name}
            name=${name}
            def=${def}
            value=${content[name]}
            content=${content}
            onChange=${(v) => setField(name, v)}
          />`
        )}

        ${mode === 'edit' && html`
          <div className="mb-6">
            <label className="block text-xs text-zinc-500 uppercase tracking-widest mb-2">Tags</label>
            <${TagChips}
              tags=${tags}
              allTags=${allTags}
              onAdd=${addTag}
              onRemove=${removeTag}
              disabled=${saving}
            />
          </div>
        `}

        <div className="flex items-center gap-3 pt-4 border-t border-zinc-200">
          <button
            type="submit"
            disabled=${saving}
            className="bg-amber-500 disabled:bg-zinc-300 disabled:text-zinc-500 text-zinc-950 hover:bg-amber-400 transition px-4 py-2 rounded text-sm font-medium"
          >${saving ? 'saving…' : (mode === 'new' ? 'create draft' : 'save draft')}</button>
          ${mode === 'edit' && html`
            <button
              type="button"
              onClick=${publish}
              disabled=${saving || isPublished}
              className="border border-zinc-200 disabled:text-zinc-400 hover:border-zinc-400 transition px-4 py-2 rounded text-sm text-zinc-800"
            >${isPublished ? 'published' : 'publish'}</button>
          `}
        </div>
      </form>
    </div>
  `;
}
