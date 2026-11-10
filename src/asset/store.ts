import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Entity, Json } from '../../shared/types.js';
import { AppError } from '../../server/errors.js';

export class Store {
  readonly db: DatabaseSync;
  readonly events = new EventEmitter();
  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(home, 'leader.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,space_id TEXT,case_id TEXT,version INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS record_scope ON records(kind,space_id,case_id,updated_at);
      CREATE TABLE IF NOT EXISTS versions(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id,version));
      CREATE TABLE IF NOT EXISTS run_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_run ON run_events(run_id,seq);
      CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY,signature TEXT NOT NULL,state TEXT NOT NULL,status INTEGER,body TEXT,created_at TEXT NOT NULL);`);
    this.events.setMaxListeners(100);
  }
  get<T extends Entity>(kind: string, id: string): T { const row = this.db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id) as { payload: string } | undefined; if (!row) throw new AppError(404, '记录不存在。', 'NOT_FOUND'); return JSON.parse(row.payload); }
  maybe<T extends Entity>(kind: string, id: string): T | undefined { try { return this.get<T>(kind, id); } catch (e) { if (e instanceof AppError && e.status === 404) return; throw e; } }
  list<T extends Entity>(kind: string, scope: { spaceId?: string; caseId?: string } = {}): T[] {
    const where = ['kind=?']; const args: string[] = [kind];
    if (scope.spaceId !== undefined) { where.push('space_id=?'); args.push(scope.spaceId); }
    if (scope.caseId !== undefined) { where.push('case_id=?'); args.push(scope.caseId); }
    return (this.db.prepare(`SELECT payload FROM records WHERE ${where.join(' AND ')} ORDER BY created_at,id`).all(...args) as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  create<T extends Entity>(kind: string, data: Omit<T, keyof Entity> & Partial<Entity>): T {
    const now = new Date().toISOString(); const row = { ...data, id: randomUUID(), version: 1, createdAt: now, updatedAt: now } as T;
    return this.transaction(() => { this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(kind, row.id, row.spaceId ?? null, row.caseId ?? null, row.version, JSON.stringify(row), now, now); this.db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(kind, row.id, 1, JSON.stringify(row)); return row; });
  }
  update<T extends Entity>(kind: string, id: string, change: (row: T) => void, expected?: number): T {
    return this.transaction(() => {
      const row = this.get<T>(kind, id); if (expected !== undefined && row.version !== expected) throw new AppError(409, '资料版本已变化，请刷新后重试。', 'VERSION_CONFLICT');
      const immutable = { id: row.id, spaceId: row.spaceId, caseId: row.caseId, createdAt: row.createdAt };
      change(row); Object.assign(row, immutable); row.version++; row.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE records SET version=?,payload=?,updated_at=? WHERE kind=? AND id=?').run(row.version, JSON.stringify(row), row.updatedAt, kind, id);
      this.db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(kind, id, row.version, JSON.stringify(row)); return row;
    });
  }
  history<T extends Entity>(kind: string, id: string): T[] { return (this.db.prepare('SELECT payload FROM versions WHERE kind=? AND id=? ORDER BY version DESC').all(kind, id) as { payload: string }[]).map(row => JSON.parse(row.payload)); }
  at<T extends Entity>(kind: string, id: string, version: number): T { const row = this.db.prepare('SELECT payload FROM versions WHERE kind=? AND id=? AND version=?').get(kind, id, version) as { payload: string } | undefined; if (!row) throw new AppError(404, '版本不存在。'); return JSON.parse(row.payload); }
  private depth = 0;
  transaction<T>(fn: () => T): T { if (this.depth) return fn(); this.db.exec('BEGIN IMMEDIATE'); this.depth++; try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } finally { this.depth--; } }
  event(runId: string, type: string, payload: Json) { const at = new Date().toISOString(); const result = this.db.prepare('INSERT INTO run_events(run_id,at,type,payload) VALUES(?,?,?,?)').run(runId, at, type, JSON.stringify(payload)); const event = { seq: Number(result.lastInsertRowid), runId, at, type, ...payload }; this.events.emit(runId, event); return event; }
  runEvents(runId: string, after = 0) { return (this.db.prepare('SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500').all(runId, after) as any[]).map(row => ({ seq: row.seq, runId, at: row.at, type: row.type, ...JSON.parse(row.payload) })); }
  close() { this.events.removeAllListeners(); this.db.close(); }
}
