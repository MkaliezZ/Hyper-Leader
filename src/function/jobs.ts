import type { Json, Run } from '../../shared/types.js';
import { Store } from '../asset/store.js';
import { AppError, errorText, invariant } from '../../server/errors.js';
export class Jobs {
  private live = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(readonly store: Store) { for (const run of store.list<Run>('run').filter(row => row.status === 'running' || row.status === 'not_started')) { store.update<Run>('run', run.id, row => { row.status = 'interrupted'; row.error = '程序重启，中断状态已保留；请重新核对输入后继续。'; row.finishedAt = new Date().toISOString(); row.question = undefined; }); } }
  create(spaceId: string, caseId: string | undefined, kind: Run['kind'], authority: string, extra: Partial<Run> = {}) { return this.store.create<Run>('run', { spaceId, caseId, kind, status: 'not_started', stage: 'intake', usage: { input: 0, output: 0, cacheRead: 0 }, evidenceRefs: [], artifactIds: [], authority, limits: {}, ...extra }); }
  start(run: Run, work: (signal: AbortSignal) => Promise<void>) {
    if (this.live.size >= 6) { this.store.update<Run>('run', run.id, row => { row.status = 'failed'; row.error = '已达并行读取上限，本轮没有开始。'; row.finishedAt = new Date().toISOString(); }); throw new AppError(429, '当前读取或分析作业较多，请稍后重试。', 'BUSY'); } const controller = new AbortController();
    this.store.update<Run>('run', run.id, row => { row.status = 'running'; row.startedAt = new Date().toISOString(); }); this.event(run.id, 'intake', '任务已开始');
    const promise = (async () => {
      try { await work(controller.signal); if (!controller.signal.aborted) { this.store.update<Run>('run', run.id, row => { row.status = 'succeeded'; row.stage = 'deliver'; row.finishedAt = new Date().toISOString(); row.question = undefined; }); this.event(run.id, 'deliver', '本轮执行已结束；业务与人工评议分别记录'); } }
      catch (error) { if (!controller.signal.aborted) { const text = errorText(error); this.store.update<Run>('run', run.id, row => { row.status = 'failed'; row.error = text; row.finishedAt = new Date().toISOString(); row.question = undefined; }); this.event(run.id, 'failed', text); } }
      finally { this.live.delete(run.id); }
    })();
    this.live.set(run.id, { controller, promise }); return this.store.get<Run>('run', run.id);
  }
  event(runId: string, stage: string, label: string, detail?: Json) { this.store.update<Run>('run', runId, row => { row.stage = stage; }); this.store.event(runId, 'progress', { stage, label, detail }); }
  active(id: string) { return this.live.has(id); }
  signal(id: string) { return this.live.get(id)?.controller.signal; }
  async cancel(id: string) { const run = this.store.get<Run>('run', id); if (!['running', 'not_started'].includes(run.status)) return run; this.live.get(id)?.controller.abort(); this.store.update<Run>('run', id, row => { row.status = 'cancelled'; row.finishedAt = new Date().toISOString(); row.question = undefined; row.error = '用户已停止本轮；已保存的资料和成果保留。'; }); this.store.event(id, 'terminal', { status: 'cancelled' }); return this.store.get<Run>('run', id); }
  async close() { const tasks = [...this.live.values()]; for (const task of tasks) task.controller.abort(); for (const run of this.store.list<Run>('run').filter(row => row.status === 'running')) this.store.update<Run>('run', run.id, row => { row.status = 'interrupted'; row.finishedAt = new Date().toISOString(); row.error = '服务已停止，未宣称作业成功。'; row.question = undefined; }); await Promise.allSettled(tasks.map(task => task.promise)); }
}
