import { AniListClient } from './anilistAdapter';
import { gmKV, gmMenuCommand, gmTransport } from './gm';
import { fetchTransport, isAbort, withRetry } from './http';
import { createAnimego } from './sites/animego';
import { createAnimeLib } from './sites/animelib';
import type { SiteAdapter } from './sites/site';
import { watchDom, watchRoute } from './spaLifecycle';
import { Cache, UserState } from './storage';
import { WatchOrderView } from './ui';
import { buildWatchOrder } from './watchOrder';

interface Session {
  key: string;
  ctrl: AbortController;
  view: WatchOrderView;
}

function start(adapter: SiteAdapter) {
  const kv = gmKV();
  const cache = new Cache(kv);
  const user = new UserState(kv);
  const anilist = new AniListClient(withRetry(gmTransport, { retries: 2, rateLimit: { max: 25, windowMs: 60_000 } }));
  let session: Session | null = null;

  const load = (s: Session, force: boolean) => {
    if (hiddenHere()) return;
    s.ctrl.abort();
    s.ctrl = new AbortController();
    const ctx = { signal: s.ctrl.signal, cache, force };
    s.view.set({ status: 'loading' });
    // без общего таймаута блок молча висит, например пока менеджер ждёт разрешения на @connect
    const timer = setTimeout(() => {
      if (session !== s || ctx.signal.aborted) return;
      s.ctrl.abort();
      s.view.set({
        status: 'error',
        message: 'данные не пришли за 60 секунд. Проверьте, что менеджер скриптов разрешил доступ к graphql.anilist.co, и нажмите «Обновить».',
      });
    }, 60_000);
    buildWatchOrder(s.key, { adapter, anilist, user, ctx })
      .finally(() => clearTimeout(timer))
      .then((result) => {
        if (session === s && !ctx.signal.aborted) s.view.set({ status: 'ready', result });
      })
      .catch((e: unknown) => {
        if (isAbort(e) || ctx.signal.aborted || session !== s) return;
        console.warn('[animelib-watch-order]', e);
        s.view.set({ status: 'error', message: e instanceof Error ? e.message : 'ошибка загрузки' });
      });
  };

  const hiddenHere = () => user.prefs().hiddenSites[adapter.id] === true;

  /** Ровно один блок, в нужном месте; на других вкладках тайтла и на скрытом сайте блок убирается. */
  const mount = () => {
    for (const other of document.querySelectorAll('[data-awo]')) {
      if (other !== session?.view.root) other.remove();
    }
    if (!session) return;
    const root = session.view.root;
    const anchor = hiddenHere() ? null : adapter.findAnchor(document);
    if (!anchor) {
      root.remove();
      return;
    }
    if (root.parentElement !== anchor.parent || root.nextElementSibling !== anchor.before) {
      anchor.parent.insertBefore(root, anchor.before);
    }
    session.view.syncTheme();
  };

  const setHidden = (hidden: boolean) => {
    const sites = { ...user.prefs().hiddenSites };
    if (hidden) sites[adapter.id] = true;
    else delete sites[adapter.id];
    user.setPrefs({ hiddenSites: sites });
    if (hidden) {
      session?.ctrl.abort();
      session?.view.root.remove();
      session = null;
    } else route(new URL(location.href));
    mount();
  };
  gmMenuCommand('Показать/скрыть «Порядок просмотра» на этом сайте', () => setHidden(!hiddenHere()));

  const route = (url: URL) => {
    const key = adapter.pageKey(url);
    if (session?.key === key) return;
    session?.ctrl.abort();
    session?.view.root.remove();
    session = null;
    if (!key || hiddenHere()) return;
    const s: Session = {
      key,
      ctrl: new AbortController(),
      view: new WatchOrderView(user, {
        refresh: () => load(s, true),
        reload: () => load(s, false),
        hideOnSite: () => setHidden(true),
      }),
    };
    session = s;
    mount();
    load(s, false);
  };
  watchRoute(route);
  watchDom(mount);
}

// DOM общий даже для копий скрипта в разных песочницах менеджера.
const marker = 'data-awo-active';
if (document.documentElement.hasAttribute(marker)) {
  console.info('[animelib-watch-order] Скрипт уже запущен на этой странице.');
} else {
  document.documentElement.setAttribute(marker, 'true');
  const host = location.hostname;
  const transport = withRetry(fetchTransport, { retries: 2 });
  if (/(^|\.)animelib\.org$/.test(host)) start(createAnimeLib(transport));
  else if (/(^|\.)animego\.[a-z]+$/.test(host)) start(createAnimego(transport));
}
