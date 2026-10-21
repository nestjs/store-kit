import type { StoreMigration } from './store-migration.interface.js';

/**
 * What a store's `createError` receives besides the message: the package's schema error carries it.
 *
 * ```ts
 * export class OutboxSchemaError extends OutboxError {
 *   constructor(message: string, details: StoreSchemaErrorDetails) {
 *     super(message, details.cause === undefined ? undefined : { cause: details.cause });
 *     this.schema = details.schema;
 *     this.version = details.version;
 *     this.requiredVersion = details.requiredVersion;
 *   }
 * }
 * ```
 */
export interface StoreSchemaErrorDetails {
  /** The store's schema (on PostgreSQL the schema of its tables, on MySQL the start of their names). */
  schema: string;
  /** The schema's version: the last migration applied to it, `0` for none. */
  version: number;
  /** The version the store needs: its last migration. */
  requiredVersion: number;
  /** What failed, when applying the migrations did. */
  cause?: unknown;
}

/**
 * What `new StoreSchema()` takes: the store's names, which every message, the CLI and the migration lock use, and its
 * migrations.
 *
 * ```ts
 * export const outboxSchema = new StoreSchema({
 *   packageName: '@nestjs/outbox',
 *   storeName: 'PostgresOutboxStore',
 *   command: 'nest-outbox',
 *   defaultSchema: 'nest_outbox',
 *   migrations: [initialMigration],
 *   createError: (message, details) => new OutboxSchemaError(message, details),
 * });
 * ```
 */
export interface StoreSchemaOptions {
  /**
   * The package the store ships in, as users install it (`'@nestjs/outbox'`). Messages name it, the store lives at its
   * `/postgres` (or `/mysql`) subpath, and it keys the migration lock: `<packageName>:migrate:<schema>`. The usage and
   * the messages tell users to run the package's command as `npx <packageName>`.
   */
  packageName: string;
  /** The store's class (`'PostgresOutboxStore'`): messages start with it, and name its `migrationSql()`. */
  storeName: string;
  /** The package's bin (`'nest-outbox'`), built on `runStoreCli()`: its only one, so that `npx <packageName>` runs it. */
  command: string;
  /** The schema the store's tables live in unless the application names another (`'nest_outbox'`). */
  defaultSchema: string;
  /** Every version of the schema, in order: 1, 2, 3... A new one goes last, and none ever changes once released. */
  migrations: readonly StoreMigration[];
  /**
   * The package's own error for a schema that can't serve: behind the store's migrations, or failing to apply them
   * (`details.cause`). The kit never checks it with `instanceof`: two copies of the kit can share one application.
   */
  createError(message: string, details: StoreSchemaErrorDetails): Error;
}
