/**
 * The MySQL error number of `error`, whichever client raised it, or `undefined` for an error that isn't MySQL's (a
 * lost connection, a `TypeError`). mysql2 and Kysely throw mysql2's error (`errno`), TypeORM a `QueryFailedError` with
 * the same `errno`, Drizzle a `DrizzleQueryError` whose `cause` is mysql2's, and Prisma a
 * `PrismaClientKnownRequestError` whose `meta.driverAdapterError.cause.originalCode` holds it. The ones a store meets:
 *
 * - `1062` (ER_DUP_ENTRY): a duplicate key. The statement is rolled back, not the transaction, which goes on: the
 *   insert-if-absent of a MySQL store catches it (never `INSERT IGNORE`, which turns other errors into warnings).
 * - `1213` (ER_LOCK_DEADLOCK): the whole transaction was rolled back to break a deadlock. `retryOnDeadlock()` runs a
 *   store's own transaction again; in the application's transaction, the store rethrows it.
 * - `1205` (ER_LOCK_WAIT_TIMEOUT): the statement waited too long for a lock, and only it was rolled back.
 * - `1020` (ER_CHECKREAD), MariaDB's only: with `innodb_snapshot_isolation` on (the default since MariaDB 11.6.2), a
 *   REPEATABLE READ transaction's locking read, or insert, met a row another transaction committed since its snapshot,
 *   where MySQL reads the latest committed row (and reports a duplicate key as `1062`). The statement is rolled back,
 *   not the transaction; MariaDB's advice is to run the transaction again. A store's own transactions are READ
 *   COMMITTED, where it never arises.
 *
 * ```ts
 * try {
 *   await tx.execute(`INSERT INTO ${t.inbox} (id, received_at) VALUES (${p.text(id)}, ${p.bigint(now)})`, p.values);
 *   return true;
 * } catch (error) {
 *   if (mysqlErrorCode(error) === 1062) {
 *     return false; // received before
 *   }
 *   throw error;
 * }
 * ```
 */
export function mysqlErrorCode(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth++) {
    const candidate = current as {
      errno?: unknown;
      sqlMessage?: unknown;
      sqlState?: unknown;
      meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
      driverError?: unknown;
      cause?: unknown;
    };
    // mysql2's and the mariadb connector's server errors: a positive errno with the server's message or SQLSTATE (a
    // lost connection has a negative errno from the operating system, and neither).
    if (typeof candidate.errno === 'number' && candidate.errno > 0 && (candidate.sqlMessage !== undefined || candidate.sqlState !== undefined)) {
      return candidate.errno;
    }

    const original = candidate.meta?.driverAdapterError?.cause?.originalCode;
    if (typeof original === 'string' && /^\d+$/.test(original)) {
      return Number(original);
    }
    current = candidate.driverError ?? candidate.cause;
  }
  return undefined;
}
