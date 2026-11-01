// The `@nestjs/store-kit/mysql` entry: what a first-party MySQL store is built on. Applications don't import it: a
// package's `/mysql` subpath re-exports the executors and their types. Nothing here imports a driver or an ORM: the
// executors reach the client the application passes them.

// Executors: a store's SQL through the application's pool or ORM, and its transactions (`SqlExecutor<'mysql'>`), and
// their refusal of an object that isn't a transaction they can join, by its code
export { fromDrizzle, fromKysely, fromMysql2, fromPrisma, fromTypeOrm } from './executors/index.js';
export type { PrismaExecutorOptions } from '../postgres/executors/prisma.executor.js';
export type { SqlExecutor, SqlTransaction } from './interfaces/index.js';
export type { SqlExecuteResult, SqlIsolationLevel, SqlTransactionOptions } from '../interfaces/index.js';
export { isNotATransactionError } from '../sql/index.js';

// A store's schema: its versioned migrations and their SQL, the store's options, and its readiness
export { StoreSchema } from './schema/index.js';
export type { MySqlServer, MySqlStoreReadiness, ResolvedStoreOptions, StoreMigration, StoreOptions, StoreReadinessOptions, StoreSchemaOptions } from './interfaces/index.js';
export type { MigrationSqlOptions, MigrationStatementsOptions, StoreReadiness, StoreSchemaErrorDetails } from '../interfaces/index.js';

// A store's statements: parameters as text with casts, columns read as text, identifiers and tables quoted, key
// columns, transaction-scoped locks (and their rows, created ahead of time), the deadlock retry of a store's own
// transactions, MySQL's error numbers
export {
  columns,
  ensureLockRows,
  keyColumn,
  lockKeys,
  lockRowId,
  mysqlErrorCode,
  quoteIdentifier,
  quoteTable,
  retryOnDeadlock,
  SqlParams,
  toBool,
  toInt,
  toJson,
  toText,
} from './sql/index.js';
