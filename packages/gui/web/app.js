import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  Navigate
} from 'react-router-dom';
import { html } from 'htm/react';

import { TypeList } from './components/TypeList.js';
import { EntryList } from './components/EntryList.js';
import { EntryEditor } from './components/EntryEditor.js';
import { InlineDrawer } from './components/InlineDrawer.js';
import { AuthGate } from './components/AuthGate.js';
import { auth } from './lib/api.js';

// The HTTP server injects <base href="/admin/"> into every served HTML
// response under the mount path, so the most reliable way to find our
// basename is to read it. Fall back to a path heuristic for the rare
// case where the base tag isn't present.
function detectBasename() {
  const baseEl = document.querySelector('base[href]');
  if (baseEl && baseEl.href) {
    try {
      const url = new URL(baseEl.href, window.location.origin);
      const trimmed = url.pathname.replace(/\/$/, '');
      return trimmed.length > 0 ? trimmed : '/';
    } catch {
      /* fall through */
    }
  }
  const p = window.location.pathname;
  for (const marker of ['/types', '/inline']) {
    const ix = p.indexOf(marker);
    if (ix > 0) return p.slice(0, ix);
  }
  const trimmed = p.replace(/\/index\.html$/, '');
  return trimmed.length > 0 && trimmed !== '/' ? trimmed : '/admin';
}

function Layout({ children }) {
  function signOut() {
    if (!confirm('Clear the stored admin key? You\'ll need to paste it again.')) return;
    auth.clear();
    window.location.reload();
  }
  const hasKey = Boolean(auth.key);
  return html`
    <div className="min-h-screen flex flex-col">
      <nav className="px-6 py-4 border-b border-zinc-800 flex items-baseline gap-6">
        <span className="font-semibold tracking-widest text-zinc-400">LEDRIC · ADMIN</span>
        <${Link} to="/types" className="text-sm text-zinc-400 hover:text-zinc-100 transition">Types</${Link}>
        <span className="ml-auto flex items-baseline gap-3 text-xs text-zinc-600">
          <span>connected to <code className="text-zinc-400">${window.location.host}</code></span>
          ${hasKey && html`
            <button
              type="button"
              onClick=${signOut}
              className="text-zinc-500 hover:text-amber-400 transition"
              title="Clear stored admin key"
            >sign out</button>
          `}
        </span>
      </nav>
      <main className="flex-1 px-6 py-8 max-w-6xl w-full mx-auto">${children}</main>
      <footer className="px-6 py-4 border-t border-zinc-800 text-xs text-zinc-600">
        ${hasKey
          ? html`Authenticated. Key stored in this browser. <a className="text-zinc-400 hover:text-amber-400" href="/" target="_blank">API root</a>`
          : html`Auth-off mode (no admin key required). <a className="text-zinc-400 hover:text-amber-400" href="/" target="_blank">API root</a>`}
      </footer>
    </div>
  `;
}

function FullApp() {
  return html`
    <${Layout}>
      <${Routes}>
        <${Route} path="/" element=${html`<${Navigate} to="/types" replace />`} />
        <${Route} path="/types" element=${html`<${TypeList} />`} />
        <${Route} path="/types/:type" element=${html`<${EntryList} />`} />
        <${Route} path="/types/:type/new" element=${html`<${EntryEditor} mode="new" />`} />
        <${Route} path="/types/:type/:slug" element=${html`<${EntryEditor} mode="edit" />`} />
        <${Route} path="*" element=${html`<div className="text-zinc-500">Not found.</div>`} />
      </${Routes}>
    </${Layout}>
  `;
}

function App() {
  return html`
    <${AuthGate}>
      <${BrowserRouter} basename=${detectBasename()}>
        <${Routes}>
          <${Route} path="/inline/:type/:slug" element=${html`<${InlineDrawer} />`} />
          <${Route} path="/*" element=${html`<${FullApp} />`} />
        </${Routes}>
      </${BrowserRouter}>
    </${AuthGate}>
  `;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(html`<${App} />`);
}
