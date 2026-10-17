import { AniListClient } from './anilistAdapter';
import { gmKV, gmTransport } from './gm';
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
  const anilist = new AniListClient(withRetry(gmTransport, { retries: 2 }));
  let session: Session | null = null;

  const load = (s: Session, force: boolean) => {
    s.ctrl.abort();
    s.ctrl = new AbortController();
    const ctx = { signal: s.ctrl.signal, cache, force };
    s.view.set({ status: 'loading' });
    buildWatchOrder(s.key, { adapter, anilist, user, ctx })
      .then((result) => {
        if (session === s && !ctx.signal.aborted) s.view.set({ status: 'ready', result });
      })
      .catch((e: unknown) => {
        if (isAbort(e) || session !== s) return;
        console.warn('[animelib-watch-order]', e);
        s.view.set({ status: 'error', message: e instanceof Error ? e.message : 'ошибка загрузки' });
      });
  };

  /** Ровно один блок, в нужном месте; на других вкладках тайтла блок убирается. */
  const mount = () => {
    for (const other of document.querySelectorAll('[data-awo]')) {
      if (other !== session?.view.root) other.remove();
    }
    if (!session) return;
    const root = session.view.root;
    const anchor = adapter.findAnchor(document);
    if (!anchor) {
      root.remove();
      return;
    }
    if (root.parentElement === anchor.parent && root.nextElementSibling === anchor.before) return;
    anchor.parent.insertBefore(root, anchor.before);
  };

  watchRoute((url) => {
    const key = adapter.pageKey(url);
    if (session?.key === key) return;
    session?.ctrl.abort();
    session?.view.root.remove();
    session = null;
    if (!key) return;
    const s: Session = {
      key,
      ctrl: new AbortController(),
      view: new WatchOrderView(adapter, user, {
        refresh: () => load(s, true),
        rejectMatch: (pair) => {
          user.reject(pair);
          load(s, false);
        },
      }),
    };
    session = s;
    mount();
    load(s, false);
  });
  watchDom(mount);
}

const host = location.hostname;
const transport = withRetry(fetchTransport, { retries: 2 });
if (/(^|\.)animelib\.org$/.test(host)) start(createAnimeLib(transport));
else if (/(^|\.)animego\.[a-z]+$/.test(host)) start(createAnimego(transport));
