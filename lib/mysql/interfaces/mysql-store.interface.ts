import type { ResolvedStoreOptions as AnyResolvedStoreOptions, StoreOptions as AnyStoreOptions } from '../../interfaces/store-options.interface.js';
import type { StoreReadiness, StoreReadinessOptions as AnyStoreReadinessOptions } from '../../interfaces/store-readiness.interface.js';
import type { StoreSchemaOptions as AnyStoreSchemaOptions } from '../../interfaces/store-schema-options.interface.js';
import type { SqlExecutor } from './mysql-executor.interface.js';

/**
 * The options every first-party MySQL store takes (`new MySqlOutboxStore({ executor, schema, migrate }, storage)`),
 * which `StoreSchema.resolveOptions()` checks. A store's own options interface may add more.
 *
 * ```ts
 * export interface MySqlOutboxStoreOptions extends StoreOptions {
 *   // the store's own options, if any
 * }
 * ```
 */
export interface StoreOptions extends AnyStoreOptions<'mysql'> {
  /**
   * How the store reaches the database: a MySQL executor, such as `fromMysql2(pool)`, `fromDrizzle(db)`,
   * `fromTypeOrm(dataSource)`, `fromPrisma(prisma)` or `fromKysely(db)` from the store's `/mysql` subpath. The store's
   * tables live in its connections' database (the one the pool or ORM connects to); its own transactions run on it,
   * and methods that take the application's transaction take that client's transaction object.
   */
  executor: SqlExecutor;
  /**
   * The name the store's tables start with, in the connection's database: `<schema>_<table>` (`nest_outbox`:
   * `nest_outbox_messages`, `nest_outbox_migrations`...). Keep it for the store alone. Lowercase letters, digits and
   * underscores, not starting with a digit, at most 40 characters. Default: the store's (`nest_<package>`).
   */
  schema?: string;
}

/**
 * `StoreSchema.resolveOptions()`'s result: the options checked, with their defaults.
 *
 * ```ts
 * const { executor, schema, migrate } = outboxSchema.resolveOptions(options);
 * ```
 */
export interface ResolvedStoreOptions extends AnyResolvedStoreOptions<'mysql'> {
  executor: SqlExecutor;
  /** The schema's name, checked: name the store's tables with `quoteTable(schema, 'messages', storeName)`. */
  schema: string;
}

/**
 * What `StoreSchema.readiness()` takes: the store's resolved options, and where a migration is reported.
 *
 * ```ts
 * this.readiness = outboxSchema.readiness({ ...outboxSchema.resolveOptions(options), logger: this.logger });
 * ```
 */
export interface StoreReadinessOptions extends AnyStoreReadinessOptions<'mysql'> {
  executor: SqlExecutor;
}

/**
 * One version of a MySQL store's schema: its DDL, for the table names `t()` gives. Migrations only ever add (tables,
 * nullable or defaulted columns, indexes): in a rolling deploy, the processes of the previous version keep running on
 * the migrated schema. Downgrades aren't supported.
 *
 * ```ts
 * const initial: StoreMigration = {
 *   version: 1,
 *   name: 'initial',
 *   up: (t) => [
 *     `CREATE TABLE ${t('messages')} (
 *   id ${keyColumn(255)} NOT NULL PRIMARY KEY,
 *   payload json NOT NULL,
 *   created_at bigint NOT NULL
 * )`,
 *     `CREATE INDEX messages_created ON ${t('messages')} (created_at, id)`,
 *   ],
 * };
 * ```
 */
export interface StoreMigration {
  /** 1, 2, 3...: the schema's version once it's applied. */
  version: number;
  /** Recorded with the version: letters, digits and underscores (`initial`, `delivery_attempts`). */
  name: string;
  /**
   * Its statements: DDL only (CREATE, ALTER, DROP, RENAME), one per string, each applied and recorded on its own, as
   * MySQL commits every DDL statement by itself. `t('messages')` is the store's table, quoted (`` `nest_outbox_messages` ``).
   * Name no constraint (MySQL names foreign keys and checks per database, so a second schema of the store would
   * collide); index names are per table.
   */
  up(t: (table: string) => string): string[];
}

/**
 * What `new StoreSchema()` from `@nestjs/store-kit/mysql` takes: the store's names, which every message, the CLI and
 * the migration lock use, and its migrations.
 *
 * ```ts
 * export const outboxSchema = new StoreSchema({
 *   packageName: '@nestjs/outbox',
 *   storeName: 'MySqlOutboxStore',
 *   command: 'nest-outbox',
 *   defaultSchema: 'nest_outbox',
 *   migrations: [initialMigration],
 *   createError: (message, details) => new OutboxSchemaError(message, details),
 * });
 * ```
 */
export interface StoreSchemaOptions extends Omit<AnyStoreSchemaOptions, 'migrations'> {
  /** Every version of the schema, in order: 1, 2, 3... A new one goes last, and none ever changes once released. */
  migrations: readonly StoreMigration[];
  /**
   * Whether the store runs on MariaDB too, where `utf8mb4_0900_bin` is MySQL's NO PAD binary collation (11.4.7 and
   * later, 11.8.2 and later). Off by default: a store turns it on once its own suite runs on MariaDB, and until then
   * refuses it.
   */
  mariadb?: boolean;
}

/** The server a MySQL store found its connection on. */
export type MySqlServer = 'mysql' | 'mariadb';

/**
 * What `StoreSchema.readiness()` returns on MySQL: the readiness every store awaits, and the server its check found,
 * for a statement that has to differ between MySQL and MariaDB.
 *
 * ```ts
 * await this.readiness.readyIn(tx);
 * const batchLength = this.readiness.server === 'mariadb' ? MARIADB_BATCH_LENGTH : BATCH_LENGTH;
 * ```
 */
export interface MySqlStoreReadiness extends StoreReadiness {
  /** The server the last successful check found: `undefined` until `ready()` or `readyIn()` resolves. */
  readonly server: MySqlServer | undefined;
}
