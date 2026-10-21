/**
 * A store's MySQL schema through StoreSchema (tests/fixtures/notes' MySQL schema): a new database, a rerun, processes
 * migrating at once under GET_LOCK(), statements() and sql() against what migrate() runs, the script applied statement
 * by statement and with drizzle-kit's statement breakpoints through Drizzle's MySQL migrator, a run that failed halfway
 * and one a crash cut off resuming where they stopped, a colliding table, sql_require_primary_key, a schema behind the
 * store and one ahead of it, ranges, schema names, and the definition's own checks.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate as drizzleMigrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';
import { fromMysql2, StoreSchema, type SqlExecutor, type SqlTransaction, type StoreMigration } from '../../lib/mysql/index.js';
import { NoteSchemaError } from '../fixtures/notes/note.schema.js';
import { archiveMigration, initialMigration, mysqlNoteSchema, mysqlNoteSchemaOptions, mysqlNoteSchemaWith } from '../fixtures/notes/mysql-note.schema.js';
import { MySqlNoteStore } from '../fixtures/notes/mysql-note.store.js';
import { clients, onMysql, recording, testDatabase } from './support.js';

const { database, reason } = await testDatabase('migrations');
const pools: mysql.Pool[] = [];

// Each test's pools end with it: the server may be shared, and a file's pools would otherwise add up.
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

/** A pool of its own, as each process has: one connection is all migrate() uses. */
const pool = (options: mysql.PoolOptions = {}) => {
  const opened = mysql.createPool({ uri: database!.url, connectionLimit: 1, ...options });
  pools.push(opened);
  return opened;
};

const rows = async (sql: string, params: unknown[] = []) => (await database!.admin.query(sql, params))[0] as Array<Record<string, unknown>>;

/** The tables whose names start with `<schema>_`. */
const tables = async (schema: string) =>
  (
    await rows('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, ?) = ? ORDER BY TABLE_NAME', [
      schema.length + 1,
      `${schema}_`,
    ])
  ).map((row) => row.name);

/** The DDL a run sent, in order: not the lock, the reads, nor the progress records. */
const ddl = (statements: Array<{ text: string }>) => statements.map((statement) => statement.text).filter((text) => /^(CREATE|ALTER|DROP)\b/.test(text));

/** Everything about a schema's tables that migrations define, with the schema's name taken out, read through `db`. */
async function catalog(db: SqlTransaction, schema: string) {
  const read = (sql: string) => db.query(sql, [schema.length + 1, `${schema}_`]);
  const anonymize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(`${schema}_`, '<schema>_'));
  return anonymize({
    columns: await read(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, CAST(ORDINAL_POSITION AS CHAR) AS position, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
  COLUMN_DEFAULT AS column_default, COLLATION_NAME AS collation_name, COLUMN_KEY AS column_key
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, ?) = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    ),
    indexes: await read(
      `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, CAST(SEQ_IN_INDEX AS CHAR) AS seq, COLUMN_NAME AS column_name, CAST(NON_UNIQUE AS CHAR) AS non_unique
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, ?) = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    ),
    versions: await db.query(`SELECT CAST(version AS CHAR) AS version, name FROM \`${schema}_migrations\` WHERE applied_at IS NOT NULL ORDER BY version`),
  });
}

/** The name migrate() takes GET_LOCK() of: `store-kit:migrate:` and the hash of the database and the lock's key. */
const lockName = (schema: string) =>
  `store-kit:migrate:${createHash('sha256').update(`${database!.name}\u0000@nestjs/notes:migrate:${schema}`).digest('hex').slice(0, 46)}`;

const extraMigration: StoreMigration = { version: 3, name: 'extra', up: (t) => [`CREATE TABLE ${t('extra')} (id int NOT NULL PRIMARY KEY)`] };

/** Three statements, the second of which a test can make fail by taking its table first. */
const threeTables: StoreMigration = {
  version: 3,
  name: 'three_tables',
  up: (t) => [
    `CREATE TABLE ${t('first')} (id int NOT NULL PRIMARY KEY)`,
    `CREATE TABLE ${t('second')} (id int NOT NULL PRIMARY KEY)`,
    `CREATE TABLE ${t('third')} (id int NOT NULL PRIMARY KEY)`,
  ],
};

describe('StoreSchema.migrate() on MySQL', () => {
  onMysql(reason);

  it("creates the kit's tables, the store's, and a record per version on a new database, and applies nothing the second time", async () => {
    const executor = fromMysql2(pool());
    expect(await mysqlNoteSchema.migrate(executor, 'm_fresh')).toEqual([1, 2]);
    expect(await tables('m_fresh')).toEqual(['m_fresh_locks', 'm_fresh_migrations', 'm_fresh_note_tags', 'm_fresh_notes']);
    expect(await rows('SELECT version, name, started, applied, applied_at > 0 AS stamped FROM m_fresh_migrations ORDER BY version')).toEqual([
      { version: 1, name: 'initial', started: 4, applied: 4, stamped: 1 },
      { version: 2, name: 'archive', started: 2, applied: 2, stamped: 1 },
    ]);
    expect(mysqlNoteSchema.latest).toBe(2);
    expect(await mysqlNoteSchema.version(executor, 'm_fresh')).toBe(2);

    const recorder = recording(fromMysql2(pool()));
    expect(await mysqlNoteSchema.migrate(recorder.executor, 'm_fresh')).toEqual([]);
    expect(recorder.statements.some((statement) => statement.text.includes('GET_LOCK'))).toBe(false);
    expect(await rows('SELECT COUNT(*) AS n FROM m_fresh_migrations')).toEqual([{ n: 2 }]);
  });

  it('applies the migrations once when processes migrate together, each on a connection of its own', async () => {
    const applied = await Promise.all(Array.from({ length: 5 }, () => mysqlNoteSchema.migrate(fromMysql2(pool()), 'm_together')));
    expect(applied.filter((versions) => versions.length > 0)).toEqual([[1, 2]]);
    expect(await rows('SELECT version FROM m_together_migrations ORDER BY version')).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('takes GET_LOCK() of the database and <packageName>:migrate:<schema>, waits for whoever holds it, and releases it', async () => {
    const recorder = recording(fromMysql2(pool()));
    await mysqlNoteSchema.migrate(recorder.executor, 'm_locked');
    const taken = recorder.statements.find((statement) => statement.text.includes('GET_LOCK'));
    expect(taken).toEqual({
      text: 'SELECT CAST(GET_LOCK(?, CAST(? AS SIGNED)) AS CHAR) AS taken, CAST(IS_USED_LOCK(?) AS CHAR) AS holder',
      params: [lockName('m_locked'), '600', lockName('m_locked')],
    });
    expect(lockName('m_locked')).toHaveLength(64);
    expect(await rows('SELECT IS_FREE_LOCK(?) AS free', [lockName('m_locked')])).toEqual([{ free: 1 }]);

    const holder = await database!.admin.getConnection();
    try {
      expect((await holder.query('SELECT GET_LOCK(?, 0) AS taken', [lockName('m_held')]))[0]).toEqual([{ taken: 1 }]);
      let settled = false;
      const migrating = mysqlNoteSchema.migrate(fromMysql2(pool()), 'm_held').finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await holder.query('SELECT RELEASE_LOCK(?)', [lockName('m_held')]);
      expect(await migrating).toEqual([1, 2]);
    } finally {
      holder.release();
    }
  });

  it('gives up waiting for a lock whose release was cut off, and names the connection that holds it', async () => {
    const hurried = mysqlNoteSchemaWith([initialMigration, archiveMigration]);
    Object.assign(hurried, { lockWaitSeconds: 1 });
    const holder = await database!.admin.getConnection();
    try {
      await holder.query('SELECT GET_LOCK(?, 0)', [lockName('m_stuck')]);
      const [[{ id }]] = (await holder.query('SELECT CONNECTION_ID() AS id')) as unknown as [[{ id: number }]];
      const error = await hurried.migrate(fromMysql2(pool()), 'm_stuck').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NoteSchemaError);
      expect((error as Error).message).toBe(
        `MySqlNoteStore: migrating schema "m_stuck" from version 0 to 2 waited 1 seconds for its migration lock, which MySQL connection ${id} holds: ` +
          `another process is migrating the schema, or one's release of the lock was cut off (MySQL releases it when that connection closes; KILL ${id} closes it).`,
      );
      expect(await tables('m_stuck')).toEqual([]);
    } finally {
      await holder.query('SELECT RELEASE_LOCK(?)', [lockName('m_stuck')]);
      holder.release();
    }
  });

  it('runs the DDL that statements() lists, one at a time; a database migrated with the script, statement by statement, is the same, and serves', async () => {
    const recorder = recording(fromMysql2(pool()));
    await mysqlNoteSchema.migrate(recorder.executor, 'm_migrated');
    const statements = mysqlNoteSchema.statements({ schema: 'm_migrated' });
    expect(ddl(recorder.statements)).toEqual(statements.filter((statement) => !statement.startsWith('INSERT')));
    expect(statements.filter((statement) => statement.startsWith('INSERT'))).toEqual([
      "INSERT INTO `m_migrated_migrations` (version, name, applied_at) VALUES (1, 'initial', UNIX_TIMESTAMP() * 1000)",
      "INSERT INTO `m_migrated_migrations` (version, name, applied_at) VALUES (2, 'archive', UNIX_TIMESTAMP() * 1000)",
    ]);

    // As a team applies it with its own tool: TypeORM's queryRunner.query() and mysql2 run one statement per call.
    const connection = await database!.admin.getConnection();
    try {
      for (const statement of MySqlNoteStore.migrationStatements({ schema: 'm_script' })) {
        await connection.query(statement);
      }
    } finally {
      connection.release();
    }
    const executor = fromMysql2(pool());
    expect(await catalog(executor, 'm_script')).toEqual(await catalog(executor, 'm_migrated'));

    const store = new MySqlNoteStore({ executor, schema: 'm_script', migrate: false });
    await expect(store.onModuleInit()).resolves.toBeUndefined();
    expect(await store.add({ id: 'n-1', body: 'hello', tags: ['b', 'a'], createdAt: 1 })).toBe(true);
    expect(await store.get('n-1')).toEqual({ id: 'n-1', body: 'hello', tags: ['a', 'b'], archived: false, createdAt: 1 });
  });

  it('resumes a run that failed halfway at the statement it stopped at: the ones before it are applied once, and the next run applies the rest', async () => {
    const schema = mysqlNoteSchemaWith([initialMigration, archiveMigration, threeTables]);
    await mysqlNoteSchema.migrate(fromMysql2(pool()), 'm_resumed');
    await rows('CREATE TABLE m_resumed_second (taken int NOT NULL PRIMARY KEY)');

    const error = await schema.migrate(fromMysql2(pool()), 'm_resumed').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoteSchemaError);
    expect(error).toMatchObject({ schema: 'm_resumed', version: 2, requiredVersion: 3, cause: { errno: 1050 } });
    expect((error as Error).message).toBe(
      'MySqlNoteStore: migrating schema "m_resumed" from version 2 to 3 stopped at migration 3 (three_tables), statement 2 of 3: ' +
        "Table 'm_resumed_second' already exists. The statements before it are applied, and migrating again resumes at it.",
    );
    expect(await rows('SELECT version, started, applied, applied_at FROM m_resumed_migrations WHERE version = 3')).toEqual([
      { version: 3, started: 1, applied: 1, applied_at: null },
    ]);
    expect(await mysqlNoteSchema.version(fromMysql2(pool()), 'm_resumed')).toBe(2);

    await rows('DROP TABLE m_resumed_second');
    const recorder = recording(fromMysql2(pool()));
    expect(await schema.migrate(recorder.executor, 'm_resumed')).toEqual([3]);
    expect(ddl(recorder.statements).filter((text) => !text.startsWith('CREATE TABLE IF NOT EXISTS'))).toEqual([
      'CREATE TABLE `m_resumed_second` (id int NOT NULL PRIMARY KEY)',
      'CREATE TABLE `m_resumed_third` (id int NOT NULL PRIMARY KEY)',
    ]);
    expect(await tables('m_resumed')).toContain('m_resumed_first');
    expect(await schema.version(fromMysql2(pool()), 'm_resumed')).toBe(3);
  });

  it("resumes a run a crash cut off between a statement and its record: the statement runs again, and MySQL's saying it exists counts as applied", async () => {
    const schema = mysqlNoteSchemaWith([initialMigration, archiveMigration, threeTables]);
    await mysqlNoteSchema.migrate(fromMysql2(pool()), 'm_crashed');

    // The connection is lost right after the second statement committed, before its record.
    const crashing = recording(fromMysql2(pool()));
    const lost = Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const crash: SqlExecutor = {
      ...crashing.executor,
      transaction: (work, options) =>
        crashing.executor.transaction(
          (tx) =>
            work({
              query: async (text, params) => {
                if (text.includes('SET started = CAST(? AS SIGNED), applied = CAST(? AS SIGNED)') && params?.[1] === '2') {
                  throw lost;
                }
                return tx.query(text, params);
              },
              execute: (text, params) => tx.execute(text, params),
            }),
          options,
        ),
    };
    const error = await schema.migrate(crash, 'm_crashed').catch((e: unknown) => e);
    expect(error).toBe(lost);
    expect(await tables('m_crashed')).toEqual(expect.arrayContaining(['m_crashed_first', 'm_crashed_second']));
    expect(await rows('SELECT started, applied FROM m_crashed_migrations WHERE version = 3')).toEqual([{ started: 2, applied: 1 }]);

    const recorder = recording(fromMysql2(pool()));
    expect(await schema.migrate(recorder.executor, 'm_crashed')).toEqual([3]);
    expect(ddl(recorder.statements).filter((text) => !text.startsWith('CREATE TABLE IF NOT EXISTS'))).toEqual([
      'CREATE TABLE `m_crashed_second` (id int NOT NULL PRIMARY KEY)',
      'CREATE TABLE `m_crashed_third` (id int NOT NULL PRIMARY KEY)',
    ]);
    expect(await rows('SELECT started, applied, applied_at > 0 AS stamped FROM m_crashed_migrations WHERE version = 3')).toEqual([
      { started: 3, applied: 3, stamped: 1 },
    ]);
  });

  it("fails on a schema whose tables someone else took, says where it stopped, and doesn't take the other table for its own on the next run", async () => {
    await rows('CREATE TABLE m_taken_notes (id int NOT NULL PRIMARY KEY)');
    const error = await mysqlNoteSchema.migrate(fromMysql2(pool()), 'm_taken').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoteSchemaError);
    expect(error).toMatchObject({ schema: 'm_taken', version: 0, requiredVersion: 2 });
    expect((error as Error).message).toBe(
      'MySqlNoteStore: migrating schema "m_taken" from version 0 to 2 stopped at migration 1 (initial), statement 1 of 4: ' +
        "Table 'm_taken_notes' already exists. The statements before it are applied, and migrating again resumes at it.",
    );
    // The refused statement's mark was taken back: the next run fails the same way instead of taking it as applied.
    expect(await rows('SELECT started, applied FROM m_taken_migrations WHERE version = 1')).toEqual([{ started: 0, applied: 0 }]);
    await expect(mysqlNoteSchema.migrate(fromMysql2(pool()), 'm_taken')).rejects.toThrow("Table 'm_taken_notes' already exists");
  });

  it("fails a migration through Drizzle or Prisma with the database's message, not the client's wrapping, and keeps the client's error as the cause", async () => {
    for (const client of clients.filter((candidate) => /^from(Drizzle|Prisma)/.test(candidate.name))) {
      const schema = client.name.startsWith('fromDrizzle') ? 'm_drizzle_taken' : 'm_prisma_taken';
      const opened = await client.open(database!.url);
      try {
        await rows(`CREATE TABLE ${schema}_note_tags (id int NOT NULL PRIMARY KEY)`);
        const error = await mysqlNoteSchema.migrate(opened.executor, schema).catch((e: unknown) => e);
        expect((error as Error).message).toBe(
          `MySqlNoteStore: migrating schema "${schema}" from version 0 to 2 stopped at migration 1 (initial), statement 2 of 4: ` +
            `Table '${schema}_note_tags' already exists. The statements before it are applied, and migrating again resumes at it.`,
        );
        expect(((error as Error).cause as Error).constructor.name).toBe(client.name.startsWith('fromDrizzle') ? 'DrizzleQueryError' : 'PrismaClientKnownRequestError');
      } finally {
        await opened.close();
      }
    }
  });

  it("fails clearly within its short waits when a transaction holds a table it alters, applies nothing of that statement, restores the connection's lock_wait_timeout, and resumes once that transaction ends", async () => {
    await mysqlNoteSchemaWith([initialMigration]).migrate(fromMysql2(pool()), 'm_blocked');
    const hurried = mysqlNoteSchemaWith([initialMigration, archiveMigration]);
    Object.assign(hurried, { metadataLockWait: { seconds: 1, attempts: 2, pauseMs: 10 } });
    const migrating = pool();
    const holder = await database!.admin.getConnection();
    try {
      // An application's transaction that has used the store's table, still open.
      await holder.beginTransaction();
      await holder.query('SELECT COUNT(*) AS n FROM m_blocked_notes');
      const started = Date.now();
      const error = await hurried.migrate(fromMysql2(migrating), 'm_blocked').catch((e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(error).toBeInstanceOf(NoteSchemaError);
      expect(error).toMatchObject({ schema: 'm_blocked', version: 1, requiredVersion: 2, cause: { errno: 1205 } });
      expect((error as Error).message).toBe(
        'MySqlNoteStore: migrating schema "m_blocked" from version 1 to 2 stopped at migration 2 (archive), statement 1 of 2: Lock wait timeout exceeded; try restarting transaction. ' +
          "A transaction that has used the table holds it (MySQL's metadata lock), and the statement waited for it 2 times, 1 s each, then gave up, applying nothing: " +
          'migrating again, once that transaction ends, resumes at it.',
      );
      expect(await rows('SELECT started, applied, applied_at FROM m_blocked_migrations WHERE version = 2')).toEqual([{ started: 0, applied: 0, applied_at: null }]);
      expect(await rows("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'm_blocked_notes' AND COLUMN_NAME = 'archived'")).toEqual([]);
      // The pool's one connection has the application's wait again.
      expect((await migrating.query('SELECT @@session.lock_wait_timeout = @@global.lock_wait_timeout AS restored'))[0]).toEqual([{ restored: 1 }]);
      await holder.commit();
    } finally {
      holder.release();
    }
    expect(await hurried.migrate(fromMysql2(migrating), 'm_blocked')).toEqual([2]);
    expect((await migrating.query('SELECT @@session.lock_wait_timeout = @@global.lock_wait_timeout AS restored'))[0]).toEqual([{ restored: 1 }]);
  });

  it("gives every table a primary key: the kit's and the store's migrate with sql_require_primary_key on, where a table without one fails", async () => {
    const strict = pool();
    strict.on('connection', (connection) => {
      connection.query('SET SESSION sql_require_primary_key = ON');
    });
    expect(await mysqlNoteSchema.migrate(fromMysql2(strict), 'm_keyed')).toEqual([1, 2]);

    const keyless = mysqlNoteSchemaWith([initialMigration, archiveMigration, { version: 3, name: 'keyless', up: (t) => [`CREATE TABLE ${t('keyless')} (id int NOT NULL)`] }]);
    const error = await keyless.migrate(fromMysql2(strict), 'm_keyed').catch((e: unknown) => e);
    expect(error).toMatchObject({ cause: { errno: 3750 } });
    expect((error as Error).message).toContain('without a primary key');
  });
});

describe('a MySQL schema behind the store, and one ahead of it', () => {
  onMysql(reason);

  it("fails assertMigrated() with the package's error, which says how to migrate (or the hint), and the next versions apply", async () => {
    const executor = fromMysql2(pool());
    await mysqlNoteSchemaWith([initialMigration]).migrate(executor, 'm_behind');

    const error = await mysqlNoteSchema.assertMigrated(executor, 'm_behind').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoteSchemaError);
    expect(error).toMatchObject({ name: 'NoteSchemaError', schema: 'm_behind', version: 1, requiredVersion: 2 });
    expect((error as Error).message).toBe(
      'MySqlNoteStore: schema "m_behind" is at version 1, and this version of @nestjs/notes needs version 2. Apply its migrations: ' +
        'set `migrate: true` to apply them at startup, run `npx @nestjs/notes migrate --url <database url> --schema m_behind`, ' +
        "or apply `MySqlNoteStore.migrationSql({ schema: 'm_behind', from: 1 })` with your migration tool.",
    );
    await expect(mysqlNoteSchema.assertMigrated(executor, 'm_behind', 'Ask your DBA.')).rejects.toThrow(
      'MySqlNoteStore: schema "m_behind" is at version 1, and this version of @nestjs/notes needs version 2. Ask your DBA.',
    );

    expect(mysqlNoteSchema.statements({ schema: 'm_behind', from: 1 })).toEqual([
      'ALTER TABLE `m_behind_notes` ADD COLUMN archived boolean NOT NULL DEFAULT false, ALGORITHM=INSTANT',
      'CREATE INDEX notes_archived ON `m_behind_notes` (archived, created_at) ALGORITHM=INPLACE LOCK=NONE',
      "INSERT INTO `m_behind_migrations` (version, name, applied_at) VALUES (2, 'archive', UNIX_TIMESTAMP() * 1000)",
    ]);
    expect(await mysqlNoteSchema.migrate(executor, 'm_behind')).toEqual([2]);
    await expect(mysqlNoteSchema.assertMigrated(executor, 'm_behind')).resolves.toBeUndefined();
  });

  it('serves a schema ahead of it, which a newer version of the package migrated during a rolling deploy', async () => {
    const executor = fromMysql2(pool());
    expect(await mysqlNoteSchemaWith([initialMigration, archiveMigration, extraMigration]).migrate(executor, 'm_ahead')).toEqual([1, 2, 3]);

    await expect(mysqlNoteSchema.assertMigrated(executor, 'm_ahead')).resolves.toBeUndefined();
    expect(await mysqlNoteSchema.migrate(executor, 'm_ahead')).toEqual([]);
    expect(await mysqlNoteSchema.version(executor, 'm_ahead')).toBe(3);
    const store = new MySqlNoteStore({ executor, schema: 'm_ahead', migrate: false });
    expect(await store.add({ id: 'n-1', body: 'hello', createdAt: 1 })).toBe(true);
  });

  it('reads a schema without the migrations table as version 0, and a migrate: false store fails on it', async () => {
    const executor = fromMysql2(pool());
    expect(await mysqlNoteSchema.version(executor, 'm_missing')).toBe(0);
    const store = new MySqlNoteStore({ executor, schema: 'm_missing', migrate: false });
    await expect(store.onModuleInit()).rejects.toThrow('MySqlNoteStore: schema "m_missing" is at version 0, and this version of @nestjs/notes needs version 2.');
    expect(await tables('m_missing')).toEqual([]);
  });
});

describe("drizzle-kit's statement breakpoints, through Drizzle's MySQL migrator", () => {
  onMysql(reason);

  /** A drizzle-kit migrations folder with one custom migration, as `drizzle-kit generate --custom` makes it. */
  function migrationsFolder(sql: string): string {
    const folder = mkdtempSync(join(tmpdir(), 'skit-drizzle-mysql-'));
    mkdirSync(join(folder, 'meta'));
    writeFileSync(join(folder, '0000_notes.sql'), sql);
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ version: '5', dialect: 'mysql', entries: [{ idx: 0, version: '5', when: 1790000000000, tag: '0000_notes', breakpoints: true }] }),
    );
    return folder;
  }

  it("runs sql({ statementBreakpoints: true }) one statement at a time: the schema is migrate()'s, and serves", async () => {
    const executor = fromMysql2(pool());
    await mysqlNoteSchema.migrate(executor, 'm_by_kit');
    const folder = migrationsFolder(MySqlNoteStore.migrationSql({ schema: 'm_by_drizzle', statementBreakpoints: true }));
    const connection = pool();
    try {
      await drizzleMigrate(drizzle(connection), { migrationsFolder: folder, migrationsTable: 'drizzle_journal_by_drizzle' });
      expect(await catalog(executor, 'm_by_drizzle')).toEqual(await catalog(executor, 'm_by_kit'));
      const store = new MySqlNoteStore({ executor, schema: 'm_by_drizzle', migrate: false });
      await expect(store.onModuleInit()).resolves.toBeUndefined();
      expect(await store.add({ id: 'n-1', body: 'hello', tags: ['x'], createdAt: 1 })).toBe(true);
      expect(await store.archive('n-1')).toBe(true);
      expect(await store.archive('n-1')).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('is what mysql2 needs: the script without breakpoints fails there, as one call runs one statement', async () => {
    const folder = migrationsFolder(MySqlNoteStore.migrationSql({ schema: 'm_one_call' }));
    try {
      await expect(drizzleMigrate(drizzle(pool()), { migrationsFolder: folder, migrationsTable: 'drizzle_journal_one_call' })).rejects.toSatisfy((error: Error) =>
        /SQL syntax/.test(`${error.message} ${(error.cause as Error | undefined)?.message}`),
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the MySQL StoreSchema.sql() and statements()', () => {
  it("print the default schema from a new database with a header that says they don't run in one transaction, a range of versions, and never a downgrade", () => {
    const script = mysqlNoteSchema.sql();
    expect(script).toMatch(
      /^-- @nestjs\/notes: MySqlNoteStore's schema "nest_notes" \(tables nest_notes_\*\), from version 0 to 2\.\n-- The statements don't run in one transaction: MySQL commits each DDL statement on its own\. Apply them in order, each once\.\n\n/,
    );
    expect(script).toContain('CREATE TABLE IF NOT EXISTS `nest_notes_migrations` (');
    expect(script).toContain('CREATE TABLE IF NOT EXISTS `nest_notes_locks` (');
    expect(script).toContain("INSERT INTO `nest_notes_migrations` (version, name, applied_at) VALUES (1, 'initial', UNIX_TIMESTAMP() * 1000);");
    expect(script.endsWith("INSERT INTO `nest_notes_migrations` (version, name, applied_at) VALUES (2, 'archive', UNIX_TIMESTAMP() * 1000);\n")).toBe(true);
    expect(mysqlNoteSchema.sql({ from: 1 })).not.toContain('CREATE TABLE IF NOT EXISTS');
    expect(mysqlNoteSchema.statements({ from: 1, to: 1 })).toEqual([]);
    expect(mysqlNoteSchema.statements({ from: 0, to: 1 })).toHaveLength(2 + 4 + 1);

    expect(() => mysqlNoteSchema.sql({ from: 1, to: 0 })).toThrow(
      "MySqlNoteStore.migrationSql(): no migrations lead from version 1 to 0. Versions go from 0 (none applied) to 2, and never back: downgrades aren't supported.",
    );
    expect(() => mysqlNoteSchema.statements({ to: 3 })).toThrow(RangeError);
  });

  it("separate the statements with drizzle-kit's --> statement-breakpoint when asked, under the same header", () => {
    const statements = mysqlNoteSchema.statements();
    const script = mysqlNoteSchema.sql({ statementBreakpoints: true });
    expect(script.split('\n--> statement-breakpoint\n')).toHaveLength(statements.length);
    expect(script.endsWith(`${statements.at(-1)};\n`)).toBe(true);
  });

  it('take a schema name of lowercase letters, digits and underscores, not starting with a digit, at most 40 characters', () => {
    for (const schema of ['Mixed_Case', 'bad-name', '1st', '', 'x'.repeat(41), 'a`b', 'a b']) {
      expect(() => mysqlNoteSchema.sql({ schema })).toThrow(
        `MySqlNoteStore: invalid schema ${JSON.stringify(schema)}. Use lowercase letters, digits and underscores, not starting with a digit, at most 40 characters: the store's tables are named <schema>_<table> in the connection's database.`,
      );
    }
    expect(mysqlNoteSchema.statements({ schema: `_${'x'.repeat(39)}` })[0]).toContain(`\`_${'x'.repeat(39)}_migrations\``);
  });
});

describe('new StoreSchema() of @nestjs/store-kit/mysql', () => {
  const make = (overrides: object) => () => new StoreSchema({ ...mysqlNoteSchemaOptions, ...overrides });

  it("refuses a definition its store's author got wrong, when the store's module loads", () => {
    expect(make({ packageName: '' })).toThrow('StoreSchema: `packageName` must be a non-empty string, not "".');
    expect(make({ defaultSchema: 'Notes' })).toThrow('MySqlNoteStore\'s StoreSchema: invalid schema "Notes".');
    expect(make({ migrations: [archiveMigration] })).toThrow("MySqlNoteStore's StoreSchema: the migrations must be versions 1, 2, 3... in order; the one at index 0 is version 2.");

    const migration = (up: StoreMigration['up']) => ({ migrations: [{ version: 1, name: 'initial', up }] });
    expect(make(migration((t) => [`INSERT INTO ${t('notes')} (id) VALUES ('seed')`]))).toThrow(
      'MySqlNoteStore\'s StoreSchema: migration 1 (initial) has a statement that isn\'t DDL: "INSERT INTO `nest_notes_notes` (id) VALUES (\'seed\')". A MySQL migration holds CREATE, ALTER and DROP statements, which MySQL commits one by one.',
    );
    expect(make(migration((t) => [`-- a comment first\nCREATE TABLE ${t('notes')} (id int NOT NULL PRIMARY KEY)`]))).not.toThrow();
    expect(make(migration((t) => [`CREATE TABLE ${t('locks')} (id int NOT NULL PRIMARY KEY)`]))).toThrow(
      'MySqlNoteStore: the table name "locks" is taken: every store\'s schema has the kit\'s own migrations and locks tables.',
    );
    expect(make(migration((t) => [`CREATE TABLE ${t('x'.repeat(60))} (id int NOT NULL PRIMARY KEY)`]))).toThrow(
      `MySqlNoteStore: the table name "nest_notes_${'x'.repeat(60)}" is 71 characters long, and MySQL allows 64: use a shorter schema.`,
    );
    expect(make(migration((() => 'CREATE TABLE x (id int)') as never))).toThrow('migration 1 (initial) must return its statements, an array of strings.');
  });

  it('keeps its own copy of the migrations, as released versions never change', () => {
    const migrations = [initialMigration];
    const schema = mysqlNoteSchemaWith(migrations);
    migrations.push(archiveMigration);
    expect(schema.latest).toBe(1);
    expect(schema.dialect).toBe('mysql');
  });
});
