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

// Pull the basename from where index.html was loaded — usually /admin, but
// supports custom mount paths configured on the HTTP server.
function detectBasename() {
  const p = window.location.pathname;
  const ix = p.indexOf('/types');
  if (ix > 0) return p.slice(0, ix);
  // strip a trailing index.html if present
  const trimmed = p.replace(/\/index\.html$/, '');
  return trimmed.length > 0 && trimmed !== '/' ? trimmed : '/admin';
}

function Layout({ children }) {
  return html`
    <div className="min-h-screen flex flex-col">
      <nav className="px-6 py-4 border-b border-zinc-800 flex items-baseline gap-6">
        <span className="font-semibold tracking-widest text-zinc-400">LEDRIC · ADMIN</span>
        <${Link} to="/types" className="text-sm text-zinc-400 hover:text-zinc-100 transition">Types</${Link}>
        <span className="ml-auto text-xs text-zinc-600">connected to <code className="text-zinc-400">${window.location.host}</code></span>
      </nav>
      <main className="flex-1 px-6 py-8 max-w-6xl w-full mx-auto">${children}</main>
      <footer className="px-6 py-4 border-t border-zinc-800 text-xs text-zinc-600">
        No auth yet — assumes a trusted local network. <a className="text-zinc-400 hover:text-amber-400" href="/" target="_blank">API root</a>
      </footer>
    </div>
  `;
}

function App() {
  return html`
    <${BrowserRouter} basename=${detectBasename()}>
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
    </${BrowserRouter}>
  `;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(html`<${App} />`);
}
