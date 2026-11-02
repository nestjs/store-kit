/**
 * A MySQL store's options and readiness through StoreSchema (tests/fixtures/notes' MySQL store): the options checked
 * with messages that name the store (an executor of another dialect, or without execute(), included) and defaulted by
 * NODE_ENV; readiness that migrates once for calls that arrive together, or fails while the schema is behind and tries
 * again at the next call; the server and connection checked first (MySQL, not MariaDB or PostgreSQL; 8.0.19 or later;
 * a strict sql_mode; a current database), on the store's connections and on the command line's paths alike; and the
 * first call in the application's transaction checked through it, on a pool of one connection.
 */
import mysql from 'mysql2/promise';
import pg from 'pg';
import { fromMysql2, StoreSchema, type SqlExecutor, type SqlTransaction } from '../../lib/mysql/index.js';
import { fromPg } from '../../lib/postgres/index.js';
import { NoteSchemaError } from '../fixtures/notes/note.schema.js';
import { mysqlNoteSchema, mysqlNoteSchemaOptions } from '../fixtures/notes/mysql-note.schema.js';
import { MySqlNoteStore } from '../fixtures/notes/mysql-note.store.js';
import { onMysql, recording, testDatabase } from './support.js';

const { database, reason } = await testDatabase('readiness');
const pools: mysql.Pool[] = [];

// Each test's pools end with it: the server may be shared, and a file's pools would otherwise add up.
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

const pool = (options: mysql.PoolOptions = {}) => {
  const opened = mysql.createPool({ uri: database!.url, connectionLimit: 2, ...options });
  pools.push(opened);
  return opened;
};

const tables = async (schema: string) =>
  ((await database!.admin.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, ?) = ?', [schema.length + 1, `${schema}_`]))[0] as unknown[]).length;

/** Runs `work` with `NODE_ENV` set to `value` (`undefined`: unset). */
async function withNodeEnv<T>(value: string | undefined, work: () => T | Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  try {
    if (value === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = value;
    }
    return await work();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

/**
 * An executor of a server that answers the check's statements as told, and nothing else. `collation` is MariaDB's
 * `utf8mb4_0900_bin`: NO PAD (11.4.7+, 11.8.2+), an alias of the PAD SPACE `utf8mb4_bin` (11.4.5, 11.8.0-11.8.1), or
 * missing (before 11.4.5).
 */
function fakeServer(
  version: string,
  settings: { sql_mode: string; current_database: string | null } = { sql_mode: 'STRICT_TRANS_TABLES', current_database: 'shop' },
  collation: 'no pad' | 'pad' | 'missing' = 'no pad',
) {
  const statements: string[] = [];
  const db: SqlTransaction = {
    query: async <R extends object>(text: string) => {
      statements.push(text);
      if (text === 'SELECT VERSION() AS version') {
        return [{ version }] as R[];
      }
      if (text.includes('COLLATE utf8mb4_0900_bin')) {
        if (collation === 'missing') {
          throw Object.assign(new Error("Unknown collation: 'utf8mb4_0900_bin'"), { errno: 1273, sqlState: 'HY000', sqlMessage: "Unknown collation: 'utf8mb4_0900_bin'" });
        }
        return [{ padded: collation === 'pad' ? '1' : '0' }] as R[];
      }
      if (text.includes('@@session.sql_mode')) {
        return [settings] as R[];
      }
      throw new Error(`the fake server has no answer to: ${text}`);
    },
    execute: async () => ({ affectedRows: 0 }),
  };
  const executor: SqlExecutor = { dialect: 'mysql', ...db, execute: db.execute, transaction: (work) => work(db), wrapTransaction: () => db } as SqlExecutor;
  return { executor, statements };
}

describe('the MySQL StoreSchema.resolveOptions()', () => {
  // Nothing connects: a pool opens its connections at the first statement.
  const executor = fromMysql2(mysql.createPool({ host: '127.0.0.1', port: 1, connectionLimit: 1 }));

  it('checks the executor, its dialect, migrate and the schema, with messages that name the store', () => {
    expect(() => mysqlNoteSchema.resolveOptions({ executor: {} as SqlExecutor })).toThrow(
      'MySqlNoteStore: `executor` must be a SqlExecutor, such as fromMysql2(pool), fromDrizzle(db), fromTypeOrm(dataSource), fromPrisma(prisma) or fromKysely(db).',
    );
    const postgres = fromPg(new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' }));
    expect(() => mysqlNoteSchema.resolveOptions({ executor: postgres as never })).toThrow(
      "MySqlNoteStore runs on MySQL, and `executor` is a PostgreSQL executor: import the executor from '@nestjs/notes/mysql' (fromMysql2, fromDrizzle, fromTypeOrm, fromPrisma or fromKysely).",
    );
    const withoutExecute = { dialect: 'mysql', query: executor.query, transaction: executor.transaction, wrapTransaction: executor.wrapTransaction } as SqlExecutor;
    expect(() => mysqlNoteSchema.resolveOptions({ executor: withoutExecute })).toThrow('MySqlNoteStore: `executor` must be a SqlExecutor, such as fromMysql2(pool)');
    const unmarked = { query: executor.query, execute: executor.execute, transaction: executor.transaction, wrapTransaction: executor.wrapTransaction } as unknown as SqlExecutor;
    expect(() => mysqlNoteSchema.resolveOptions({ executor: unmarked })).toThrow(
      "MySqlNoteStore: `executor` doesn't say which database it runs on: a SqlExecutor has a `dialect` ('mysql' for MySQL).",
    );

    expect(() => mysqlNoteSchema.resolveOptions({ executor, migrate: 'yes' as never })).toThrow('MySqlNoteStore: `migrate` must be true or false, not "yes".');
    expect(() => mysqlNoteSchema.resolveOptions({ executor, schema: 'Shop_Notes' })).toThrow(
      'MySqlNoteStore: invalid schema "Shop_Notes". Use lowercase letters, digits and underscores, not starting with a digit, at most 40 characters',
    );
    expect(mysqlNoteSchema.resolveOptions({ executor, schema: 'shop_notes', migrate: false })).toEqual({ executor, schema: 'shop_notes', migrate: false });
  });

  it("defaults to the store's schema, and migrate to on except when NODE_ENV is production", async () => {
    expect(await withNodeEnv('production', () => mysqlNoteSchema.resolveOptions({ executor }))).toEqual({ executor, schema: 'nest_notes', migrate: false });
    expect(await withNodeEnv('development', () => mysqlNoteSchema.resolveOptions({ executor }).migrate)).toBe(true);
    expect(await withNodeEnv(undefined, () => mysqlNoteSchema.resolveOptions({ executor }).migrate)).toBe(true);
  });
});

describe('the server and connection a MySQL store runs on', () => {
  it("refuses MariaDB for a store that doesn't opt in, before any SQL of its own, on the store's paths and the command line's (version(), migrate()) alike", async () => {
    const mysqlOnly = new StoreSchema({ ...mysqlNoteSchemaOptions, mariadb: undefined });
    const refused = "MySqlNoteStore runs on MySQL, and this server is MariaDB (11.8.9-MariaDB-ubu2404): MariaDB isn't supported yet.";
    const { executor, statements } = fakeServer('11.8.9-MariaDB-ubu2404');
    await expect(mysqlOnly.readiness({ ...mysqlOnly.resolveOptions({ executor }) }).ready()).rejects.toThrow(refused);
    await expect(mysqlOnly.migrate(executor, 'nest_notes')).rejects.toThrow(refused);
    await expect(mysqlOnly.version(executor, 'nest_notes')).rejects.toThrow(refused);
    await expect(mysqlOnly.assertMigrated(executor, 'nest_notes')).rejects.toThrow(refused);
    expect(new Set(statements)).toEqual(new Set(['SELECT VERSION() AS version']));
    expect(() => new StoreSchema({ ...mysqlNoteSchemaOptions, mariadb: 'yes' as never })).toThrow("MySqlNoteStore's StoreSchema: `mariadb` must be a boolean, not \"yes\".");
  });

  it("refuses a MariaDB whose utf8mb4_0900_bin is missing (before 11.4.5) or pads (11.4.5, 11.8.0-11.8.1), before any SQL of its own, on every path", async () => {
    for (const [version, collation, problem] of [
      ['11.4.4-MariaDB-ubu2404', 'missing', "doesn't have it"],
      ['11.4.5-MariaDB-ubu2404', 'pad', 'pads it, so abc and "abc " would be the same key'],
    ] as const) {
      const refused = `MySqlNoteStore runs on MySQL 8.4 LTS and 9.x, and on MariaDB 11.4.7 and later or 11.8.2 and later, where utf8mb4_0900_bin compares without padding, and this server (${version}) ${problem}.`;
      const { executor, statements } = fakeServer(version, undefined, collation);
      const store = new MySqlNoteStore({ executor });
      await expect(store.onModuleInit()).rejects.toThrow(refused);
      await expect(store.addInTransaction({}, { id: 'n-1', body: 'hello', createdAt: 1 })).rejects.toThrow(refused);
      await expect(mysqlNoteSchema.migrate(executor, 'nest_notes')).rejects.toThrow(refused);
      await expect(mysqlNoteSchema.version(executor, 'nest_notes')).rejects.toThrow(refused);
      await expect(mysqlNoteSchema.assertMigrated(executor, 'nest_notes')).rejects.toThrow(refused);
      expect(new Set(statements)).toEqual(new Set(['SELECT VERSION() AS version', "SELECT CAST(_utf8mb4'abc' = _utf8mb4'abc ' COLLATE utf8mb4_0900_bin AS CHAR) AS padded"]));
    }
  });

  it("refuses a server that isn't MySQL or MariaDB and a MySQL older than 8.0.19; takes 8.0.19 and later, Aurora's versions, and MariaDB with a NO PAD utf8mb4_0900_bin", async () => {
    await expect(new MySqlNoteStore({ executor: fakeServer('PostgreSQL 18.6 (Debian 18.6-1.pgdg13+1) on aarch64-unknown-linux-gnu').executor }).onModuleInit()).rejects.toThrow(
      'MySqlNoteStore runs on MySQL or MariaDB, and this server is PostgreSQL 18.6.',
    );
    const mysqlOnly = new StoreSchema({ ...mysqlNoteSchemaOptions, mariadb: false });
    await expect(mysqlOnly.version(fakeServer('PostgreSQL 18.6 (Debian 18.6-1.pgdg13+1) on aarch64-unknown-linux-gnu').executor, 'nest_notes')).rejects.toThrow(
      'MySqlNoteStore runs on MySQL, and this server is PostgreSQL 18.6.',
    );
    for (const version of ['5.7.44', '8.0.18', '5.7.mysql_aurora.2.11.2']) {
      await expect(mysqlNoteSchema.version(fakeServer(version).executor, 'nest_notes')).rejects.toThrow(
        `MySqlNoteStore runs on MySQL 8.4 LTS and 9.x (8.0.19 and later may work), and this server is MySQL ${version}.`,
      );
    }
    for (const version of ['8.0.19', '8.0.43-0ubuntu0.22.04.1', '8.4.6', '9.7.0', '8.0.mysql_aurora.3.05.2', '11.4.7-MariaDB-ubu2404', '11.8.9-MariaDB-ubu2404', '12.1.2-MariaDB']) {
      // Past the check, the fake server has no answer to the version's own query.
      await expect(mysqlNoteSchema.version(fakeServer(version).executor, 'nest_notes')).rejects.toThrow('the fake server has no answer to: SELECT CAST(COUNT(*) AS CHAR)');
    }
  });

  it("reports the server its check found in the readiness's server, once ready", async () => {
    for (const [version, server] of [
      ['8.4.6', 'mysql'],
      ['11.8.9-MariaDB-ubu2404', 'mariadb'],
    ] as const) {
      const { executor } = fakeServer(version);
      const readiness = mysqlNoteSchema.readiness({ ...mysqlNoteSchema.resolveOptions({ executor, migrate: false }) });
      expect(readiness.server).toBeUndefined();
      // Past the check, the schema's version can't be read from the fake server: the check found the server.
      await expect(readiness.ready()).rejects.toThrow('the fake server has no answer to');
      expect(readiness.server).toBe(server);
    }
  });

  it('refuses a connection without a strict sql_mode or a database, before creating anything', async () => {
    const lax = fakeServer('9.7.0', { sql_mode: 'NO_ENGINE_SUBSTITUTION', current_database: 'shop' });
    await expect(new MySqlNoteStore({ executor: lax.executor }).onModuleInit()).rejects.toThrow(
      'MySqlNoteStore needs a strict sql_mode (STRICT_TRANS_TABLES, MySQL\'s default), and this connection\'s is "NO_ENGINE_SUBSTITUTION": without it, MySQL cuts a value too long for its column, ' +
        "and writes a default for a missing one, with only a warning. Set it back for the server, or for the store's connections (a pool of their own).",
    );
    await expect(mysqlNoteSchema.migrate(fakeServer('9.7.0', { sql_mode: 'STRICT_ALL_TABLES', current_database: null }).executor, 'nest_notes')).rejects.toThrow(
      "MySqlNoteStore keeps its tables in the connection's database, and this connection has none: name one in the pool's or the ORM's settings (its database, or the URL's path).",
    );
  });

  describe('on MySQL', () => {
    onMysql(reason);

    it('refuses a real connection whose session sql_mode is lax, and one without a database', async () => {
      const lax = pool({ connectionLimit: 1 });
      lax.on('connection', (connection) => {
        connection.query("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'");
      });
      const store = new MySqlNoteStore({ executor: fromMysql2(lax), schema: 'r_lax' });
      await expect(store.onModuleInit()).rejects.toThrow('MySqlNoteStore needs a strict sql_mode');
      expect(await tables('r_lax')).toBe(0);

      const url = new URL(database!.url);
      url.pathname = '/';
      const nowhere = mysql.createPool({ uri: url.toString(), connectionLimit: 1 });
      pools.push(nowhere);
      await expect(new MySqlNoteStore({ executor: fromMysql2(nowhere) }).onModuleInit()).rejects.toThrow("MySqlNoteStore keeps its tables in the connection's database");
    });
  });
});

describe('the MySQL StoreSchema.readiness()', () => {
  onMysql(reason);

  it('migrates once for the calls that arrive together, reports it to the logger, and then costs nothing', async () => {
    const recorder = recording(fromMysql2(pool({ connectionLimit: 4 })));
    const store = new MySqlNoteStore({ executor: recorder.executor, schema: 'r_together', migrate: true });
    expect(await Promise.all(Array.from({ length: 5 }, (_, i) => store.get(`n-${i}`)))).toEqual([null, null, null, null, null]);
    expect(store.logged).toEqual(['MySqlNoteStore: migrated schema "r_together" to version 2.']);
    expect(recorder.statements.filter((statement) => statement.text.includes('GET_LOCK'))).toHaveLength(1);

    recorder.statements.length = 0;
    await store.get('n-1');
    expect(recorder.statements.map((statement) => statement.text)).toEqual([expect.stringMatching(/^SELECT CAST\(`n`\.`id` AS CHAR\) AS `id`/)]);
  });

  it("fails while the schema is behind with migrate off, with the package's error, changing nothing, and tries again at the next call", async () => {
    const behind = new MySqlNoteStore({ executor: fromMysql2(pool()), schema: 'r_behind', migrate: false });
    const error = await behind.onModuleInit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoteSchemaError);
    expect(error).toMatchObject({ schema: 'r_behind', version: 0, requiredVersion: 2 });
    await expect(behind.get('any')).rejects.toThrow(NoteSchemaError);
    expect(await tables('r_behind')).toBe(0);

    await mysqlNoteSchema.migrate(fromMysql2(pool()), 'r_behind');
    expect(await behind.get('any')).toBeNull();
  });

  it('migrate() applies the pending migrations whatever migrate says, and reports what it applied', async () => {
    const store = new MySqlNoteStore({ executor: fromMysql2(pool()), schema: 'r_explicit', migrate: false });
    expect(await store.migrate()).toEqual([1, 2]);
    expect(await store.migrate()).toEqual([]);
    expect(store.logged).toEqual(['MySqlNoteStore: migrated schema "r_explicit" to version 2.']);
    await expect(store.onModuleInit()).resolves.toBeUndefined();
  });

  it("checks a first call inside the application's transaction through it, on a pool of one connection, and can't migrate in it", async () => {
    const one = pool({ connectionLimit: 1 });
    const executor = fromMysql2(one);
    const inTransaction = async <T>(work: (connection: mysql.PoolConnection) => Promise<T>) => {
      const connection = await one.getConnection();
      try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    };

    const note = { id: 'n-1', body: 'hello', createdAt: 1 };
    const unmigrated = new MySqlNoteStore({ executor, schema: 'r_first_call' });
    await expect(inTransaction((connection) => unmigrated.addInTransaction(connection, note))).rejects.toThrow(
      'MySqlNoteStore: schema "r_first_call" is at version 0, and this version of @nestjs/notes needs version 2. ' +
        "The store applies its migrations when the application starts (onModuleInit), or at its first call outside a transaction: it can't apply them in yours.",
    );
    expect(unmigrated.logged).toEqual([]);

    await new MySqlNoteStore({ executor, schema: 'r_first_call' }).migrate();
    const fresh = new MySqlNoteStore({ executor, schema: 'r_first_call' });
    expect(await inTransaction((connection) => fresh.addInTransaction(connection, note))).toBe(true);
    expect(await fresh.get('n-1')).toMatchObject({ body: 'hello', archived: false });
  });
});
