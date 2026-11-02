import { createHash } from 'node:crypto';
import type { SqlExecutor, SqlTransaction } from '../interfaces/mysql-executor.interface.js';
import { tableName } from './identifiers.js';
import { retryOnDeadlock } from './retry-on-deadlock.js';

/** The rows `ensureLockRows()` reads or creates a statement: well under Prisma's 65,535 placeholders. */
const ROWS_PER_STATEMENT = 1_000;

/**
 * Locks `keys` until the transaction ends: MySQL's counterpart of PostgreSQL's `advisoryLock()`
 * (`pg_advisory_xact_lock`), on rows of the kit's `<schema>_locks` table, which every store's schema has (so two
 * stores, or two schemas of one, never share a lock). `GET_LOCK()` can't serve inside a transaction: it's held by the
 * session, past the transaction's end. A key's row is its SHA-256 (`lockRowId()`), so any key fits and two keys never
 * share one; the rows are taken in the order of those ids, each once, so two transactions locking overlapping sets
 * can't deadlock. Exclusive locks take two statements for all the keys: the rows ensured (`INSERT ... ON DUPLICATE KEY
 * UPDATE`, which already locks an existing row exclusively), then locked (`SELECT ... FOR UPDATE`). `shared` locks
 * (`LOCK IN SHARE MODE`, MySQL 8's `FOR SHARE` in the spelling MariaDB takes too) exclude exclusive ones, not each
 * other; a key's first lock creates its row, and holds it exclusively even when asked for a shared one.
 *
 * ```ts
 * await retryOnDeadlock(this.executor, async (tx) => {
 *   await lockKeys(tx, this.schema, messages.map((message) => `key:${message.key}`));
 *   // insert the messages: a key's writers take turns until each commits
 * });
 * ```
 *
 * A lock whose row exists never deadlocks the transactions waiting for it. One whose row the locking transaction
 * creates can: if that transaction rolls back while two or more others wait for the new row, MySQL makes them deadlock
 * (one or more fail with 1213), at READ COMMITTED as well as REPEATABLE READ; it's the duplicate-key wait on a rolled
 * back insert, not a gap lock. So a store creates the rows of its fixed keys ahead of time, in a transaction of its own
 * (`ensureLockRows()`), and maps keys without bound (a message's key) onto a fixed set of such rows (the outbox's
 * 16,384 buckets): a key's first lock in the application's transaction then never creates a row.
 */
export async function lockKeys(transaction: SqlTransaction, schema: string, keys: string | readonly string[], options: { shared?: boolean } = {}): Promise<void> {
  const table = tableName(schema, 'locks', 'lockKeys()');
  const ids = idsOf(keys);
  if (ids.length === 0) {
    return;
  }

  const exclusive = async (locked: string[]) => {
    // InnoDB takes a multi-row insert's rows in their order, and a locking read's in its index order.
    await transaction.execute(`INSERT INTO ${table} (id) VALUES ${locked.map(() => '(?)').join(', ')} ON DUPLICATE KEY UPDATE id = id`, locked);
    await transaction.query(`SELECT id FROM ${table} WHERE id IN (${locked.map(() => '?').join(', ')}) ORDER BY id FOR UPDATE`, locked);
  };
  if (!options.shared) {
    await exclusive(ids);
    return;
  }

  // One by one, in the ids' order: a row that doesn't exist yet is created, and locked exclusively, in its turn.
  for (const id of ids) {
    const held = await transaction.query(`SELECT id FROM ${table} WHERE id = ? LOCK IN SHARE MODE`, [id]);
    if (held.length === 0) {
      await exclusive([id]);
    }
  }
}

/**
 * Creates the rows of `keys` in the kit's `<schema>_locks` table ahead of time, so that no transaction that takes them
 * with `lockKeys()` creates one: when the transaction that created a lock's row rolls back while others wait for it,
 * MySQL makes them deadlock (see `lockKeys()`), and a row that exists never does. A store calls it for its fixed lock
 * keys once its schema is ready (the kit's migrations create the table): in `onModuleInit()`, or before a key's first
 * use, never inside the application's transaction.
 *
 * It takes the executor: the rows it creates commit at once, in transactions of its own (READ COMMITTED, run again on
 * a deadlock), at most 1,000 a statement. Rows that exist are only noted, by a read that takes no lock, so a process
 * that starts while another holds one of the locks doesn't wait for it. Idempotent: processes that ensure the same
 * keys at once create each row once.
 *
 * ```ts
 * async onModuleInit(): Promise<void> {
 *   await this.readiness.ready();
 *   await ensureLockRows(this.executor, this.schema, ['signals']); // before any transaction locks it
 * }
 * ```
 */
export async function ensureLockRows(executor: SqlExecutor, schema: string, keys: string | readonly string[]): Promise<void> {
  const table = tableName(schema, 'locks', 'ensureLockRows()');
  if (typeof (executor as { transaction?: unknown } | null)?.transaction !== 'function') {
    throw new TypeError("ensureLockRows() takes the store's executor, not a transaction: it creates the rows in transactions of its own, which commit at once.");
  }

  const missing: string[] = [];
  for (const chunk of chunked(idsOf(keys))) {
    const found = await executor.query<{ id: string }>(`SELECT CAST(id AS CHAR) AS id FROM ${table} WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
    const existing = new Set(found.map((row) => row.id));
    missing.push(...chunk.filter((id) => !existing.has(id)));
  }

  for (const chunk of chunked(missing)) {
    // Sorted: processes creating overlapping rows at once take them in one order.
    await retryOnDeadlock(executor, (tx) =>
      tx.execute(`INSERT INTO ${table} (id) VALUES ${chunk.map(() => '(?)').join(', ')} ON DUPLICATE KEY UPDATE id = id`, chunk),
    );
  }
}

/**
 * The id of `key`'s row in the kit's `<schema>_locks` table (`lockKeys()`, `ensureLockRows()`): the key's SHA-256, 64
 * hex characters. For a store's tests, or a store that reads its lock rows.
 *
 * ```ts
 * expect(rows.map((row) => row.id)).toEqual(['signals', 'concurrency:w1'].map(lockRowId).sort());
 * ```
 */
export function lockRowId(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The rows of `keys`, each once, in the order `lockKeys()` takes them. */
function idsOf(keys: string | readonly string[]): string[] {
  return [...new Set((typeof keys === 'string' ? [keys] : keys).map(lockRowId))].sort();
}

function chunked(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += ROWS_PER_STATEMENT) {
    chunks.push(ids.slice(start, start + ROWS_PER_STATEMENT));
  }
  return chunks;
}
