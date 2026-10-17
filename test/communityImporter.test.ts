import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The standalone Node importer intentionally has no runtime TypeScript dependency.
import { normalizeCommunityCatalogue } from '../scripts/import-community-orders.mjs';

type Step = { alId: number; title?: string; episodes?: string; optional?: boolean };
type Route = { steps: Step[]; note: string; sources: { url: string }[] };
type Catalogue = {
  version: number; updatedAt: string; sourceUrl: string;
  profiles: { id: string; origin: string; anchorIds: number[]; recommended: Route; chronological?: Route }[];
  stats: { importedRoutes: number; skippedRoutes: number; skipReasons: Record<string, number> };
};
const normalize = normalizeCommunityCatalogue as (raw: unknown) => Catalogue;
const link = (id: number, title = `Title ${id}`) => `<a href="https://myanimelist.net/anime/${id}/title">${title}</a>`;
const mapping = (idMal: number, id = idMal + 1000) => ({ media: { id, idMal, episodes: 100 }, is_optional: true });
const order = (html: string, ids: number[] = [1, 2], name = 'Main Story') => ({ name, description_html: html, steps: ids.map((id) => mapping(id)) });
const raw = (orders: ReturnType<typeof order>[], title = 'Fixture') => ({
  metadata: { last_updated_utc: '2026-10-17T10:27:53+00:00' }, data: [{ title, watch_orders: orders }],
});
const imported = (html: string, ids?: number[]) => normalize(raw([order(html, ids)]));

describe('community watch-order importer', () => {
  it('maps MAL IDs to explicit AniList IDs and ignores the lossy step order and optional flags', () => {
    const data = raw([order(`<p>${link(2)} -&gt; ${link(1)}</p>`)]);
    const before = structuredClone(data);
    const result = normalize(data);
    expect(result.profiles[0]!.recommended.steps).toEqual([{ alId: 1002, title: 'Title 2' }, { alId: 1001, title: 'Title 1' }]);
    expect(result.profiles[0]!.anchorIds).toEqual([1002, 1001]);
    expect(result.profiles[0]!.origin).toBe('community');
    expect(result.profiles[0]!.recommended.sources[0]!.url).toBe(result.sourceUrl);
    expect(result.updatedAt).toBe(data.metadata.last_updated_utc);
    expect(data).toEqual(before);
  });

  it('preserves a repeated Second Season with ranges outside the links', () => {
    const html = `<p>Infographic: <a href="https://example.org/chart">chart</a></p>
      <p>${link(1, 'Second Season')} (1-11) -&gt; ${link(2, 'Hanamonogatari')} -&gt; ${link(1, 'Second Season')} (12-26)</p>`;
    const result = normalize(raw([order(html, [1, 2], 'Novel Release Order')], 'Monogatari'));
    expect(result.profiles[0]!.recommended.steps.map(({ alId, episodes }) => [alId, episodes])).toEqual([
      [1001, '1–11'], [1002, undefined], [1001, '12–26'],
    ]);
    expect(result.profiles[0]!.anchorIds).toEqual([1001, 1002]);
  });

  it('preserves linked Lost Girls segments and excludes Junior High from later notes', () => {
    const html = `<p>${link(1, 'Lost Girls Episodes 1-2 [OVA]')} → ${link(2, 'Season 3')} → ${link(1, 'Lost Girls Episode 3 [OVA]')}</p>
      <p>Note:</p><ul><li>${link(3, 'Junior High')} is a comedy spin-off.</li></ul>`;
    const result = imported(html, [1, 2, 3]);
    expect(result.profiles[0]!.recommended.steps.map(({ alId, episodes }) => [alId, episodes])).toEqual([
      [1001, '1–2'], [1002, undefined], [1001, '3'],
    ]);
    expect(result.profiles[0]!.anchorIds).not.toContain(1003);
  });

  it('rejects the entire KonoSuba route when the second range has no link', () => {
    const html = `<p>${link(1, 'Season 2 episodes 1-4')} → ${link(2, 'OVA')} → Season 2 episodes 5-10 → ${link(3, 'Movie')}</p>`;
    const result = imported(html, [1, 2, 3]);
    expect(result.profiles).toEqual([]);
    expect(result.stats.skipReasons['ambiguous-sequence']).toBe(1);
  });

  it.each(['or', '+', '/', 'and then', '(either version)', '(alternatively)'])('rejects branching text outside links: %s', (branch) => {
    const result = imported(`<p>${link(1)} → ${link(2)} ${branch} ${link(3)}</p>`, [1, 2, 3]);
    expect(result.profiles).toEqual([]);
  });

  it('allows titles containing Alternative, vs or arrows without treating them as branches', () => {
    const result = imported(`<p>${link(1, 'FLCL Alternative')} → ${link(2, 'A vs Kimura → Part 2')}</p>`);
    expect(result.profiles[0]!.recommended.steps.map((step) => step.title)).toEqual(['FLCL Alternative', 'A vs Kimura → Part 2']);
  });

  it('takes optional flags locally and ignores notes and additional sequences', () => {
    const result = imported(`<p>${link(1)} (Optional) → ${link(2)}</p><p>Note: ${link(3)} is optional.</p><p>${link(3)} → ${link(4)}</p>`, [1, 2, 3, 4]);
    expect(result.profiles[0]!.recommended.steps).toEqual([
      { alId: 1001, title: 'Title 1', optional: true }, { alId: 1002, title: 'Title 2' },
    ]);
  });

  it('parses only a flat ordered list and keeps single-episode suffixes', () => {
    const result = imported(`<ol><li><p>${link(1)} Episode 0</p></li><li>${link(2)} episodes 2 to 4 (optional)</li></ol><p>${link(3)}</p>`, [1, 2, 3]);
    expect(result.profiles[0]!.recommended.steps.map(({ alId, episodes, optional }) => [alId, episodes, optional])).toEqual([
      [1001, '0', undefined], [1002, '2–4', true],
    ]);
    expect(imported(`<ol><li>${link(1)}<ul><li>${link(2)}</li></ul></li><li>${link(3)}</li></ol>`, [1, 2, 3]).profiles).toEqual([]);
    expect(imported(`<ol>Either option:<li>${link(1)}</li><li>${link(2)}</li></ol>`).profiles).toEqual([]);
  });

  it('keeps release and explicitly chronological routes separate', () => {
    const result = normalize(raw([
      order(`<p>${link(1)} → ${link(2)}</p>`, [1, 2], 'Option 1 Chronologically by Release Date'),
      order(`<p>${link(2)} → ${link(1)}</p>`, [1, 2], 'Option 2 Chronologically by Series Timeline'),
    ]));
    expect(result.profiles[0]!.recommended.steps.map((step) => step.alId)).toEqual([1001, 1002]);
    expect(result.profiles[0]!.chronological!.steps.map((step) => step.alId)).toEqual([1002, 1001]);
  });

  it('does not pick the first competing recommendation, even if the other is unsupported', () => {
    const result = normalize(raw([
      order(`<p>${link(1)} → ${link(2)}</p>`, [1, 2], 'Airing Order'),
      order('<p>Plain A → Plain B</p>', [], 'Novel Release Order'),
    ]));
    expect(result.profiles).toEqual([]);
    expect(result.stats.skippedRoutes).toBe(2);
    expect(result.stats.skipReasons['competing-routes']).toBe(1);
  });

  it('does not collapse anime and movie timeline alternatives into one chronological route', () => {
    const result = normalize(raw([
      order(`<p>${link(1)} → ${link(2)}</p>`, [1, 2], 'Anime Timeline'),
      order(`<p>${link(2)} or ${link(1)}</p>`, [1, 2], 'Movie Timeline'),
    ]));
    expect(result.profiles).toEqual([]);
  });

  it('can import a chronological-only profile without inventing a recommendation', () => {
    const result = normalize(raw([order(`<p>${link(2)} → ${link(1)}</p>`, [1, 2], 'Chronological Order')]));
    expect(result.profiles[0]!.recommended.steps).toEqual([]);
    expect(result.profiles[0]!.chronological!.steps.map((step) => step.alId)).toEqual([1002, 1001]);
  });

  it.each(['Not Recommended', 'Second Most Recommended', 'Not for First Viewing'])('does not mistake a negative or secondary recommendation for a preferred route: %s', (name) => {
    expect(normalize(raw([order(`<p>${link(1)} → ${link(2)}</p>`, [1, 2], name)])).profiles).toEqual([]);
  });

  it('rejects incomplete mappings instead of assuming MAL ID equals AniList ID', () => {
    const missing = raw([order(`<p>${link(1)} → ${link(2)}</p>`, [1])]);
    expect(normalize(missing).profiles).toEqual([]);
    const invalid = raw([order(`<p>${link(1)} → ${link(2)}</p>`)]);
    invalid.data[0]!.watch_orders[0]!.steps[1]!.media.idMal = 0;
    expect(normalize(invalid).stats.skipReasons['missing-media-mapping']).toBe(1);
  });

  it('rejects conflicting mappings for a MAL ID', () => {
    const data = raw([order(`<p>${link(1)} → ${link(2)}</p>`)]);
    data.data[0]!.watch_orders[0]!.steps.push(mapping(1, 9999));
    expect(normalize(data).stats.skipReasons['conflicting-media-mapping']).toBe(1);
  });

  it.each(['1–8', '1–4'])('rejects overlapping repeated ranges: %s', (range) => {
    expect(imported(`<p>${link(1, 'Title Episodes 1-4')} → ${link(2)} → ${link(1, `Title Episodes ${range}`)}</p>`).profiles).toEqual([]);
  });

  it('rejects whole-title repeats, gaps, conflicting ranges and unsupported episode options', () => {
    for (const html of [
      `<p>${link(1)} → ${link(2)} → ${link(1)}</p>`,
      `<p>${link(1)} → Unlinked Title → ${link(2)}</p>`,
      `<p>${link(1, 'Title episodes 1-4')} (5-8) → ${link(2)}</p>`,
      `<p>${link(1)} episodes 1 and 3 → ${link(2)}</p>`,
      `<p>${link(1)} (episodes 1-11 or episodes 1-7) → ${link(2)}</p>`,
      `<p>${link(1)} 8+ → ${link(2)}</p>`,
    ]) expect(imported(html).profiles).toEqual([]);
  });

  it('parses HTML as inert data and never outputs executable HTML or source URLs', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
    const html = `<script>globalThis.__communityImportExecuted = true</script><iframe src="https://example.org"></iframe>
      <p>${link(1, '&lt;img src=x onerror=alert(1)&gt;')} → ${link(2)}</p>`;
    expect(imported(html).stats.skipReasons['unsafe-html']).toBe(1);
    const result = imported(`<p>${link(1, '&lt;img src=x onerror=alert(1)&gt;')} → ${link(2)}</p>`);
    expect((globalThis as Record<string, unknown>).__communityImportExecuted).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.profiles[0]!.recommended.steps[0]!.title).toBe('<img src=x onerror=alert(1)>');
    expect(result.profiles[0]!.recommended.sources[0]!.url).toMatch(/^https:\/\/www\.reddit\.com\//);
    expect(imported(`<p><a href="javascript:alert(1)">Bad</a> → ${link(2)}</p>`).profiles).toEqual([]);
    expect(imported(`<p><a href="https://myanimelist.net.evil.invalid/anime/1">Bad</a> → ${link(2)}</p>`).profiles).toEqual([]);
    fetchSpy.mockRestore();
  });

  it('rejects empty or oversized routes and caps total input work', () => {
    expect(imported('').stats.skipReasons['missing-html']).toBe(1);
    expect(imported(`<p>${'x'.repeat(128001)}</p>`).stats.skipReasons['route-size-limit']).toBe(1);
    expect(imported(`<p>${link(1)}</p>`).profiles).toEqual([]);
    expect(imported(`<p>${Array.from({ length: 81 }, () => link(1)).join(' → ')}</p>`).stats.skipReasons['route-step-limit']).toBe(1);
    expect(() => normalize({ data: Array.from({ length: 1001 }) })).toThrow('profile limit');
    expect(() => normalize({ metadata: { last_updated_utc: 'yesterday' }, data: [] })).toThrow('update date');
  });
});
