import type { SqlExecuteResult, SqlTransactionOptions } from '../../interfaces/sql-executor.interface.js';
import { notATransaction } from '../../sql/not-a-transaction.js';
import { parseDuration } from '../../utils/duration.util.js';
import { describeValue, hasMethod, isolationSql } from '../../utils/executor.util.js';
import type { PrismaExecutorOptions } from '../../postgres/executors/prisma.executor.js';
import type { SqlExecutor, SqlTransaction } from '../interfaces/mysql-executor.interface.js';
import { checkPlaceholders } from './mysql-client.util.js';

/** The part of a Prisma client (or of the transaction client `$transaction()` hands its callback) the executor uses. */
export interface PrismaMySqlClientLike {
  $queryRawUnsafe(query: string, ...values: any[]): PromiseLike<unknown>;
  $executeRawUnsafe(query: string, ...values: any[]): PromiseLike<number>;
}

/** The part of a Prisma client the executor uses. */
export interface PrismaMySqlRootClientLike extends PrismaMySqlClientLike {
  $connect(): Promise<void>;
  $transaction<T>(work: (tx: any) => Promise<T>, options?: { isolationLevel?: any; maxWait?: number; timeout?: number }): Promise<T>;
}

const PRISMA_ISOLATION: Record<string, string> = {
  'READ UNCOMMITTED': 'ReadUncommitted',
  'READ COMMITTED': 'ReadCommitted',
  'REPEATABLE READ': 'RepeatableRead',
  SERIALIZABLE: 'Serializable',
};

/**
 * A `SqlExecutor` on a Prisma client for MySQL (`$queryRawUnsafe()`, `$executeRawUnsafe()` and interactive
 * transactions). Prisma 7 reaches MySQL through the `@prisma/adapter-mariadb` driver adapter, which serves MySQL as
 * well as MariaDB (the stores run on both). The transaction object is the transaction client that
 * `prisma.$transaction(async (tx) => ...)` hands its callback. Prisma ends an interactive transaction that outlasts its
 * `timeout`: yours keep your own settings, the store's take `options`.
 *
 * ```ts
 * const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host, user, password, database, connectionLimit: 10 }) });
 * const executor = fromPrisma(prisma); // a first-party store's `executor` option
 *
 * await prisma.$transaction(async (tx) => {
 *   await tx.order.create({ data: order });
 *   // What a store does with the { transaction: tx } you pass it: its writes commit or roll back with yours
 *   await executor.wrapTransaction(tx).execute('INSERT INTO audit (order_id) VALUES (?)', [order.id]);
 * });
 * ```
 *
 * Keep the adapter's `foundRows` option at its default (`true`): a store's `execute()` counts the rows an UPDATE
 * matched, and the executor can't see the adapter's settings to check.
 */
export function fromPrisma(prisma: PrismaMySqlRootClientLike, options: PrismaExecutorOptions = {}): SqlExecutor {
  if (!hasMethod(prisma, '$queryRawUnsafe') || !hasMethod(prisma, '$transaction') || !hasMethod(prisma, '$connect')) {
    throw new TypeError(
      hasMethod(prisma, '$queryRawUnsafe')
        ? 'fromPrisma() takes the Prisma client, not a transaction client: pass that to a store method that takes your transaction ({ transaction: tx }).'
        : `fromPrisma() takes a Prisma client, got ${describeValue(prisma)}.`,
    );
  }
  return new PrismaExecutor(prisma, { maxWait: parseDuration(options.maxWait ?? '10s'), timeout: parseDuration(options.timeout ?? '1m') });
}

class PrismaExecutor implements SqlExecutor {
  readonly dialect = 'mysql';

  constructor(
    private readonly prisma: PrismaMySqlRootClientLike,
    private readonly limits: { maxWait: number; timeout: number },
  ) {}

  query<R extends object>(text: string, params: readonly unknown[] = []): Promise<R[]> {
    return run<R>(this.prisma, text, params);
  }

  execute(text: string, params: readonly unknown[] = []): Promise<SqlExecuteResult> {
    return write(this.prisma, text, params);
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>, options: SqlTransactionOptions = {}): Promise<T> {
    // The adapter sends SET TRANSACTION ISOLATION LEVEL (the next transaction's alone) before BEGIN.
    return this.prisma.$transaction((tx: PrismaMySqlClientLike) => work(prismaTransaction(tx)), {
      ...this.limits,
      ...(options.isolationLevel ? { isolationLevel: PRISMA_ISOLATION[isolationSql(options.isolationLevel)] } : {}),
    });
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    // A transaction client is the client without $connect() and $disconnect(): Prisma leaves them out of it.
    if (!hasMethod(transaction, '$queryRawUnsafe') || hasMethod(transaction, '$connect')) {
      throw notATransaction(
        hasMethod(transaction, '$connect')
          ? 'Pass the tx your prisma.$transaction(async (tx) => ...) callback receives, not the client: it runs each statement outside your transaction.'
          : `Pass the tx your Prisma $transaction(async (tx) => ...) callback receives, got ${describeValue(transaction)}.`,
      );
    }
    return prismaTransaction(transaction as PrismaMySqlClientLike);
  }
}

function prismaTransaction(tx: PrismaMySqlClientLike): SqlTransaction {
  return {
    query: <R extends object>(text: string, params: readonly unknown[] = []) => run<R>(tx, text, params),
    execute: (text: string, params: readonly unknown[] = []) => write(tx, text, params),
    native: tx,
  };
}

async function run<R extends object>(prisma: PrismaMySqlClientLike, text: string, params: readonly unknown[]): Promise<R[]> {
  checkPlaceholders(text, params);
  return ((await prisma.$queryRawUnsafe(text, ...params)) ?? []) as R[];
}

/** `$executeRawUnsafe()` resolves to the adapter's `affectedRows`. */
async function write(prisma: PrismaMySqlClientLike, text: string, params: readonly unknown[]): Promise<SqlExecuteResult> {
  checkPlaceholders(text, params);
  return { affectedRows: Number(await prisma.$executeRawUnsafe(text, ...params)) };
}
