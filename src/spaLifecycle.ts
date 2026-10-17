/**
 * Отслеживание SPA-переходов и перерисовок.
 * Маршрут сравнивается по pathname: параметры вроде ?ui= страницу тайтла не меняют.
 */
export function watchRoute(onRoute: (url: URL) => void): () => void {
  let last: string | undefined;
  const check = () => {
    if (location.pathname === last) return;
    last = location.pathname;
    onRoute(new URL(location.href));
  };
  const timer = setInterval(check, 400);
  window.addEventListener('popstate', check);
  document.addEventListener('turbo:load', check);
  check();
  return () => {
    clearInterval(timer);
    window.removeEventListener('popstate', check);
    document.removeEventListener('turbo:load', check);
  };
}

/** MutationObserver с debounce: зовёт cb после того, как DOM успокоился. */
export function watchDom(cb: () => void, delayMs = 150): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const obs = new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(cb, delayMs);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  return () => {
    clearTimeout(t);
    obs.disconnect();
  };
}
