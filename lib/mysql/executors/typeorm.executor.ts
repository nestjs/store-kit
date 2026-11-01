import type { SqlExecuteResult, SqlTransactionOptions } from '../../interfaces/sql-executor.interface.js';
import { notATransaction } from '../../sql/not-a-transaction.js';
import { describeValue, hasMethod, isolationSql } from '../../utils/executor.util.js';
import type { SqlExecutor, SqlTransaction } from '../interfaces/mysql-executor.interface.js';
import { assertFoundRows, checkPlaceholders, mysql2Flags } from './mysql-client.util.js';

/** The part of a TypeORM `QueryRunner` the executor uses. */
export interface TypeOrmMySqlQueryRunnerLike {
  query(query: string, parameters?: any[], useStructuredResult?: boolean): Promise<any>;
  readonly isTransactionActive: boolean;
  release(): Promise<void>;
}

/** The part of a TypeORM `DataSource` the executor uses. */
export interface TypeOrmMySqlDataSourceLike {
  createQueryRunner(): TypeOrmMySqlQueryRunnerLike;
  transaction<T>(work: (manager: any) => Promise<T>): Promise<T>;
  transaction<T>(isolationLevel: any, work: (manager: any) => Promise<T>): Promise<T>;
  readonly options: { readonly type: string };
}

/** The part of a TypeORM `EntityManager` the executor uses. */
export interface TypeOrmMySqlEntityManagerLike {
  readonly connection: TypeOrmMySqlDataSourceLike;
  readonly queryRunner?: TypeOrmMySqlQueryRunnerLike;
}

const DATA_SOURCE = Symbol.for('DataSource');
const ENTITY_MANAGER = Symbol.for('EntityManager');

/**
 * A `SqlExecutor` on a TypeORM `DataSource` of type `'mysql'` or `'mariadb'` (or its `manager`). The transaction object is the
 * `EntityManager` that `dataSource.transaction()` hands its callback, or a `QueryRunner` (or its `manager`) after
 * `startTransaction()`. A DataSource whose mysql2 pool lacks the `FOUND_ROWS` client flag (on by default; `flags`
 * option) is refused: a store's `execute()` counts the rows an UPDATE matched.
 *
 * ```ts
 * const executor = fromTypeOrm(dataSource); // a first-party store's `executor` option
 *
 * await dataSource.transaction(async (manager) => {
 *   await manager.save(OrderEntity, order);
 *   // What a store does with the { transaction: manager } you pass it: its writes commit or roll back with yours
 *   await executor.wrapTransaction(manager).execute('INSERT INTO audit (order_id) VALUES (?)', [order.id]);
 * });
 * ```
 */
export function fromTypeOrm(dataSource: TypeOrmMySqlDataSourceLike | TypeOrmMySqlEntityManagerLike): SqlExecutor {
  const source = isEntityManager(dataSource) ? dataSource.connection : dataSource;
  if (isEntityManager(dataSource) && dataSource.queryRunner?.isTransactionActive) {
    throw new TypeError("fromTypeOrm() takes the DataSource (or its manager), not a transaction's manager: pass that to a store method that takes your transaction ({ transaction: manager }).");
  }
  if (!isDataSource(source)) {
    throw new TypeError(`fromTypeOrm() takes a TypeORM DataSource (or its manager), got ${describeValue(dataSource)}.`);
  }
  if (source.options.type !== 'mysql' && source.options.type !== 'mariadb') {
    throw new TypeError(`fromTypeOrm() takes a DataSource of type 'mysql' or 'mariadb', not '${source.options.type}'.`);
  }

  const options = source.options as { flags?: unknown; extra?: { flags?: unknown } };
  const flags = [options.flags, options.extra?.flags].flatMap((value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []));
  if (flags.some((flag) => String(flag).trim().toUpperCase() === '-FOUND_ROWS')) {
    assertFoundRows(0, 'fromTypeOrm()');
  }
  assertFoundRows(mysql2Flags((source as { driver?: { pool?: unknown } }).driver?.pool), 'fromTypeOrm()');
  return new TypeOrmExecutor(source);
}

class TypeOrmExecutor implements SqlExecutor {
  readonly dialect = 'mysql';

  constructor(private readonly dataSource: TypeOrmMySqlDataSourceLike) {}

  async query<R extends object>(text: string, params: readonly unknown[] = []): Promise<R[]> {
    checkPlaceholders(text, params);
    const runner = this.dataSource.createQueryRunner();
    try {
      return await run<R>(runner, text, params);
    } finally {
      await runner.release();
    }
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<SqlExecuteResult> {
    checkPlaceholders(text, params);
    const runner = this.dataSource.createQueryRunner();
    try {
      return await write(runner, text, params);
    } finally {
      await runner.release();
    }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>, options: SqlTransactionOptions = {}): Promise<T> {
    const inTransaction = (manager: TypeOrmMySqlEntityManagerLike) => work(runnerTransaction(manager.queryRunner!, manager));
    // TypeORM sends SET TRANSACTION ISOLATION LEVEL (the next transaction's alone) before START TRANSACTION.
    return options.isolationLevel ? this.dataSource.transaction(isolationSql(options.isolationLevel), inTransaction) : this.dataSource.transaction(inTransaction);
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    const runner = isEntityManager(transaction) ? transaction.queryRunner : isQueryRunner(transaction) ? transaction : undefined;
    if (!runner?.isTransactionActive) {
      throw notATransaction(
        isEntityManager(transaction) || isQueryRunner(transaction)
          ? 'Pass the EntityManager your dataSource.transaction() callback receives (or a QueryRunner after startTransaction()), not dataSource.manager or a runner outside a transaction: each statement would commit on its own.'
          : `Pass the EntityManager your TypeORM dataSource.transaction() callback receives, got ${describeValue(transaction)}.`,
      );
    }

    const type = (runner as { connection?: { options?: { type?: unknown } } }).connection?.options?.type;
    if (type !== undefined && type !== 'mysql' && type !== 'mariadb') {
      throw notATransaction(`Pass the EntityManager of a DataSource of type 'mysql' or 'mariadb', not '${String(type)}': the store's statements run on MySQL or MariaDB.`);
    }
    return runnerTransaction(runner, transaction);
  }
}

/** Statements on `runner`; `native` is what the application holds: the `EntityManager`, or the `QueryRunner` given. */
function runnerTransaction(runner: TypeOrmMySqlQueryRunnerLike, native: unknown): SqlTransaction {
  return {
    query: <R extends object>(text: string, params: readonly unknown[] = []) => {
      checkPlaceholders(text, params);
      return run<R>(runner, text, params);
    },
    execute: (text: string, params: readonly unknown[] = []) => {
      checkPlaceholders(text, params);
      return write(runner, text, params);
    },
    native,
  };
}

/** The structured result: `records` for a SELECT, `affected` (mysql2's `affectedRows`) for a write. */
async function run<R extends object>(runner: TypeOrmMySqlQueryRunnerLike, text: string, params: readonly unknown[]): Promise<R[]> {
  const result = await runner.query(text, [...params], true);
  return (Array.isArray(result?.records) ? result.records : []) as R[];
}

async function write(runner: TypeOrmMySqlQueryRunnerLike, text: string, params: readonly unknown[]): Promise<SqlExecuteResult> {
  const result = await runner.query(text, [...params], true);
  return { affectedRows: Number(result?.affected ?? 0) };
}

function isDataSource(value: unknown): value is TypeOrmMySqlDataSourceLike {
  return (value as { '@instanceof'?: unknown } | null)?.['@instanceof'] === DATA_SOURCE && hasMethod(value, 'createQueryRunner');
}

function isEntityManager(value: unknown): value is TypeOrmMySqlEntityManagerLike {
  return (value as { '@instanceof'?: unknown } | null)?.['@instanceof'] === ENTITY_MANAGER;
}

function isQueryRunner(value: unknown): value is TypeOrmMySqlQueryRunnerLike & { manager: unknown } {
  return hasMethod(value, 'query') && hasMethod(value, 'startTransaction') && typeof (value as { isTransactionActive?: unknown }).isTransactionActive === 'boolean';
}
