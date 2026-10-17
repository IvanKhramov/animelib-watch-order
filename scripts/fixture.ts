// Снимок графа AniList для тестов: node fixture.mjs <anilistId> <out.json>
import { writeFileSync } from 'node:fs';
import { AniListClient } from '../src/anilistAdapter';
import { fetchTransport, withRetry } from '../src/http';

const [id, out] = process.argv.slice(2);
const g = await new AniListClient(withRetry(fetchTransport)).loadFranchise(Number(id));
writeFileSync(out!, JSON.stringify({ rootId: g.rootId, truncated: g.truncated, nodes: [...g.nodes.values()] }, null, 1));
console.log(out, g.nodes.size, 'nodes');
