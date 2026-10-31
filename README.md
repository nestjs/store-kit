<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[travis-image]: https://api.travis-ci.org/nestjs/nest.svg?branch=master
[travis-url]: https://travis-ci.org/nestjs/nest
[linux-image]: https://img.shields.io/travis/nestjs/nest/master.svg?label=linux
[linux-url]: https://travis-ci.org/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore"><img src="https://img.shields.io/npm/dm/@nestjs/core.svg" alt="NPM Downloads" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec"><img src="https://img.shields.io/badge/Donate-PayPal-dc3d53.svg"/></a>
  <a href="https://twitter.com/nestframework"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

The building blocks of the first-party SQL stores that [Nest](https://github.com/nestjs/nest)'s packages ship (`PostgresWorkflowStore` in `@nestjs/workflows/postgres`, and more to come, on PostgreSQL and MySQL): executors that run a store's SQL through the client the application already has (node-postgres or mysql2, Drizzle, TypeORM, Prisma, Kysely) and join its transactions, a store's versioned migrations with their SQL and its command line, the readiness a store awaits before its statements, and helpers for writing them.

Applications don't install or import it: a package depends on it, and its `/postgres` and `/mysql` subpaths re-export the executors and their types.

## Installation

For a package that ships a store, as a regular dependency (never a peer, so the kit's patch releases dedupe across an application's packages):

```bash
$ npm i --save @nestjs/store-kit
```

## Entries

- `@nestjs/store-kit`: what every dialect shares: the executor types (`SqlExecutor`, `SqlTransaction`, `SqlTransactionOptions`, `SqlIsolationLevel`, `SqlExecuteResult`, `SqlDialect`), `isNotATransactionError()` (an executor's refusal of an object that isn't a transaction, by its code `ERR_SQL_NOT_A_TRANSACTION`), the readers of a column's text (`toText`/`toInt`/`toBool`/`toJson`) and `runStoreCli()`, a package's command. `SqlExecutor<'postgres'>` and `SqlExecutor<'mysql'>` are each dialect's executors (what the executors return, and what a store's options take): the root's `SqlExecutor` alone is either, and `/postgres`'s and `/mysql`'s `SqlExecutor` (with their `StoreOptions`) are their dialect's.
- `@nestjs/store-kit/postgres`: the executors (`fromPg`, `fromDrizzle`, `fromTypeOrm`, `fromPrisma`, `fromKysely`, and `isNotATransactionError()`), `StoreSchema` (migrations, their SQL, a store's options and readiness), the statement helpers (`SqlParams`, `columns`, `toText`/`toInt`/`toBool`/`toJson`, `quoteSchema`, `advisoryLock`) and `assertReadCommittedTransaction()`.
- `@nestjs/store-kit/mysql`: the same for MySQL 8.4 LTS and 9.x, and MariaDB 11.4 LTS and later: the executors (`fromMysql2`, `fromDrizzle`, `fromTypeOrm`, `fromPrisma`, `fromKysely`, and `isNotATransactionError()`), `StoreSchema` (a store's tables in the connection's database as `<schema>_<table>`, migrations applied statement by statement under `GET_LOCK()` and resumed where a failed run stopped), and the statement helpers (`SqlParams`, `columns`, `toText`/`toInt`/`toBool`/`toJson`, `quoteIdentifier`, `quoteTable`, `keyColumn`, `lockKeys`, `ensureLockRows`, `lockRowId`, `retryOnDeadlock`, `mysqlErrorCode`).
- `@nestjs/store-kit/testing`: `sqlExecutorContract()`, for an executor of another client.

A `SqlTransaction` carries the client's own transaction object as its `native` (the node-postgres client or mysql2 connection in its transaction, Drizzle's `tx`, TypeORM's `EntityManager`, Prisma's transaction client, Kysely's `Transaction`): the object `wrapTransaction()` takes, and gives back (`wrapTransaction(x).native === x`). So a store that opens a transaction (`executor.transaction()`) can hand it to the application's code, whose writes through the client's own API land in that transaction. Every executor of the kit sets it; it's optional in `SqlTransaction`, and `sqlExecutorContract()` checks it where an executor sets it. On PostgreSQL, which ends a transaction at its first failed statement, work that caught the error of a statement it sent through `native` is rejected, nothing committed, as it is for one sent through `query()`: `fromPg()` reads its COMMIT's reply, at no cost, and the other executors send one statement at the end of work that read `native`.

## A store in brief

```ts
export const outboxSchema = new StoreSchema({
  packageName: '@nestjs/outbox',
  storeName: 'PostgresOutboxStore',
  command: 'nest-outbox',
  defaultSchema: 'nest_outbox',
  migrations: [initialMigration], // { version: 1, name: 'initial', up: (s) => [`CREATE TABLE ${s}.messages (...)`] }
  createError: (message, details) => new OutboxSchemaError(message, details),
});

export class PostgresOutboxStore implements OutboxStore, OnModuleInit {
  static migrationSql(options?: MigrationSqlOptions): string {
    return outboxSchema.sql(options);
  }

  static readonly schemaVersion = outboxSchema.latest;

  private readonly executor: SqlExecutor;
  private readonly readiness: StoreReadiness;

  constructor(options: PostgresOutboxStoreOptions, storage?: OutboxStorage) {
    const resolved = outboxSchema.resolveOptions(options); // { executor, schema, migrate }, checked
    this.executor = resolved.executor;
    this.readiness = outboxSchema.readiness({ ...resolved, logger: new Logger('OutboxModule') });
    storage?.registerSource({ messages: this, inbox: this });
  }

  onModuleInit(): Promise<void> {
    return this.readiness.ready(); // migrates (or checks) the schema before the workers start
  }

  migrate(): Promise<number[]> {
    return this.readiness.migrate();
  }
}
```

The package's bin (`nest-outbox`), which users run as `npx @nestjs/outbox migrate|status|sql`:

```ts
#!/usr/bin/env node
import { runStoreCli } from '@nestjs/store-kit';
import { outboxSchema } from './outbox.schema.js';

process.exitCode = await runStoreCli([outboxSchema], process.argv.slice(2));
```

## Tests

`npm run test:e2e` runs the suite on PGlite, and on PostgreSQL through every executor: `SQL_TEST_PG_URL` (`docker compose up -d` starts one on port 55432), else a throwaway cluster from local PostgreSQL binaries, else those tests are skipped with the reason. The MySQL tests (a vitest project of their own, two files at a time, after the PostgreSQL ones) run on `SQL_TEST_MYSQL_URL` (`mysql://root:<password>@127.0.0.1:3306`), else they are skipped with the reason. Test databases are named `skit_<host>_...` on both servers and swept when their process is gone.

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](LICENSE).
