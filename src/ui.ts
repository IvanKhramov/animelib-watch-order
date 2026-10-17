import { pairKey } from './matching';
import type { SiteAdapter } from './sites/site';
import type { UserState } from './storage';
import type { FuzzyDate, ItemKind, OrderItem, OrderResult } from './types';

export type View = 'main' | 'all';

export type UiState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: OrderResult };

export interface UiHandlers {
  refresh(): void;
  /** пользователь отклонил сопоставление: пересобрать без него */
  rejectMatch(pair: string): void;
}

const STYLE_ID = 'awo-style';
const CSS = `
.awo{margin:0 0 20px}
.awo-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.awo-ctl{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.awo-btn{font:inherit;font-size:12px;line-height:18px;padding:2px 10px;border-radius:6px;cursor:pointer;color:inherit;
  background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent)}
.awo-btn:hover,.awo-btn.is-active{background:color-mix(in srgb,currentColor 14%,transparent)}
.awo-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.awo-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;padding:6px 10px;border-radius:8px;
  background:color-mix(in srgb,currentColor 5%,transparent)}
.awo-row.is-current{background:color-mix(in srgb,currentColor 13%,transparent)}
.awo-row.is-current .awo-title{font-weight:600}
.awo-row.is-side{margin-left:18px}
.awo-mark{all:unset;cursor:pointer;width:1.2em;text-align:center;opacity:.8}
.awo-mark:hover{opacity:1}
.awo-num{min-width:1.6em;opacity:.6;font-variant-numeric:tabular-nums}
.awo-title{color:inherit;text-decoration:none;overflow-wrap:anywhere}
a.awo-title:hover{text-decoration:underline}
.awo-sub,.awo-meta{font-size:12px;opacity:.6}
.awo-warn{font-size:12px;color:#e0a030}
.awo-miss{font-size:12px;opacity:.75}
.awo-miss a{color:inherit}
.awo-link{all:unset;cursor:pointer;font-size:12px;text-decoration:underline;opacity:.7}
.awo-branches{margin-top:10px}
.awo-branches summary{cursor:pointer;opacity:.8}
.awo-notes{margin-top:8px;font-size:12px;opacity:.7}
.awo-state{margin-top:10px;opacity:.75}
`;

function ensureStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const KIND_LABEL: Record<ItemKind, string> = {
  main: '',
  extra: 'Дополнительно',
  recap: 'Пересказ',
  alternative: 'Альтернативная ветка',
  spinoff: 'Спин-офф',
  other: 'Другое',
};

const yearOf = (d: FuzzyDate | undefined) => (d?.year ? String(d.year) : undefined);

export class WatchOrderView {
  readonly root: HTMLElement;
  private view: View = 'all';
  private state: UiState = { status: 'loading' };

  constructor(
    private readonly adapter: SiteAdapter,
    private readonly user: UserState,
    private readonly handlers: UiHandlers,
  ) {
    ensureStyle(document);
    this.root = el('section', 'awo');
    this.root.dataset.awo = '1';
    this.render();
  }

  set(state: UiState) {
    this.state = state;
    this.render();
  }

  private render() {
    const r = this.root;
    r.replaceChildren();
    const heading = el('div', 'awo-heading', 'Порядок просмотра');
    const head = el('div', 'awo-head');
    head.append(heading);
    const ctl = el('div', 'awo-ctl');
    const ready = this.state.status === 'ready' ? this.state.result : undefined;
    if (ready?.mode === 'anilist') {
      for (const [v, label] of [['main', 'Основное'], ['all', 'Всё']] as const) {
        const b = el('button', 'awo-btn' + (this.view === v ? ' is-active' : ''), label);
        b.type = 'button';
        b.addEventListener('click', () => {
          this.view = v;
          this.render();
        });
        ctl.append(b);
      }
    }
    const refresh = el('button', 'awo-btn', 'Обновить');
    refresh.type = 'button';
    refresh.title = 'Загрузить данные заново, без кэша';
    refresh.addEventListener('click', () => this.handlers.refresh());
    ctl.append(refresh);
    head.append(ctl);
    r.append(head);
    this.adapter.decorate?.(r, heading);

    if (this.state.status === 'loading') {
      r.append(el('div', 'awo-state', 'Загружаю связи франшизы…'));
      return;
    }
    if (this.state.status === 'error') {
      r.append(el('div', 'awo-state', `Порядок не определён: ${this.state.message}`));
      return;
    }
    const res = this.state.result;
    const items = this.view === 'main' && res.mode === 'anilist' ? res.items.filter((i) => i.kind === 'main') : res.items;
    if (items.length === 0) {
      r.append(el('div', 'awo-state', 'Порядок не определён.'));
    } else {
      const list = el('ol', 'awo-list');
      for (const it of items) list.append(this.row(it));
      r.append(list);
    }
    if (res.branches.length > 0) {
      const d = el('details', 'awo-branches');
      d.append(el('summary', undefined, `Альтернативы и прочее (${res.branches.length})`));
      const list = el('ol', 'awo-list');
      for (const it of res.branches) list.append(this.row(it));
      d.append(list);
      r.append(d);
    }
    const notes = [...res.notes];
    if (res.mode === 'anilist') notes.push('Рекомендованный порядок по связям и датам выхода AniList, не каноническая хронология.');
    r.append(el('div', 'awo-notes', notes.join(' ')));
  }

  private row(it: OrderItem): HTMLElement {
    const li = el('li', 'awo-row');
    if (it.isCurrent) li.classList.add('is-current');
    if (it.kind !== 'main' && this.view === 'all' && it.kind !== 'other') li.classList.add('is-side');

    const watched = this.user.isWatched(it.watchKey);
    const mark = el('button', 'awo-mark', it.isCurrent ? '▶' : watched ? '✓' : it.kind === 'main' ? '○' : '◇');
    mark.type = 'button';
    mark.title = watched ? 'Снять отметку «просмотрено»' : 'Отметить просмотренным';
    mark.addEventListener('click', () => {
      this.user.setWatched(it.watchKey, !watched);
      this.render();
    });
    li.append(mark);
    li.append(el('span', 'awo-num', it.index !== undefined ? String(it.index) : ''));

    const url = it.match?.title.url;
    if (url && !it.isCurrent) {
      const a = el('a', 'awo-title', it.title);
      a.href = url;
      li.append(a);
    } else {
      li.append(el('span', 'awo-title', it.title));
    }

    const meta = [it.formatLabel, yearOf(it.date), KIND_LABEL[it.kind], it.isCurrent ? 'Вы здесь' : '', watched && it.isCurrent ? 'просмотрено' : '']
      .filter(Boolean)
      .join(' · ');
    if (meta) li.append(el('span', 'awo-meta', meta));
    for (const f of it.flags) li.append(el('span', 'awo-warn', f));

    const conf = it.match?.confidence;
    if (!it.isCurrent && it.alId !== undefined && it.match && (conf === 'name' || conf === 'date')) {
      li.append(el('span', 'awo-warn', conf === 'name' ? '≈ по названию' : '≈ по дате выхода'));
      const no = el('button', 'awo-link', 'не то');
      no.type = 'button';
      no.title = 'Убрать это сопоставление';
      const pair = pairKey(it.alId, it.match.title.key);
      no.addEventListener('click', () => this.handlers.rejectMatch(pair));
      li.append(no);
    }
    if (!it.match) {
      const miss = el('span', 'awo-miss', 'Не найдено на сайте');
      if (it.searchUrl) {
        miss.append(' · ');
        const a = el('a', undefined, 'искать');
        a.href = it.searchUrl;
        miss.append(a);
      }
      li.append(miss);
    }
    if (it.subtitle) li.append(el('span', 'awo-sub', it.subtitle));
    return li;
  }
}
