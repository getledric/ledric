// ledric inline editor loader.
//
// Drop this on any page rendered against a ledric backend:
//   <script src="https://my-ledric/admin/inline.js" defer></script>
//
// It walks the DOM for [data-ledric-ref="type/slug"] (optionally with
// data-ledric-field="..."), shows a floating pencil on hover, and opens
// the admin drawer in an iframe. On save the page reloads so the updated
// published content is visible.
//
// The companion helper `refAttrs(entry, field?)` in @ledric/sdk and the
// PHP client makes it cheap for the renderer to drop these attributes
// onto the right elements.

(function () {
  if (window.__ledricInlineLoaded) return;
  window.__ledricInlineLoaded = true;

  const script = document.currentScript;
  if (!script) return;
  const scriptUrl = new URL(script.src, location.href);
  const apiBase = scriptUrl.origin;
  // /admin/inline.js → mount path '/admin' (host server might be mounted
  // at /something-else, so we derive instead of hardcoding).
  const mountPath = scriptUrl.pathname.replace(/\/inline\.js.*$/, '') || '/admin';

  const PENCIL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.189 6.25 9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.286-6.286Z"/></svg>';

  const seen = new WeakSet();
  let pencil = null;
  let activeEl = null;
  let hoverTimer = null;
  let drawer = null;

  // ---- pencil affordance -------------------------------------------------

  function ensurePencil() {
    if (pencil) return pencil;
    pencil = document.createElement('button');
    pencil.type = 'button';
    pencil.setAttribute('aria-label', 'Edit with ledric');
    pencil.innerHTML = PENCIL_ICON;
    Object.assign(pencil.style, {
      position: 'fixed',
      zIndex: '2147483645',
      width: '28px',
      height: '28px',
      borderRadius: '6px',
      background: '#f59e0b',
      color: '#18181b',
      border: 'none',
      cursor: 'pointer',
      padding: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      lineHeight: '0',
      transition: 'transform 0.1s ease'
    });
    pencil.addEventListener('mouseenter', () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      pencil.style.transform = 'scale(1.1)';
    });
    pencil.addEventListener('mouseleave', () => {
      pencil.style.transform = 'scale(1)';
      scheduleHide();
    });
    pencil.addEventListener('click', onPencilClick);
    document.body.appendChild(pencil);
    return pencil;
  }

  function positionPencil(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      pencil.style.display = 'none';
      return;
    }
    const top = Math.max(4, rect.top + 4);
    const left = Math.min(window.innerWidth - 32, rect.right - 32);
    pencil.style.top = top + 'px';
    pencil.style.left = left + 'px';
    pencil.style.display = 'flex';
  }

  function scheduleHide() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (pencil) pencil.style.display = 'none';
      activeEl = null;
    }, 250);
  }

  function onMouseEnter(e) {
    activeEl = e.currentTarget;
    if (hoverTimer) clearTimeout(hoverTimer);
    ensurePencil();
    positionPencil(activeEl);
  }

  function onMouseLeave() {
    scheduleHide();
  }

  function onPencilClick() {
    if (!activeEl) return;
    const ref = activeEl.getAttribute('data-ledric-ref');
    if (!ref || ref.indexOf('/') === -1) return;
    const field = activeEl.getAttribute('data-ledric-field') || '';
    openDrawer(ref, field);
    if (pencil) pencil.style.display = 'none';
  }

  // ---- drawer (iframe) ---------------------------------------------------

  function createDrawer() {
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.5)',
      opacity: '0',
      pointerEvents: 'none',
      transition: 'opacity 0.2s ease',
      zIndex: '2147483646'
    });
    backdrop.addEventListener('click', closeDrawer);

    const container = document.createElement('div');
    Object.assign(container.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      width: 'min(560px, 100vw)',
      height: '100vh',
      background: '#09090b',
      transform: 'translateX(100%)',
      transition: 'transform 0.25s ease',
      zIndex: '2147483647',
      boxShadow: '-8px 0 24px rgba(0,0,0,0.5)',
      colorScheme: 'dark'
    });

    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, {
      width: '100%',
      height: '100%',
      border: '0',
      display: 'block'
    });
    container.appendChild(iframe);
    document.body.appendChild(backdrop);
    document.body.appendChild(container);

    window.addEventListener('message', (e) => {
      if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
      const data = e.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ledric:close') {
        closeDrawer();
      } else if (data.type === 'ledric:saved') {
        closeDrawer();
        // Reload so the rendered page picks up the freshly published version.
        // We delay slightly so the close transition is visible.
        setTimeout(() => location.reload(), 200);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer && drawer.isOpen) closeDrawer();
    });

    return { iframe, container, backdrop, isOpen: false };
  }

  function openDrawer(ref, field) {
    if (!drawer) drawer = createDrawer();
    const params = new URLSearchParams();
    if (field) params.set('field', field);
    const qs = params.toString() ? '?' + params.toString() : '';
    drawer.iframe.src = apiBase + mountPath + '/inline/' + ref + qs;
    drawer.container.style.transform = 'translateX(0)';
    drawer.backdrop.style.opacity = '1';
    drawer.backdrop.style.pointerEvents = 'auto';
    drawer.isOpen = true;
  }

  function closeDrawer() {
    if (!drawer || !drawer.isOpen) return;
    drawer.container.style.transform = 'translateX(100%)';
    drawer.backdrop.style.opacity = '0';
    drawer.backdrop.style.pointerEvents = 'none';
    drawer.isOpen = false;
    // Clear the iframe after the transition so it stops doing work.
    setTimeout(() => {
      if (drawer && !drawer.isOpen) drawer.iframe.src = 'about:blank';
    }, 300);
  }

  // ---- discovery ---------------------------------------------------------

  function attach(el) {
    if (seen.has(el)) return;
    seen.add(el);
    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mouseleave', onMouseLeave);
  }

  function scan(root) {
    const nodes = (root || document).querySelectorAll('[data-ledric-ref]');
    for (let i = 0; i < nodes.length; i++) attach(nodes[i]);
  }

  let mutTimer = null;
  function onMutation(mutations) {
    let dirty = false;
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type === 'childList' && m.addedNodes.length > 0) { dirty = true; break; }
      if (m.type === 'attributes' && m.attributeName === 'data-ledric-ref') { dirty = true; break; }
    }
    if (!dirty) return;
    if (mutTimer) clearTimeout(mutTimer);
    mutTimer = setTimeout(() => scan(document), 150);
  }

  // ---- preview toggle ----------------------------------------------------
  // Visible only when the host page sets `window.LEDRIC_PREVIEW_AVAILABLE`
  // = true (the admin user's renderer opts in). State comes from
  // `window.LEDRIC_PREVIEW`. Click POSTs to `<mountPath>/preview-toggle`
  // and reloads — Laravel's package handles that route by toggling a
  // cookie. Standalone ledric installs ignore both globals (nothing is
  // emitted), so this is a no-op outside the proxy setup.

  function ensurePreviewToggle() {
    if (!window.LEDRIC_PREVIEW_AVAILABLE) return;
    if (document.getElementById('ledric-preview-toggle')) return;

    const active = window.LEDRIC_PREVIEW === true;
    const btn = document.createElement('button');
    btn.id = 'ledric-preview-toggle';
    btn.type = 'button';
    btn.textContent = active ? 'Preview: ON' : 'Preview: OFF';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483645',
      padding: '8px 14px',
      borderRadius: '999px',
      border: 'none',
      background: active ? '#f59e0b' : '#3f3f46',
      color: active ? '#18181b' : '#fafafa',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px',
      fontWeight: '600',
      cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      transition: 'transform 0.1s ease'
    });
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.05)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.style.opacity = '0.7';
      try {
        // Match api.js's CSRF passthrough: when the host app sets an
        // XSRF-TOKEN cookie (Laravel's `web` middleware does this),
        // forward it as X-XSRF-TOKEN. Reload on 419 so a stale token
        // self-heals the same way it does for the admin GUI.
        const xsrfMatch = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
        const headers = {};
        if (xsrfMatch) {
          try { headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrfMatch[1]); } catch { /* ignore */ }
        }
        const res = await fetch(apiBase + mountPath + '/preview-toggle', {
          method: 'POST',
          credentials: 'same-origin',
          headers
        });
        if (res.ok) {
          location.reload();
          return;
        }
        if (res.status === 419) {
          location.reload();
          return;
        }
      } catch { /* fall through */ }
      btn.disabled = false;
      btn.style.opacity = '1';
    });

    if (active) {
      // Thin top banner so it's hard to forget you're looking at drafts.
      const banner = document.createElement('div');
      banner.id = 'ledric-preview-banner';
      Object.assign(banner.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        height: '3px',
        background: '#f59e0b',
        zIndex: '2147483645',
        pointerEvents: 'none'
      });
      document.body.appendChild(banner);
    }

    document.body.appendChild(btn);
  }

  function init() {
    scan(document);
    ensurePreviewToggle();
    const mo = new MutationObserver(onMutation);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ledric-ref']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
