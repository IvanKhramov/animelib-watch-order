import { describe, expect, it, vi } from 'vitest';
import { COMMUNITY_URL, CommunityOrdersClient, communityProfile, parseCatalogue } from '../src/communityOrders';
import { AbortError } from '../src/http';
import { Cache, DAY, memoryKV } from '../src/storage';
import snapshot from '../data/community-orders.json';

function feed() {
  return { version: 1, updatedAt: '2026-10-18T00:00:00Z', profiles: [{
    id: 'community:fixture', title: 'Fixture', checkedAt: '2026-10-18', anchorIds: [123456], origin: 'community',
    recommended: { steps: [{ alId: 123456, title: 'First', episodes: '1–12' }], note: 'Порядок сообщества.',
      sources: [{ label: 'r/anime', url: 'https://www.reddit.com/r/anime/wiki/watch_order/' }] },
  }] };
}
const context = (now: () => number = () => 0) => ({ cache: new Cache(memoryKV(), now), signal: new AbortController().signal, force: false });

describe('автоматический каталог', () => {
  it('встроенный снимок проходит тот же валидатор, что и сетевой ответ', () => {
    const catalogue = parseCatalogue(snapshot);
    expect(catalogue).toBeDefined();
    expect(catalogue!.profiles.length).toBeGreaterThanOrEqual(20);
    expect(catalogue!.profiles.length).toBe(snapshot.profiles.length);
    expect(catalogue!.profiles.find((profile) => profile.title === 'Aria')?.recommended.steps.length).toBeGreaterThan(2);
    expect(catalogue!.profiles.find((profile) => profile.title === 'Cardcaptor Sakura')?.chronological?.steps.length).toBeGreaterThan(2);
  });

  it('принимает только точный ID, пустое или неоднозначное совпадение не угадывает', () => {
    const parsed = parseCatalogue(feed())!;
    expect(communityProfile(parsed, 123456)?.origin).toBe('community');
    expect(communityProfile(parsed, 123457)).toBeUndefined();
    parsed.profiles.push({ ...parsed.profiles[0]!, id: 'community:other' });
    expect(communityProfile(parsed, 123456)).toBeUndefined();
  });

  it('добавляет событийный порядок Shikimori к рекомендации r/anime, сохраняя возраст источника', () => {
    const raw = feed();
    const source = { label: 'Shikimori', url: 'https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime' };
    const shiki = { ...raw.profiles[0]!, id: 'shikimori:2881-1', checkedAt: '2020-06-26',
      recommended: { steps: [], note: 'Только хронология.', sources: [source] },
      chronological: { ...raw.profiles[0]!.recommended, sources: [source] },
    };
    const parsed = parseCatalogue({ ...raw, profiles: [...raw.profiles, shiki] })!;
    const merged = communityProfile(parsed, 123456)!;
    expect(merged.recommended.sources[0]!.label).toBe('r/anime');
    expect(merged.chronological?.label).toBe('Shikimori');
    expect(merged.chronological?.checkedAt).toBe('2020-06-26');
    expect(merged.chronological?.origin).toBe('community');
  });

  it('разные хронологии двух источников остаются отдельными вариантами', () => {
    const raw = feed();
    const a = { ...raw.profiles[0]!, chronological: raw.profiles[0]!.recommended };
    const b = { ...a, id: 'shikimori:2881-1', recommended: { ...a.recommended, steps: [] },
      chronological: { ...a.chronological, sources: [{ label: 'Shikimori', url: 'https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime' }] } };
    b.recommended.sources = b.chronological.sources;
    const merged = communityProfile(parseCatalogue({ ...raw, profiles: [a, b] })!, 123456)!;
    expect(merged.chronologicalVariants?.map((route) => route.label)).toEqual(['r/anime', 'Shikimori']);
  });

  it.each([
    (d: ReturnType<typeof feed>) => { d.profiles[0]!.anchorIds = [-1]; },
    (d: ReturnType<typeof feed>) => { d.profiles[0]!.recommended.steps[0]!.alId = 999; },
    (d: ReturnType<typeof feed>) => { d.profiles[0]!.recommended.sources[0]!.url = 'https://evil.example/wiki'; },
    (d: ReturnType<typeof feed>) => { d.profiles[0]!.recommended.steps[0]!.episodes = '1–12<script>'; },
    (d: ReturnType<typeof feed>) => { d.profiles[0]!.recommended.steps.push(d.profiles[0]!.recommended.steps[0]!); },
    (d: ReturnType<typeof feed>) => { d.updatedAt = 'not a date'; },
  ])('отклоняет повреждённый или подменённый каталог целиком', (damage) => {
    const raw = feed(); damage(raw);
    expect(parseCatalogue(raw)).toBeUndefined();
  });

  it('запрашивает один общий файл без названий, ID, cookie и токенов сайта', async () => {
    const transport = vi.fn(async () => ({ status: 200, text: JSON.stringify(feed()) }));
    const client = new CommunityOrdersClient(transport);
    const ctx = context();
    expect((await client.load(123456, ctx)).profile?.id).toBe('community:fixture');
    await client.load(888, ctx);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toEqual([{ url: COMMUNITY_URL, method: 'GET', signal: ctx.signal, timeoutMs: 4000 }]);
  });

  it('обновляет фид после TTL и сохраняет прежний рабочий источник при сбое', async () => {
    let now = 0;
    const ctx = context(() => now);
    const transport = vi.fn().mockResolvedValueOnce({ status: 200, text: JSON.stringify(feed()) }).mockRejectedValue(new Error('offline'));
    const client = new CommunityOrdersClient(transport);
    await client.load(123456, ctx);
    now = DAY + 1;
    const stale = await client.load(123456, ctx);
    expect(stale.profile?.id).toBe('community:fixture');
    expect(stale.note).toContain('сохранённая');
    await client.load(123456, ctx);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('старый ответ CDN не заменяет свежую сохранённую копию', async () => {
    let now = 0;
    const ctx = context(() => now);
    const old = { ...feed(), updatedAt: '2026-10-16T00:00:00Z', profiles: [] };
    // Пустой ответ тоже не должен затирать каталог.
    const transport = vi.fn().mockResolvedValueOnce({ status: 200, text: JSON.stringify(feed()) }).mockResolvedValue({ status: 200, text: JSON.stringify(old) });
    const client = new CommunityOrdersClient(transport);
    await client.load(123456, ctx);
    now = DAY + 1;
    expect((await client.load(123456, ctx)).profile?.id).toBe('community:fixture');
  });

  it('отмена загрузки не превращается в успешный запасной результат', async () => {
    const client = new CommunityOrdersClient(async () => { throw new AbortError(); });
    await expect(client.load(123456, context())).rejects.toBeInstanceOf(AbortError);
  });

  it('кнопка обновления обходит дневной кэш', async () => {
    const transport = vi.fn(async () => ({ status: 200, text: JSON.stringify(feed()) }));
    const client = new CommunityOrdersClient(transport);
    const ctx = context();
    await client.load(123456, ctx);
    await client.load(123456, { ...ctx, force: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
