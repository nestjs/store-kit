/**
 * The MySQL executors: the executor contract (`@nestjs/store-kit/testing`) through each of them (and through
 * fromMysql2() on a single connection), the words of their refusals, and each client's particulars: what each takes as
 * the application's client and transaction object (another database's refused, a connection outside a transaction
 * refused before it writes), the FOUND_ROWS client flag, placeholders that don't match their params, Kysely's plugins,
 * Prisma's transaction limits. The same executors' errors carry MySQL's error number through `mysqlErrorCode()`.
 */
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { CamelCasePlugin, Kysely, MysqlDialect, PostgresDialect, SqliteDialect, sql } from 'kysely';
import mysqlCallbacks from 'mysql2';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { fromDrizzle, fromKysely, fromMysql2, fromPrisma, fromTypeOrm, isNotATransactionError, lockKeys, mysqlErrorCode } from '../../lib/mysql/index.js';
import { fromDrizzle as fromPgDrizzle, fromKysely as fromPgKysely, fromTypeOrm as fromPgTypeOrm } from '../../lib/postgres/index.js';
import { sqlExecutorContract } from '../../lib/testing/index.js';
import { PrismaClient } from '../fixtures/prisma-mysql/generated/client.js';
import { clients, mariadbConfig, onMysql, singleConnectionClient, testDatabase, type Client } from './support.js';

const { database, reason } = await testDatabase('executors');

const targets = [...clients, singleConnectionClient].map((factory) => ({ name: `${factory.name} on MySQL`, open: () => factory.open(database!.url) }));

describe.each(targets)('$name', ({ open }) => {
  let client: Client;

  beforeAll(async () => {
    if (!reason) {
      client = await open();
    }
  });
  afterAll(() => client?.close());
  onMysql(reason);

  for (const c of sqlExecutorContract(() => ({ executor: client.executor, transaction: (work) => client.transaction(work), root: client.root }))) {
    it(c.name, c.run);
  }

  it('is a MySQL executor, and says what to pass instead of the database, pool or client, or of anything else', async () => {
    expect(client.executor.dialect).toBe('mysql');
    await expect((async () => client.executor.wrapTransaction(client.root).execute('DO 0'))()).rejects.toThrow(
      /^(Pass the .* not |The mysql2 connection isn't in a transaction)/,
    );
    expect(() => client.executor.wrapTransaction({})).toThrow(/^Pass the .* got an object\.$/);
  });

  it("refuses them with a TypeError whose code a store recognizes (ERR_SQL_NOT_A_TRANSACTION), a connection's at its first statement", async () => {
    for (const notATransaction of [client.root, {}, undefined]) {
      // Refused at once, or (a mysql2 connection outside a transaction) by its first statement, before it writes.
      const refusal = await (async () => client.executor.wrapTransaction(notATransaction).execute('DO 0'))().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(TypeError);
      expect(refusal).toMatchObject({ name: 'TypeError', code: 'ERR_SQL_NOT_A_TRANSACTION' });
      expect(isNotATransactionError(refusal)).toBe(true);
    }

    // A statement's own mistake in a transaction the executor joined is no refusal of the transaction: no code.
    const mistake = await client
      .transaction((tx) => client.executor.wrapTransaction(tx).query('SELECT ? AS a, ? AS b', ['one']))
      .catch((error: unknown) => error);
    expect(mistake).toBeInstanceOf(TypeError);
    expect(isNotATransactionError(mistake)).toBe(false);
  });

  it("hands its transactions' work the client's own transaction object as native, and gives the application's back as it was given", async () => {
    expect(await client.executor.transaction(async (tx) => client.isNative(tx.native))).toBe(true);
    await client.transaction(async (tx) => {
      expect(client.isNative(tx)).toBe(true);
      expect(client.executor.wrapTransaction(tx).native).toBe(tx);
    });
  });

  it('refuses a statement whose ? placeholders and params differ, before it runs', async () => {
    await expect(client.executor.query('SELECT ? AS a, ? AS b', ['one'])).rejects.toThrow(
      "A MySQL statement's ? placeholders must match its params: this one has 2 placeholders and 1 param (a ? in a literal or a comment counts too).",
    );
    await expect(client.executor.execute("UPDATE orders SET status = 'what?' WHERE id = ?", ['o-1'])).rejects.toThrow('this one has 2 placeholders and 1 param');
    await expect(client.executor.query('SELECT ?? FROM orders', ['id'])).rejects.toThrow("A MySQL statement can't hold ??");
  });

  it('locks keys through this client: several exclusive ones in two statements, and shared ones', async () => {
    const schema = `lk${targets.findIndex((target) => target.name === `${client.name} on MySQL`)}`;
    await client.executor.execute(`CREATE TABLE IF NOT EXISTS ${schema}_locks (id char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY)`);
    await client.executor.transaction(async (tx) => {
      await lockKeys(tx, schema, ['k:b', 'k:a', 'k:b']);
      await lockKeys(tx, schema, ['k:a', 'k:c'], { shared: true });
    });
    expect(await client.executor.query(`SELECT CAST(COUNT(*) AS CHAR) AS n FROM ${schema}_locks`)).toEqual([{ n: '3' }]);
  });

  it("reads an AUTO_INCREMENT id with LAST_INSERT_ID() in the insert's transaction, which keeps to its connection", async () => {
    const table = `serials_${client.name.replace(/\W+/g, '_').toLowerCase()}`.slice(0, 60);
    await client.executor.execute(`CREATE TABLE IF NOT EXISTS ${table} (id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, name varchar(32) NOT NULL)`);
    const ids = await client.executor.transaction(async (tx) => {
      const read = async () => (await tx.query<{ id: string }>('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id'))[0]!.id;
      await tx.execute(`INSERT INTO ${table} (name) VALUES (?)`, ['first']);
      const first = await read();
      await tx.execute(`INSERT INTO ${table} (name) VALUES (?)`, ['second']);
      return [first, await read()];
    });
    expect(await client.executor.query(`SELECT CAST(id AS CHAR) AS id, name FROM ${table} ORDER BY ${table}.id`)).toEqual([
      { id: ids[0], name: 'first' },
      { id: ids[1], name: 'second' },
    ]);
    await client.executor.execute(`DROP TABLE ${table}`);
  });

  it("surfaces MySQL's error number, a duplicate key's in the application's transaction too, which goes on and commits", async () => {
    const duplicate = await client.executor.execute("INSERT INTO orders (id, status) VALUES (?, 'placed'), (?, 'placed')", ['dup', 'dup']).catch((e: unknown) => e);
    expect(mysqlErrorCode(duplicate)).toBe(1062);
    expect(mysqlErrorCode(await client.executor.query('SELECT * FROM no_such_table').catch((e: unknown) => e))).toBe(1146);

    const id = `${client.name}-after-duplicate`;
    await client.transaction(async (tx) => {
      const joined = client.executor.wrapTransaction(tx);
      await joined.execute("INSERT INTO orders (id, status) VALUES (?, 'placed')", [id]);
      const again = await joined.execute("INSERT INTO orders (id, status) VALUES (?, 'placed')", [id]).catch((e: unknown) => e);
      expect(mysqlErrorCode(again)).toBe(1062);
      // A failed statement doesn't abort a MySQL transaction: the next one runs in it.
      expect(await joined.execute("UPDATE orders SET status = 'paid' WHERE id = ?", [id])).toEqual({ affectedRows: 1 });
    });
    expect(await client.executor.query('SELECT status FROM orders WHERE id = ?', [id])).toEqual([{ status: 'paid' }]);
    expect(mysqlErrorCode(new Error('not MySQL'))).toBeUndefined();
  });
});

describe('the clients each executor takes', () => {
  onMysql(reason);

  it('fromMysql2() takes a pool or a connection of either API, joins a connection in a transaction, and refuses PostgreSQL clients', async () => {
    const pool = mysql.createPool({ uri: database!.url, connectionLimit: 2 });
    const callbacks = mysqlCallbacks.createPool({ uri: database!.url, connectionLimit: 1 });
    const connection = await pool.getConnection();
    try {
      expect(await fromMysql2(callbacks as never).query('SELECT ? AS one', ['1'])).toEqual([{ one: '1' }]);
      const executor = fromMysql2(pool);
      expect(() => executor.wrapTransaction(pool)).toThrow('not the pool: it runs each statement on any of its connections, outside your transaction.');
      await expect(executor.wrapTransaction(connection).execute("INSERT INTO orders (id, status) VALUES ('idle', 'placed')")).rejects.toThrow(
        "The mysql2 connection isn't in a transaction: call beginTransaction() on it first, or each statement commits on its own.",
      );
      expect(await database!.admin.query("SELECT id FROM orders WHERE id = 'idle'").then(([rows]) => rows)).toEqual([]);

      await connection.beginTransaction();
      expect(await executor.wrapTransaction(connection).query('SELECT ? AS one', ['1'])).toEqual([{ one: '1' }]);
      expect(await executor.wrapTransaction(connection.connection).query('SELECT ? AS one', ['1'])).toEqual([{ one: '1' }]);
      // The native is the connection as it was given, of either API.
      expect(executor.wrapTransaction(connection).native).toBe(connection);
      expect(executor.wrapTransaction(connection.connection).native).toBe(connection.connection);
      await connection.rollback();

      // A callback-API pool's transaction hands out a callback-API connection (the application's kind): its own.
      const native = await fromMysql2(callbacks as never).transaction(async (tx) => {
        const own = tx.native as mysqlCallbacks.PoolConnection;
        const [row] = await new Promise<Array<{ id: unknown }>>((resolve, reject) =>
          own.query('SELECT CONNECTION_ID() AS id', (error: unknown, rows: never) => (error ? reject(error) : resolve(rows))),
        );
        expect(await tx.query('SELECT CONNECTION_ID() AS id')).toEqual([{ id: row!.id }]);
        return own;
      });
      expect(native).toBeInstanceOf(mysqlCallbacks.PoolConnection);
      const single = mysqlCallbacks.createConnection({ uri: database!.url });
      try {
        expect(await fromMysql2(single as never).transaction(async (tx) => tx.native === single)).toBe(true);
      } finally {
        await new Promise((resolve) => single.end(resolve));
      }

      const pgPool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
      expect(() => fromMysql2(pgPool as never)).toThrow(
        "fromMysql2() takes a mysql2 pool or connection, not a node-postgres one: a PostgreSQL store takes that, through fromPg() from its package's /postgres subpath.",
      );
      expect(() => executor.wrapTransaction(new pg.Client())).toThrow("not a node-postgres client: the store's statements run on MySQL.");
      expect(() => fromMysql2({} as never)).toThrow('fromMysql2() takes a mysql2 pool or connection (mysql2/promise), got an object.');
      await pgPool.end();
    } finally {
      connection.release();
      await pool.end();
      await new Promise((resolve) => callbacks.end(resolve));
    }
  });

  it('fromMysql2(), fromDrizzle() and fromTypeOrm() refuse a client without the FOUND_ROWS flag, which counts the rows an UPDATE changed', async () => {
    const message = "needs mysql2's FOUND_ROWS client flag, which it sets by default: without it, an UPDATE counts the rows it changed instead of the rows it matched.";
    const changedRows = mysql.createPool({ uri: database!.url, connectionLimit: 1, flags: ['-FOUND_ROWS'] });
    try {
      // What the flag changes: the same UPDATE, on a pool with it and one without.
      await database!.admin.query("INSERT INTO orders (id, status) VALUES ('found-rows', 'placed')");
      const [[matched], [changed]] = await Promise.all([
        database!.admin.query<mysql.ResultSetHeader>("UPDATE orders SET status = 'placed' WHERE id = 'found-rows'"),
        changedRows.query<mysql.ResultSetHeader>("UPDATE orders SET status = 'placed' WHERE id = 'found-rows'"),
      ]);
      expect([matched.affectedRows, changed.affectedRows]).toEqual([1, 0]);

      expect(() => fromMysql2(changedRows)).toThrow(`fromMysql2() ${message}`);
      expect(() => fromDrizzle(drizzleMysql(changedRows))).toThrow(`fromDrizzle() ${message}`);
      const dataSource = new DataSource({ type: 'mysql', url: database!.url, flags: ['-FOUND_ROWS'] });
      expect(() => fromTypeOrm(dataSource)).toThrow(`fromTypeOrm() ${message}`);
    } finally {
      await changedRows.end();
    }
  });

  it('fromDrizzle() takes a Drizzle MySQL database, not its tx or a PostgreSQL one, and joins only a MySQL transaction', async () => {
    const pool = mysql.createPool({ uri: database!.url, connectionLimit: 2 });
    const pgPool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    try {
      const db = drizzleMysql(pool);
      await db.transaction(async (tx) => {
        expect(() => fromDrizzle(tx as never)).toThrow('fromDrizzle() takes the database drizzle() returns, not a transaction');
      });
      const postgres = drizzlePg(pgPool);
      expect(() => fromDrizzle(postgres as never)).toThrow(
        "fromDrizzle() takes a Drizzle MySQL database (drizzle() of drizzle-orm/mysql2), not a PostgreSQL one: a PostgreSQL store takes that, through fromDrizzle() from its package's /postgres subpath.",
      );
      expect(() => fromPgDrizzle(db as never)).toThrow('fromDrizzle() takes a Drizzle PostgreSQL database (drizzle() of drizzle-orm/node-postgres, /pglite...), got a MySql2Database.');
      expect(() => fromDrizzle({} as never)).toThrow('fromDrizzle() takes a Drizzle MySQL database (drizzle() of drizzle-orm/mysql2), got an object.');

      const executor = fromDrizzle(db);
      expect(() => executor.wrapTransaction(db)).toThrow('Pass the tx your db.transaction() callback receives, not the database');
      class PgTransaction {}
      Object.assign(PgTransaction, { [Symbol.for('drizzle:entityKind')]: 'PgTransaction' });
      expect(() => executor.wrapTransaction(new PgTransaction())).toThrow("Pass the tx of a Drizzle MySQL database, not of a PostgreSQL one: the store's statements run on MySQL.");
    } finally {
      await pool.end();
      await pgPool.end();
    }
  });

  it("fromTypeOrm() takes a MySQL or MariaDB DataSource or its manager, not a transaction's manager or PostgreSQL, and joins only a MySQL or MariaDB transaction", async () => {
    const typeorm = await clients[2]!.open(database!.url);
    try {
      const manager = typeorm.root as { connection: unknown };
      expect(await fromTypeOrm(manager as never).query('SELECT ? AS one', ['1'])).toEqual([{ one: '1' }]);
      await typeorm.transaction(async (tx) => {
        expect(() => fromTypeOrm(tx as never)).toThrow("fromTypeOrm() takes the DataSource (or its manager), not a transaction's manager");
      });
      const other = (type: string) => ({ '@instanceof': Symbol.for('DataSource'), createQueryRunner() {}, options: { type } });
      expect(() => fromTypeOrm(other('postgres') as never)).toThrow("fromTypeOrm() takes a DataSource of type 'mysql' or 'mariadb', not 'postgres'.");
      expect(() => fromTypeOrm(other('mariadb') as never)).not.toThrow('takes a DataSource of type');
      expect(() => fromPgTypeOrm(manager.connection as never)).toThrow("fromTypeOrm() takes a DataSource of type 'postgres', not 'mysql'.");

      // A QueryRunner of the application's, after startTransaction().
      const runner = (manager.connection as { createQueryRunner(): any }).createQueryRunner();
      await runner.startTransaction();
      expect(await typeorm.executor.wrapTransaction(runner).query('SELECT ? AS one', ['1'])).toEqual([{ one: '1' }]);
      // The native is what was given: the runner, or its manager.
      expect(typeorm.executor.wrapTransaction(runner).native).toBe(runner);
      expect(typeorm.executor.wrapTransaction(runner.manager).native).toBe(runner.manager);
      await runner.rollbackTransaction();
      expect(() => typeorm.executor.wrapTransaction(runner)).toThrow('Pass the EntityManager your dataSource.transaction() callback receives');
      await runner.release();

      const postgres = other('postgres');
      const pgManager = { '@instanceof': Symbol.for('EntityManager'), connection: postgres, queryRunner: { isTransactionActive: true, connection: postgres, query() {} } };
      expect(() => typeorm.executor.wrapTransaction(pgManager)).toThrow(
        "Pass the EntityManager of a DataSource of type 'mysql' or 'mariadb', not 'postgres': the store's statements run on MySQL or MariaDB.",
      );
    } finally {
      await typeorm.close();
    }
  });

  it('fromPrisma() takes the client, not a transaction client, and gives its own transactions the limits asked for', async () => {
    const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...mariadbConfig(database!.url), connectionLimit: 2 }) });
    try {
      await prisma.$transaction(async (tx) => {
        expect(() => fromPrisma(tx as never)).toThrow('fromPrisma() takes the Prisma client, not a transaction client');
      });
      expect(() => fromPrisma({} as never)).toThrow('fromPrisma() takes a Prisma client, got an object.');

      const hurried = fromPrisma(prisma, { timeout: '500ms' });
      await expect(hurried.transaction((tx) => tx.query('SELECT SLEEP(1) AS slept'))).rejects.toThrow(/timeout|expired|closed/i);
      expect(await fromPrisma(prisma).transaction((tx) => tx.query('SELECT CAST(SLEEP(1) AS CHAR) AS slept'))).toEqual([{ slept: '0' }]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("fromKysely() takes the Kysely instance, not a transaction, and runs the store's statements without its plugins, not its transactions' native", async () => {
    const db = new Kysely<object>({ dialect: new MysqlDialect({ pool: mysqlCallbacks.createPool({ uri: database!.url, connectionLimit: 2 }) }), plugins: [new CamelCasePlugin()] });
    try {
      const executor = fromKysely(db);
      expect(await executor.query('SELECT ? AS lease_until', ['1'])).toEqual([{ lease_until: '1' }]);
      expect(await executor.transaction((tx) => tx.query('SELECT ? AS lease_until', ['1']))).toEqual([{ lease_until: '1' }]);
      // The native is the application's trx, plugins and all, on the connection of the store's statements.
      const [native, store] = await executor.transaction(async (tx) => [
        (await sql<object>`SELECT ${'1'} AS lease_until, CONNECTION_ID() AS connection_id`.execute(tx.native as Kysely<object>)).rows,
        await tx.query('SELECT CONNECTION_ID() AS connection_id'),
      ]);
      expect(native).toEqual([{ leaseUntil: '1', connectionId: (store[0] as { connection_id: unknown }).connection_id }]);
      await db.transaction().execute(async (trx) => {
        expect(await executor.wrapTransaction(trx).query('SELECT ? AS lease_until', ['1'])).toEqual([{ lease_until: '1' }]);
        expect(() => fromKysely(trx as never)).toThrow('fromKysely() takes the Kysely instance, not a transaction');
      });
      expect(() => fromKysely({} as never)).toThrow('fromKysely() takes a Kysely instance, got an object.');
    } finally {
      await db.destroy();
    }
  });
});

describe('fromKysely() and another database', () => {
  // Nothing connects: Kysely opens its pool at the first query.
  const unreachable = async () => {
    throw new Error('no database here');
  };

  it("refuses a Kysely instance whose dialect is Kysely's PostgreSQL or SQLite one, and a transaction of it, as the PostgreSQL executor refuses MySQL", () => {
    const postgres = new Kysely<object>({ dialect: new PostgresDialect({ pool: unreachable as never }) });
    const sqlite = new Kysely<object>({ dialect: new SqliteDialect({ database: unreachable as never }) });
    expect(() => fromKysely(postgres as never)).toThrow('fromKysely() takes a Kysely instance with a MySQL dialect, not a PostgreSQL one.');
    expect(() => fromKysely(sqlite as never)).toThrow('fromKysely() takes a Kysely instance with a MySQL dialect, not a SQLite one.');

    const mysqlDb = new Kysely<object>({ dialect: new MysqlDialect({ pool: unreachable as never }) });
    const executor = fromKysely(mysqlDb as never);
    const pgTrx = { isTransaction: true, executeQuery() {}, withoutPlugins() {}, getExecutor: () => postgres.getExecutor() };
    expect(() => executor.wrapTransaction(pgTrx)).toThrow('Pass the trx of a Kysely instance with a MySQL dialect, not a PostgreSQL one');
    expect(() => fromPgKysely(mysqlDb as never)).toThrow('fromKysely() takes a Kysely instance with a PostgreSQL dialect, not a MySQL one.');
  });
});

describe("the code of a MySQL executor's refusal of anything but a transaction", () => {
  // Nothing connects: the pools open their connections at the first query.
  const unreachable = async () => {
    throw new Error('no database here');
  };

  it("is on its refusal of another dialect's transaction too, and on no other TypeError", async () => {
    const pool = mysql.createPool({ host: '127.0.0.1', port: 1, connectionLimit: 1 });
    try {
      const postgres = new Kysely<object>({ dialect: new PostgresDialect({ pool: unreachable as never }) });
      const kysely = fromKysely(new Kysely<object>({ dialect: new MysqlDialect({ pool: unreachable as never }) }) as never);
      class PgTransaction {}
      Object.assign(PgTransaction, { [Symbol.for('drizzle:entityKind')]: 'PgTransaction' });
      class MySql2Database {
        execute() {}
        transaction() {}
      }
      Object.assign(MySql2Database, { [Symbol.for('drizzle:entityKind')]: 'MySql2Database' });
      const pgSource = { '@instanceof': Symbol.for('DataSource'), createQueryRunner() {}, options: { type: 'postgres' } };
      const source = { '@instanceof': Symbol.for('DataSource'), createQueryRunner() {}, transaction() {}, options: { type: 'mysql' } };
      const refusals = [
        () => fromMysql2(pool).wrapTransaction(pool),
        () => fromMysql2(pool).wrapTransaction(new pg.Client()),
        () => fromDrizzle(new MySql2Database() as never).wrapTransaction(new PgTransaction()),
        () => kysely.wrapTransaction({ isTransaction: true, executeQuery() {}, withoutPlugins() {}, getExecutor: () => postgres.getExecutor() }),
        () => fromTypeOrm(source as never).wrapTransaction({ '@instanceof': Symbol.for('EntityManager'), connection: pgSource, queryRunner: { isTransactionActive: true, connection: pgSource } }),
        () => fromPrisma({ $queryRawUnsafe() {}, $executeRawUnsafe() {}, $transaction() {}, $connect() {} } as never).wrapTransaction({ $connect() {}, $queryRawUnsafe() {} }),
      ];
      for (const refusal of refusals) {
        let error: unknown;
        try {
          refusal();
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ name: 'TypeError', code: 'ERR_SQL_NOT_A_TRANSACTION' });
      }

      // The executors' other TypeErrors are about their own arguments: no code.
      for (const misuse of [() => fromMysql2({} as never), () => fromKysely(postgres as never), () => fromTypeOrm(pgSource as never)]) {
        expect(misuse).toThrow(TypeError);
        try {
          misuse();
        } catch (error) {
          expect(isNotATransactionError(error)).toBe(false);
        }
      }
    } finally {
      await pool.end();
    }
  });
});
