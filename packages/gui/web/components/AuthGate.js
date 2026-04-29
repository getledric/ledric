import { useEffect, useState } from 'react';
import { html } from 'htm/react';
import { auth, onUnauthorized } from '../lib/api.js';

// Gates the rest of the SPA (and the inline drawer) behind a paste-
// your-admin-key prompt when the server has auth turned on.
//
// Flow:
//   1. On mount, hit /auth/status. If required:false → render children.
//   2. Required:true and a key is in localStorage → render children.
//   3. Required:true and no key → render the paste prompt.
//   4. Any 401 from a subsequent API call clears the key and re-shows
//      the prompt (subscribed via onUnauthorized).
export function AuthGate({ children }) {
  const [state, setState] = useState({ kind: 'loading' });

  // Initial probe + 401 subscription.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await auth.status();
      if (cancelled) return;
      if (!status.required) {
        setState({ kind: 'open' });
        return;
      }
      setState(auth.key ? { kind: 'authed' } : { kind: 'prompt' });
    })();
    const off = onUnauthorized(() => {
      if (cancelled) return;
      setState({ kind: 'prompt', error: 'Your key was rejected. Paste a fresh one.' });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (state.kind === 'loading') {
    return html`<div className="min-h-screen flex items-center justify-center text-zinc-600 text-sm">checking auth…</div>`;
  }
  if (state.kind === 'prompt') {
    return html`<${KeyPrompt}
      error=${state.error ?? null}
      onSave=${(secret) => {
        auth.set(secret);
        setState({ kind: 'authed' });
      }}
    />`;
  }
  return children;
}

function KeyPrompt({ error, onSave }) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const looksOk = /^lka_[A-Za-z0-9_-]{16,}$/.test(trimmed);

  function submit(e) {
    e.preventDefault();
    if (!looksOk) return;
    onSave(trimmed);
  }

  return html`
    <div className="min-h-screen flex items-center justify-center px-6 bg-zinc-950 text-zinc-100">
      <form onSubmit=${submit} className="w-full max-w-md space-y-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">ledric admin</h1>
          <p className="text-sm text-zinc-500">
            This server has auth turned on. Paste an admin key to continue.
          </p>
        </div>
        <div className="space-y-2">
          <label className="block text-xs uppercase tracking-widest text-zinc-500">
            admin key
          </label>
          <input
            type="password"
            autoFocus
            spellCheck=${false}
            autoComplete="off"
            value=${value}
            onChange=${(e) => setValue(e.target.value)}
            placeholder="lka_…"
            className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-600 outline-none rounded px-3 py-2 text-sm font-mono"
          />
        </div>
        ${error && html`
          <p className="text-xs text-red-400 border border-red-900/50 bg-red-950/20 rounded px-3 py-2">
            ${error}
          </p>`}
        <button
          type="submit"
          disabled=${!looksOk}
          className="w-full bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-950 hover:bg-amber-400 transition px-4 py-2 rounded text-sm font-medium"
        >save & continue</button>
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300">don't have a key?</summary>
          <pre className="bg-zinc-900 border border-zinc-800 rounded p-3 mt-2 overflow-auto text-zinc-300">ledric keys create --role admin --raw</pre>
          <p className="mt-2">
            Stored in your browser's localStorage. Sign out from the nav to clear it.
          </p>
        </details>
      </form>
    </div>
  `;
}
