import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { html } from 'htm/react';
import { api } from '../lib/api.js';
import { FieldRenderer } from './fields.js';

// Drawer-shaped editor served at /admin/inline/:type/:slug.
//
// Loaded inside an iframe by /admin/inline.js. Talks back to the host
// page via postMessage:
//   { type: 'ledric:close' }   — user dismissed
//   { type: 'ledric:saved' }   — successfully drafted + published
//
// Save flow: the user edits whatever is rendered, hits save, and we
// draft + publish in one shot. If publish fails validation we keep the
// drawer dirty (the user can fix the error and try again) and we DON'T
// silently leave a stranded draft behind — well, we do the draft, then
// the publish, and if publish fails the draft is still there. That's
// fine: next save call drafts on top of it (parent_version updated).

function postToParent(message) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, '*');
  }
}

export function InlineDrawer() {
  const { type, slug } = useParams();
  const [searchParams] = useSearchParams();
  const focusField = searchParams.get('field');

  const [typeDef, setTypeDef] = useState(null);
  const [content, setContent] = useState({});
  const [parentVersion, setParentVersion] = useState(null);
  const [publishedVersion, setPublishedVersion] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Initial load: type definition + current entry (latest, including any
  // draft).  If a draft exists we show that — matches the user's intent
  // that we never accidentally create a *second* draft alongside one
  // that's already in flight.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const t = await api.type(type);
        if (cancelled) return;
        if (!t) {
          setError(new Error(`Unknown type "${type}".`));
          return;
        }
        setTypeDef(t);
        const entry = await api.read(type, slug);
        if (cancelled) return;
        if (!entry) {
          setError(new Error(`No entry "${type}/${slug}". The renderer may be referencing content that no longer exists.`));
          return;
        }
        setContent(entry.fields ?? {});
        setParentVersion(entry.version);
        setPublishedVersion(
          typeof entry.published_version === 'number' ? entry.published_version : null
        );
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, slug]);

  // Scroll/focus the named field once everything has rendered.
  useEffect(() => {
    if (loading || !focusField) return;
    const r = requestAnimationFrame(() => {
      const shell = document.querySelector(`[data-ledric-field-shell="${focusField}"]`);
      if (!shell) return;
      shell.scrollIntoView({ block: 'center', behavior: 'auto' });
      const input = shell.querySelector('input, textarea, select');
      if (input && typeof input.focus === 'function') input.focus();
    });
    return () => cancelAnimationFrame(r);
  }, [loading, focusField]);

  function setField(name, value) {
    setContent((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
  }

  function close() {
    postToParent({ type: 'ledric:close' });
  }

  async function save() {
    if (!typeDef || saving) return;
    setSaving(true);
    setError(null);
    try {
      const drafted = await api.rpc('draft', {
        type,
        fields: content,
        ref: { type, slug },
        parent_version: parentVersion
      });
      // Publish what we just drafted. If validation fails here, the
      // draft is left in place — same behaviour as the full /admin
      // editor, and on retry the user's edits aren't lost.
      const published = await api.rpc('publish', {
        ref: { type, slug },
        version: drafted.version
      });
      setParentVersion(drafted.version);
      setPublishedVersion(published.published_version);
      postToParent({ type: 'ledric:saved', version: published.published_version });
    } catch (e) {
      setError(e);
      // Refresh parent_version so a retry has a chance — covers the
      // VERSION_CONFLICT case where someone else drafted concurrently.
      try {
        const fresh = await api.read(type, slug);
        if (fresh) setParentVersion(fresh.version);
      } catch {
        /* ignore */
      }
    } finally {
      setSaving(false);
    }
  }

  const headerTitle =
    typeDef && content[typeDef.display_field ?? 'title']
      ? String(content[typeDef.display_field ?? 'title'])
      : slug;

  const formatError = (e) => {
    if (!e) return null;
    if (e.error && Array.isArray(e.error.errors) && e.error.errors.length > 0) {
      return e.error.errors
        .map((err) => `${err.path}: ${err.message}`)
        .join(' · ');
    }
    return e.message ?? String(e);
  };

  return html`
    <div className="flex flex-col h-screen bg-zinc-50 text-zinc-900">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-zinc-200 shrink-0">
        <span className="text-xs uppercase tracking-widest text-zinc-500">${type}</span>
        <span className="text-sm font-medium truncate flex-1">${headerTitle}</span>
        <button
          type="button"
          onClick=${close}
          aria-label="Close"
          className="text-zinc-500 hover:text-zinc-900 px-2 py-1 rounded transition"
        >✕</button>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        ${loading && html`<div className="text-zinc-500 text-sm">loading…</div>`}
        ${!loading && error && !typeDef && html`
          <div className="text-sm text-red-700 border border-red-200 bg-red-50 rounded px-3 py-2">
            ${formatError(error)}
          </div>`}
        ${!loading && typeDef && html`
          <form
            onSubmit=${(e) => {
              e.preventDefault();
              save();
            }}
          >
            ${Object.entries(typeDef.fields).map(([name, def]) => html`
              <div key=${name} data-ledric-field-shell=${name}>
                <${FieldRenderer}
                  name=${name}
                  def=${def}
                  value=${content[name]}
                  content=${content}
                  onChange=${(v) => setField(name, v)}
                />
              </div>
            `)}
            <button type="submit" hidden></button>
          </form>
        `}
      </main>

      ${typeDef && html`
        <footer className="border-t border-zinc-200 px-4 py-3 shrink-0 space-y-2">
          ${error && html`
            <div className="text-xs text-red-700 border border-red-200 bg-red-50 rounded px-3 py-2">
              ${formatError(error)}
            </div>`}
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>v${parentVersion ?? '?'}</span>
            ${publishedVersion !== null && parentVersion === publishedVersion && html`
              <span className="text-green-600">live</span>`}
            ${publishedVersion !== null && parentVersion !== publishedVersion && html`
              <span className="text-amber-600">unpublished draft</span>`}
            <div className="flex-1"></div>
            <button
              type="button"
              onClick=${close}
              disabled=${saving}
              className="px-3 py-1.5 text-zinc-700 hover:text-zinc-900 transition"
            >cancel</button>
            <button
              type="button"
              onClick=${save}
              disabled=${saving}
              className="bg-amber-500 disabled:bg-zinc-300 disabled:text-zinc-500 text-zinc-950 hover:bg-amber-400 transition px-4 py-1.5 rounded text-sm font-medium"
            >${saving ? 'saving…' : 'save & publish'}</button>
          </div>
        </footer>
      `}
    </div>
  `;
}
