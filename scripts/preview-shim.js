// Обвязка для ручной проверки без менеджера userscript (встроенное превью, консоль браузера).
// GM_* поверх localStorage; ссылки блока переходят через роутер сайта, чтобы скрипт не терялся.
(() => {
  if (window.__awoPreview) return;
  window.__awoPreview = true;
  const P = 'awo-preview:';
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(P + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => localStorage.setItem(P + k, JSON.stringify(v));
  window.GM_deleteValue = (k) => localStorage.removeItem(P + k);
  window.GM_xmlhttpRequest = (r) => {
    const c = new AbortController();
    fetch(r.url, { method: r.method, headers: r.headers, body: r.data, credentials: 'omit', signal: c.signal })
      .then(async (res) => r.onload({ status: res.status, responseText: await res.text(), responseHeaders: '' }))
      .catch((e) => r.onerror(e));
    return { abort: () => c.abort() };
  };
  document.addEventListener('click', (e) => {
    // блок в Shadow DOM: настоящую ссылку берём из composedPath
    const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement && n.href);
    if (!a || !e.composedPath().some((n) => n instanceof Element && n.hasAttribute('data-awo'))) return;
    if (a.origin !== location.origin || e.ctrlKey || e.metaKey || e.button !== 0) return;
    e.preventDefault();
    if (window.Turbo?.visit) return window.Turbo.visit(a.href);
    history.pushState(history.state, '', a.pathname + a.search);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    scrollTo(0, 0);
  }, true);
})();
