import { applyOrder, move } from './customOrder';
import { pairKey } from './matching';
import type { UserState } from './storage';
import type { FuzzyDate, ItemKind, OrderItem, OrderResult } from './types';

export type UiState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: OrderResult };

export interface UiHandlers {
  refresh(): void;
  /** данные пользователя поменялись так, что нужна пересборка (отклонённое сопоставление, импорт) */
  reload(): void;
  /** скрыть блок на этом сайте */
  hideOnSite(): void;
}

// Блок живёт в Shadow DOM: стили сайта на него не влияют, вид одинаковый на всех сайтах.
const CSS = `
:host{all:initial;display:block;margin:24px 0;color:var(--fg);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
:host([data-theme=dark]){--fg:#e8e8ea;--muted:#a1a1aa;--row:rgba(255,255,255,.05);--row-hi:rgba(255,255,255,.12);
  --line:rgba(255,255,255,.16);--accent:#8b7cf6;--warn:#e3a33b;--panel:#232327;--shadow:rgba(0,0,0,.5)}
:host([data-theme=light]){--fg:#1d1d1f;--muted:#6b6b73;--row:rgba(0,0,0,.04);--row-hi:rgba(0,0,0,.09);
  --line:rgba(0,0,0,.15);--accent:#6a4ff0;--warn:#a85f00;--panel:#fff;--shadow:rgba(0,0,0,.18)}
*{box-sizing:border-box}
button{font:inherit;color:inherit}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.toggle{all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;min-width:0}
.chev{display:inline-block;width:1em;text-align:center;color:var(--muted);transition:transform .15s}
.collapsed .chev{transform:rotate(-90deg)}
h2{margin:0;font-size:18px;font-weight:600;line-height:1.3}
.sum{font-size:12px;color:var(--muted)}
.ctl{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto;position:relative}
.btn{font-size:12px;line-height:18px;padding:3px 10px;border-radius:6px;cursor:pointer;background:transparent;
  border:1px solid var(--line)}
.btn:hover,.btn.on{background:var(--row-hi)}
.seg{display:inline-flex}
.seg .btn{border-radius:0}
.seg .btn:first-child{border-radius:6px 0 0 6px}
.seg .btn:last-child{border-radius:0 6px 6px 0;border-left:0}
.menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:220px;padding:4px;border-radius:8px;
  background:var(--panel);border:1px solid var(--line);box-shadow:0 8px 24px var(--shadow)}
.menu button{all:unset;display:block;width:100%;box-sizing:border-box;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:13px}
.menu button:hover{background:var(--row-hi)}
ol{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
li{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding:6px 10px;border-radius:8px;background:var(--row)}
li.cur{background:var(--row-hi);box-shadow:inset 3px 0 0 var(--accent)}
li.cur .title{font-weight:600}
li.side{margin-left:20px}
li.done .title{color:var(--muted)}
.mark{all:unset;cursor:pointer;width:1.3em;text-align:center;color:var(--muted)}
.mark:hover{color:var(--fg)}
li.done .mark{color:var(--accent)}
.num{min-width:1.5em;color:var(--muted);font-variant-numeric:tabular-nums}
.title{color:inherit;text-decoration:none;overflow-wrap:anywhere}
a.title:hover{text-decoration:underline}
.meta,.sub{font-size:12px;color:var(--muted)}
.warn{font-size:12px;color:var(--warn)}
.miss{font-size:12px;color:var(--muted)}
.miss a{color:inherit}
.link{all:unset;cursor:pointer;font-size:12px;text-decoration:underline;color:var(--muted)}
.edit{display:flex;gap:4px;margin-left:auto}
.edit .btn{padding:1px 8px}
details{margin-top:10px}
summary{cursor:pointer;color:var(--muted)}
.note{margin-top:8px;font-size:12px;color:var(--muted)}
.state{margin-top:10px;color:var(--muted)}
.cover{all:unset;flex:none;width:40px;height:56px;border-radius:4px;overflow:hidden;cursor:zoom-in;background:var(--row-hi)}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.cover.empty{cursor:default}
`;

// Просмотр обложки живёт в отдельном слое на <html>: внутри разметки сайта его перекрывали шапка и постер.
const ZOOM_CSS = `
:host{all:initial}
.zoom{outline:none;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;
  background:rgba(8,8,10,.94);cursor:zoom-out;padding:24px;overflow:hidden;overscroll-behavior:contain;touch-action:none;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.frame{width:min(760px,92vw);height:min(78vh,1000px);overflow:hidden;border-radius:10px;display:flex;align-items:center;
  justify-content:center;cursor:default}
.frame img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.6);
  transform-origin:center;user-select:none;will-change:transform}
.cap{position:relative;z-index:1;color:#fff;text-align:center;max-width:90vw;text-shadow:0 1px 3px #000}
.hint{position:relative;z-index:1;color:rgba(255,255,255,.55);font-size:12px}
`;

const KIND_LABEL: Record<ItemKind, string> = {
  main: '',
  extra: 'Дополнительно',
  recap: 'Пересказ',
  alternative: 'Альтернативная ветка',
  spinoff: 'Спин-офф',
  other: 'Другое',
};

export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

/**
 * Масштаб с точкой под курсором на месте.
 * d: смещение курсора от центра картинки без сдвига (в пикселях экрана).
 */
export function zoomAt(v: ZoomView, factor: number, d: { x: number; y: number }, min = 1, max = 8): ZoomView {
  const scale = Math.min(max, Math.max(min, v.scale * factor));
  if (scale === 1) return { scale: 1, x: 0, y: 0 };
  const k = scale / v.scale;
  return { scale, x: d.x - k * (d.x - v.x), y: d.y - k * (d.y - v.y) };
}

const yearOf = (d: FuzzyDate | undefined) => (d?.year ? String(d.year) : undefined);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string; onClick?: () => void } = {},
  ...children: (Node | string | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  if (props.onClick) {
    const fn = props.onClick;
    e.addEventListener('click', (ev) => {
      ev.preventDefault();
      fn();
    });
  }
  if (e instanceof HTMLButtonElement) e.type = 'button';
  for (const c of children) if (c) e.append(c);
  return e;
}

/** Тёмная ли тема под блоком: по первому непрозрачному фону вверх по дереву. */
export function isDarkBackground(start: Element | null): boolean {
  for (let el = start; el; el = el.parentElement) {
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
    const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

export class WatchOrderView {
  /** элемент в DOM сайта; всё содержимое в его shadow root */
  readonly root: HTMLElement;
  private readonly box: HTMLElement;
  private state: UiState = { status: 'loading' };
  private editing = false;
  private menuOpen = false;

  constructor(
    private readonly user: UserState,
    private readonly handlers: UiHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.dataset.awo = '1';
    this.root.dataset.theme = 'dark';
    const shadow = this.root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.box = document.createElement('div');
    shadow.append(style, this.box);
    this.render();
  }

  set(state: UiState) {
    this.state = state;
    this.root.dataset.status = state.status;
    this.render();
  }

  /** Подстроить тему под фон страницы; зовётся при каждом монтировании. */
  syncTheme() {
    const theme = isDarkBackground(this.root.parentElement) ? 'dark' : 'light';
    if (this.root.dataset.theme !== theme) this.root.dataset.theme = theme;
  }

  private result(): OrderResult | undefined {
    return this.state.status === 'ready' ? this.state.result : undefined;
  }

  /** Элементы основного списка с учётом своего порядка, скрытых и режима. */
  private arranged(res: OrderResult) {
    const prefs = this.user.prefs();
    const custom = this.user.customOrder(res.franchiseKey);
    const byKey = new Map(res.items.map((i) => [i.watchKey, i]));
    const keys = applyOrder(res.items.map((i) => i.watchKey), custom?.order);
    const hidden = new Set(custom?.hidden ?? []);
    const all = keys.map((k) => byKey.get(k)!);
    const showAll = prefs.view === 'all' || res.mode !== 'anilist';
    const visible = all.filter((i) => !hidden.has(i.watchKey) && (showAll || i.kind === 'main' || i.isCurrent));
    return { keys, all, visible, hiddenItems: all.filter((i) => hidden.has(i.watchKey)), custom };
  }

  private render() {
    const prefs = this.user.prefs();
    const res = this.result();
    const wrap = h('div', { class: prefs.collapsed ? 'collapsed' : '' });
    wrap.append(this.header(res));
    if (!prefs.collapsed) wrap.append(...this.body(res));
    this.box.replaceChildren(wrap);
  }

  private header(res: OrderResult | undefined): HTMLElement {
    const prefs = this.user.prefs();
    const toggle = h(
      'button',
      {
        class: 'toggle',
        title: prefs.collapsed ? 'Развернуть' : 'Свернуть',
        onClick: () => {
          this.user.setPrefs({ collapsed: !prefs.collapsed });
          this.render();
        },
      },
      h('span', { class: 'chev', text: '▾' }),
      h('h2', { text: 'Порядок просмотра' }),
    );
    const head = h('div', { class: 'head' }, toggle);
    if (res) head.append(h('span', { class: 'sum', text: this.summary(res) }));
    if (prefs.collapsed) return head;

    const ctl = h('div', { class: 'ctl' });
    if (res?.mode === 'anilist') {
      const seg = h('span', { class: 'seg' });
      for (const [v, label] of [['main', 'Основное'], ['all', 'Всё']] as const) {
        seg.append(
          h('button', {
            class: 'btn' + (prefs.view === v ? ' on' : ''),
            text: label,
            onClick: () => {
              this.user.setPrefs({ view: v });
              this.render();
            },
          }),
        );
      }
      ctl.append(seg);
    }
    if (res) {
      ctl.append(
        h('button', {
          class: 'btn' + (prefs.covers ? ' on' : ''),
          text: 'Обложки',
          title: 'Показать обложки частей',
          onClick: () => {
            this.user.setPrefs({ covers: !prefs.covers });
            this.render();
          },
        }),
      );
      ctl.append(
        h('button', {
          class: 'btn' + (this.editing ? ' on' : ''),
          text: this.editing ? 'Готово' : 'Править',
          title: 'Поменять порядок и скрыть лишнее',
          onClick: () => {
            this.editing = !this.editing;
            this.render();
          },
        }),
      );
    }
    ctl.append(h('button', { class: 'btn', text: 'Обновить', title: 'Загрузить данные заново, без кэша', onClick: () => this.handlers.refresh() }));
    ctl.append(
      h('button', {
        class: 'btn' + (this.menuOpen ? ' on' : ''),
        text: '⋯',
        title: 'Ещё',
        onClick: () => {
          this.menuOpen = !this.menuOpen;
          this.render();
        },
      }),
    );
    if (this.menuOpen) ctl.append(this.menu(res));
    head.append(ctl);
    return head;
  }

  private menu(res: OrderResult | undefined): HTMLElement {
    const close = (fn: () => void) => () => {
      this.menuOpen = false;
      fn();
      this.render();
    };
    const m = h('div', { class: 'menu' });
    m.append(h('button', { text: 'Экспорт отметок в файл', onClick: close(() => this.exportFile()) }));
    m.append(h('button', { text: 'Импорт отметок из файла', onClick: close(() => this.importFile()) }));
    if (res && this.user.customOrder(res.franchiseKey)) {
      m.append(
        h('button', {
          text: 'Сбросить свой порядок для франшизы',
          onClick: close(() => this.user.setCustomOrder(res.franchiseKey, undefined)),
        }),
      );
    }
    m.append(h('button', { text: 'Скрыть блок на этом сайте', onClick: close(() => this.handlers.hideOnSite()) }));
    return m;
  }

  private summary(res: OrderResult): string {
    const { visible } = this.arranged(res);
    const main = visible.filter((i) => i.kind === 'main');
    const watched = main.filter((i) => this.user.isWatched(i.watchKey)).length;
    const pos = main.findIndex((i) => i.isCurrent);
    const parts: string[] = [];
    if (pos >= 0 && res.mode === 'anilist') parts.push(`вы здесь: ${pos + 1} из ${main.length}`);
    if (watched > 0) parts.push(`просмотрено ${watched} из ${main.length}`);
    if (this.user.prefs().collapsed) {
      const next = main.find((i, n) => n > pos && !this.user.isWatched(i.watchKey));
      if (next && pos >= 0) parts.push(`дальше: ${next.title}`);
    }
    return parts.join(' · ');
  }

  private body(res: OrderResult | undefined): HTMLElement[] {
    if (this.state.status === 'loading') return [h('div', { class: 'state', text: 'Загружаю связи франшизы…' })];
    if (this.state.status === 'error') return [h('div', { class: 'state', text: `Порядок не определён: ${this.state.message}` })];
    if (!res) return [];
    const out: HTMLElement[] = [];
    const { keys, visible, hiddenItems, custom } = this.arranged(res);
    if (visible.length === 0) {
      out.push(h('div', { class: 'state', text: 'Порядок не определён.' }));
    } else {
      const list = h('ol');
      const visibleKeys = new Set(visible.map((i) => i.watchKey));
      let n = 0;
      for (const it of visible) {
        const index = res.mode === 'anilist' && it.kind === 'main' ? ++n : undefined;
        list.append(this.row(it, index, { keys, visibleKeys, franchise: res.franchiseKey, hidden: custom?.hidden ?? [] }));
      }
      out.push(list);
    }
    if (this.editing && hiddenItems.length > 0) {
      const d = h('details');
      d.open = true;
      d.append(h('summary', { text: `Скрытые (${hiddenItems.length})` }));
      const list = h('ol');
      for (const it of hiddenItems) {
        list.append(
          h(
            'li',
            {},
            h('span', { class: 'title', text: it.title }),
            h('span', { class: 'meta', text: [it.formatLabel, yearOf(it.date)].filter(Boolean).join(' · ') }),
            h(
              'span',
              { class: 'edit' },
              h('button', {
                class: 'btn',
                text: 'Вернуть',
                onClick: () => {
                  const hidden = (custom?.hidden ?? []).filter((k) => k !== it.watchKey);
                  this.user.setCustomOrder(res.franchiseKey, { order: custom?.order ?? [], hidden });
                  this.render();
                },
              }),
            ),
          ),
        );
      }
      d.append(list);
      out.push(d);
    }
    if (res.branches.length > 0) {
      const d = h('details');
      d.open = this.user.prefs().branchesOpen;
      d.addEventListener('toggle', () => this.user.setPrefs({ branchesOpen: d.open }));
      d.append(h('summary', { text: `Альтернативы и прочее (${res.branches.length})` }));
      const list = h('ol');
      for (const it of res.branches) list.append(this.row(it, undefined));
      d.append(list);
      out.push(d);
    }
    const notes = [...res.notes];
    if (res.mode === 'anilist') notes.push('Рекомендованный порядок по связям и датам выхода AniList, не каноническая хронология.');
    if (custom) notes.push('Порядок изменён вами.');
    out.push(h('div', { class: 'note', text: notes.join(' ') }));
    return out;
  }

  private row(
    it: OrderItem,
    index: number | undefined,
    edit?: { keys: string[]; visibleKeys: Set<string>; franchise: string; hidden: string[] },
  ): HTMLElement {
    const watched = this.user.isWatched(it.watchKey);
    const li = h('li');
    if (it.isCurrent) li.classList.add('cur');
    if (watched) li.classList.add('done');
    if (edit && it.kind !== 'main') li.classList.add('side');

    li.append(
      h('button', {
        class: 'mark',
        text: watched ? '✓' : it.isCurrent ? '▶︎' : it.kind === 'main' ? '○' : '◇',
        title: watched ? 'Снять отметку «просмотрено»' : 'Отметить просмотренным',
        onClick: () => {
          this.user.setWatched(it.watchKey, !watched);
          this.render();
        },
      }),
    );
    li.append(h('span', { class: 'num', text: index !== undefined ? String(index) : '' }));
    if (this.user.prefs().covers) li.append(this.cover(it));

    const url = it.match?.title.url;
    if (url && !it.isCurrent) {
      const a = h('a', { class: 'title', text: it.title });
      a.href = url;
      li.append(a);
    } else {
      li.append(h('span', { class: 'title', text: it.title }));
    }

    const meta = [it.formatLabel, yearOf(it.date), KIND_LABEL[it.kind], it.isCurrent ? 'вы здесь' : ''].filter(Boolean).join(' · ');
    if (meta) li.append(h('span', { class: 'meta', text: meta }));
    for (const f of it.flags) li.append(h('span', { class: 'warn', text: f }));

    const conf = it.match?.confidence;
    if (!it.isCurrent && it.alId !== undefined && it.match && (conf === 'name' || conf === 'date')) {
      li.append(h('span', { class: 'warn', text: conf === 'name' ? '≈ по названию' : '≈ по дате выхода' }));
      const pair = pairKey(it.alId, it.match.title.key);
      li.append(
        h('button', {
          class: 'link',
          text: 'не то',
          title: 'Убрать это сопоставление',
          onClick: () => {
            this.user.reject(pair);
            this.handlers.reload();
          },
        }),
      );
    }
    if (!it.match) {
      const miss = h('span', { class: 'miss', text: 'Не найдено на сайте' });
      if (it.searchUrl) {
        const a = h('a', { text: 'искать' });
        a.href = it.searchUrl;
        miss.append(' · ', a);
      }
      li.append(miss);
    }
    if (it.subtitle) li.append(h('span', { class: 'sub', text: it.subtitle }));

    if (this.editing && edit) {
      const save = (order: string[], hidden: string[]) => {
        this.user.setCustomOrder(edit.franchise, { order, hidden });
        this.render();
      };
      li.append(
        h(
          'span',
          { class: 'edit' },
          h('button', { class: 'btn', text: '↑', title: 'Выше', onClick: () => save(move(edit.keys, it.watchKey, -1, edit.visibleKeys), edit.hidden) }),
          h('button', { class: 'btn', text: '↓', title: 'Ниже', onClick: () => save(move(edit.keys, it.watchKey, 1, edit.visibleKeys), edit.hidden) }),
          h('button', { class: 'btn', text: 'Скрыть', onClick: () => save(edit.keys, [...edit.hidden, it.watchKey]) }),
        ),
      );
    }
    return li;
  }

  private cover(it: OrderItem): HTMLElement {
    if (!it.cover) return h('span', { class: 'cover empty' });
    const img = h('img');
    img.src = it.cover;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    return h('button', { class: 'cover', title: 'Увеличить', onClick: () => this.zoom(it) }, img);
  }

  /**
   * Крупная обложка поверх всей страницы. Колесо приближает относительно центра картинки,
   * приближённую картинку можно таскать, двойной клик сбрасывает масштаб.
   * Картинка зумится внутри рамки, поле вокруг всегда свободно: клик по нему или Esc закрывает.
   */
  private zoom(it: OrderItem) {
    // просмотр всегда один: пробел или Enter на кнопке обложки не должны открыть второй
    for (const old of document.querySelectorAll('[data-awo-zoom]')) old.remove();
    const host = document.createElement('div');
    host.dataset.awoZoom = '1';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ZOOM_CSS;

    const img = h('img');
    img.src = it.coverLarge ?? it.cover ?? '';
    img.alt = it.title;
    img.referrerPolicy = 'no-referrer';
    img.draggable = false;
    const frame = h('div', { class: 'frame' }, img);
    const layer = h(
      'div',
      { class: 'zoom' },
      frame,
      h('div', { class: 'cap', text: it.title }),
      h('div', { class: 'hint', text: 'колесо: масштаб · перетаскивание: сдвиг · двойной клик: сброс · Esc или клик мимо: закрыть' }),
    );
    shadow.append(style, layer);

    let view: ZoomView = { scale: 1, x: 0, y: 0 };
    const apply = () => {
      img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
      img.style.cursor = view.scale > 1 ? 'grab' : 'zoom-in';
    };

    // прокрутка страницы на время просмотра выключена, в том числе с клавиатуры
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';

    const close = () => {
      host.remove();
      root.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };

    layer.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // зум относительно текущего центра картинки: она остаётся на месте и растёт во все стороны
        view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), { x: view.x, y: view.y });
        apply();
      },
      { passive: false },
    );

    let drag: { px: number; py: number; x: number; y: number } | undefined;
    img.addEventListener('pointerdown', (e) => {
      if (view.scale <= 1) return;
      drag = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
      img.setPointerCapture(e.pointerId);
      img.style.cursor = 'grabbing';
    });
    img.addEventListener('pointermove', (e) => {
      if (!drag) return;
      view = { ...view, x: drag.x + e.clientX - drag.px, y: drag.y + e.clientY - drag.py };
      apply();
    });
    img.addEventListener('pointerup', () => {
      drag = undefined;
      apply();
    });
    img.addEventListener('dblclick', () => {
      view = { scale: 1, x: 0, y: 0 };
      apply();
    });

    // закрывает клик по полю вокруг рамки; клик по картинке и внутри рамки не закрывает
    layer.addEventListener('click', (e) => {
      if (!e.composedPath().includes(frame)) close();
    });
    document.addEventListener('keydown', onKey, true);
    apply();
    // на <html>, а не в разметку сайта: иначе слой оказывается под шапкой и постером
    document.documentElement.append(host);
    layer.tabIndex = -1;
    layer.focus({ preventScroll: true });
  }

  private exportFile() {
    const blob = new Blob([JSON.stringify(this.user.exportData(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `watch-order-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  private importFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        this.user.importData(JSON.parse(await file.text()) as unknown);
        this.handlers.reload();
      } catch (e) {
        alert(`Импорт не удался: ${e instanceof Error ? e.message : 'ошибка'}`);
      }
    });
    input.click();
  }
}
