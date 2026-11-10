import { expect, it } from 'vitest';
import type { Tracking } from '../shared/types.js';
import { testHost, publicFixture, completed } from './helpers.js';
it('rotates a bounded subscription, validates scope and never automatically invokes a model', async () => {
  const calls: string[] = []; const host = await testHost({ reader: async (url, signal) => { calls.push(url); return publicFixture(url, signal); } });
  try {
    const sources = [1, 2, 3, 4].map(number => host.leader.sources.create(host.space.id, { name: `合成来源${number}`, kind: 'page', url: `https://public.test/${number}`, caseId: host.matter.id }));
    const subscription = host.tracker.create(host.space.id, { name: '合成来源刷新', caseId: host.matter.id, sourceIds: sources.map(source => source.id), intervalMinutes: 15, timezone: 'Asia/Shanghai', enabled: true, maxReadsPerTick: 2 });
    host.store.update<Tracking>('tracking', subscription.id, row => { row.nextAt = '2000-01-01T00:00:00.000Z'; }); await host.tracker.tick();
    for (const run of host.store.list<any>('run')) await completed(host, run.id); expect(calls).toHaveLength(2);
    host.store.update<Tracking>('tracking', subscription.id, row => { row.nextAt = '2000-01-01T00:00:00.000Z'; }); await host.tracker.tick();
    for (const run of host.store.list<any>('run')) await completed(host, run.id); expect(new Set(calls).size).toBe(4); expect(host.store.list<any>('run').every(run => run.kind === 'source_check')).toBe(true);
    const current = host.store.get<Tracking>('tracking', subscription.id); const other = host.leader.createSpace({ name: '另一主体', kind: 'company' }); const alien = host.leader.sources.create(other.id, { name: '其他来源', kind: 'page', url: 'https://public.test/alien', scope: 'space' }); expect(() => host.tracker.update(host.space.id, current.id, { version: current.version, sourceIds: [alien.id] })).toThrow(/主体|事项/);
  } finally { await host.close(); }
});
