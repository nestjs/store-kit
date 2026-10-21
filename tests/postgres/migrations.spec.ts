/**
 * A store's schema through StoreSchema (tests/fixtures/notes): a new database, a rerun, processes migrating at once
 * under the migration lock, statements() and sql() against what migrate() runs, the script applied by hand and with
 * drizzle-kit's statement breakpoints through Drizzle's migrator on PGlite, a schema someone created, a failing
 * migration, a colliding table, a schema behind the store and one ahead of it, ranges, schema names, and the
 * definition's own checks.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate as drizzleMigrate } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { fromDrizzle, fromPg, StoreSchema, type SqlTransaction, type StoreMigration } from '../../lib/postgres/index.js';
import { endPool } from '../support/postgres.js';
import { archiveMigration, initialMigration, NoteSchemaError, noteSchema, noteSchemaOptions, noteSchemaWith } from '../fixtures/notes/note.schema.js';
import { PostgresNoteStore } from '../fixtures/notes/postgres-note.store.js';
import { clients, onPostgres, recording, testDatabase } from './support.js';

const { database, reason } = await testDatabase('migrations');
const pools: pg.Pool[] = [];

afterAll(async () => {
  await Promise.all(pools.map((pool) => endPool(pool)));
});

/** A pool of its own, as each process has. */
const pool = () => {
  const opened = new pg.Pool({ connectionString: database!.url, max: 2 });
  pools.push(opened);
  return opened;
};

const rows = async (sql: string, params: unknown[] = []) => (await database!.admin.query(sql, params)).rows;

const tables = async (schema: string) =>
  (await rows('SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [schema])).map((row) => row.table_name);

/** The statements that change the schema: not the lock, and not the reads of what it has. */
const changes = (statements: Array<{ text: string }>) => statements.map((statement) => statement.text).filter((text) => !text.startsWith('SELECT'));

/** Everything about a schema's tables that migrations define, with the schema's name taken out, read through `db`. */
async function catalog(db: SqlTransaction, schema: string) {
  const read = async (sql: string) => db.query(sql, [schema]);
  const anonymize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(schema, '<schema>'));
  return anonymize({
    columns: await read(
      `SELECT table_name::text, column_name::text, ordinal_position::text, data_type::text, is_nullable::text, column_default::text
       FROM information_schema.columns WHERE table_schema = $1::text ORDER BY table_name, ordinal_position`,
    ),
    constraints: await read(
      `SELECT conrelid::regclass::text AS table_name, conname::text AS name, pg_get_constraintdef(oid)::text AS definition
       FROM pg_constraint WHERE connamespace = $1::text::regnamespace ORDER BY 1, 2`,
    ),
    indexes: await read('SELECT tablename::text, indexname::text, indexdef::text FROM pg_indexes WHERE schemaname = $1::text ORDER BY tablename, indexname'),
    versions: await db.query(`SELECT version::text, name FROM "${schema}".migrations ORDER BY version`),
  });
}

const extraMigration: StoreMigration = { version: 3, name: 'extra', up: (s) => [`CREATE TABLE ${s}.extra (id integer PRIMARY KEY)`] };

describe('StoreSchema.migrate()', () => {
  onPostgres(reason);

  it('creates the schema, its tables and a record per version on a new database, and applies nothing the second time', async () => {
    const executor = fromPg(pool());
    expect(await noteSchema.migrate(executor, 'm_fresh')).toEqual([1, 2]);
    expect(await tables('m_fresh')).toEqual(['migrations', 'note_tags', 'notes']);
    expect(await rows('SELECT version, name FROM m_fresh.migrations ORDER BY version')).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'archive' },
    ]);
    expect(noteSchema.latest).toBe(2);
    expect(await noteSchema.version(executor, 'm_fresh')).toBe(2);

    expect(await noteSchema.migrate(executor, 'm_fresh')).toEqual([]);
    expect(await noteSchema.migrate(fromPg(pool()), 'm_fresh')).toEqual([]);
    expect(await rows('SELECT count(*)::int AS n FROM m_fresh.migrations')).toEqual([{ n: 2 }]);
  });

  it('applies the migrations once when processes migrate together, each on its own connections', async () => {
    const applied = await Promise.all(Array.from({ length: 8 }, () => noteSchema.migrate(fromPg(pool()), 'm_together')));
    expect(applied.filter((versions) => versions.length > 0)).toEqual([[1, 2]]);
    expect(await rows('SELECT version FROM m_together.migrations ORDER BY version')).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('takes the lock keyed <packageName>:migrate:<schema> first, and waits for whoever holds it', async () => {
    const recorder = recording(fromPg(pool()));
    await noteSchema.migrate(recorder.executor, 'm_locked');
    expect(recorder.statements[0]).toEqual({ text: 'SELECT pg_advisory_xact_lock(hashtext($1::text))::text AS locked', params: ['@nestjs/notes:migrate:m_locked'] });

    const holder = await pool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('@nestjs/notes:migrate:m_held'))");
      let settled = false;
      const migrating = noteSchema.migrate(fromPg(pool()), 'm_held').finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await holder.query('COMMIT');
      expect(await migrating).toEqual([1, 2]);
    } finally {
      holder.release();
    }
  });

  it('runs exactly the statements sql() prints, and a database migrated with the script is the same, and serves', async () => {
    const recorder = recording(fromPg(pool()));
    await noteSchema.migrate(recorder.executor, 'm_migrated');
    expect(changes(recorder.statements)).toEqual(noteSchema.statements({ schema: 'm_migrated' }));
    expect(noteSchema.sql({ schema: 'm_migrated' })).toBe(
      `-- @nestjs/notes: PostgresNoteStore's schema "m_migrated", from version 0 to 2.\n-- Run it in one transaction.\n\n` +
        `${changes(recorder.statements).map((statement) => `${statement};`).join('\n\n')}\n`,
    );

    // As a team applies it with its own tool: one script, in one transaction.
    const client = await pool().connect();
    try {
      await client.query(`BEGIN; ${PostgresNoteStore.migrationSql({ schema: 'm_script' })} COMMIT;`);
    } finally {
      client.release();
    }
    const executor = fromPg(pool());
    expect(await catalog(executor, 'm_script')).toEqual(await catalog(executor, 'm_migrated'));

    const store = new PostgresNoteStore({ executor, schema: 'm_script', migrate: false });
    await expect(store.onModuleInit()).resolves.toBeUndefined();
    expect(await store.add({ id: 'n-1', body: 'hello', tags: ['b', 'a'], createdAt: 1 })).toBe(true);
    expect(await store.get('n-1')).toEqual({ id: 'n-1', body: 'hello', tags: ['a', 'b'], archived: false, createdAt: 1 });
  });

  it("uses a schema someone created for the store as it is, without CREATE SCHEMA (which needs the database's CREATE privilege)", async () => {
    await rows('CREATE SCHEMA m_precreated');
    const recorder = recording(fromPg(pool()));
    expect(await noteSchema.migrate(recorder.executor, 'm_precreated')).toEqual([1, 2]);
    expect(changes(recorder.statements)).toEqual(noteSchema.statements({ schema: 'm_precreated' }).filter((statement) => !statement.startsWith('CREATE SCHEMA')));
  });

  it("applies nothing of a migration that fails, and says which versions it was between, with the package's error", async () => {
    await noteSchema.migrate(fromPg(pool()), 'm_failing');
    const broken: StoreMigration = { version: 3, name: 'broken', up: (s) => [`CREATE TABLE ${s}.extra (id integer)`, 'SELECT 1 / 0'] };

    const error = await noteSchemaWith([initialMigration, archiveMigration, broken])
      .migrate(fromPg(pool()), 'm_failing')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoteSchemaError);
    expect(error).toMatchObject({ schema: 'm_failing', version: 2, requiredVersion: 3, cause: { message: 'division by zero' } });
    expect((error as Error).message).toBe('PostgresNoteStore: migrating schema "m_failing" from version 2 to 3 failed, and nothing was applied: division by zero');
    expect(await tables('m_failing')).not.toContain('extra');
    expect(await rows('SELECT max(version) AS version FROM m_failing.migrations')).toEqual([{ version: 2 }]);
  });

  it("fails a migration through Prisma with the database's message, not Prisma's invocation text", async () => {
    const prisma = await clients.find((client) => client.name.startsWith('fromPrisma'))!.open(database!.url);
    try {
      await rows('CREATE SCHEMA m_prisma_taken');
      await rows('CREATE TABLE m_prisma_taken.notes (id serial PRIMARY KEY)');
      const error = await noteSchema.migrate(prisma.executor, 'm_prisma_taken').catch((e: unknown) => e);
      expect((error as Error).message).toBe(
        'PostgresNoteStore: migrating schema "m_prisma_taken" from version 0 to 2 failed, and nothing was applied: relation "notes" already exists',
      );
      expect((error as Error).cause).toMatchObject({ name: 'PrismaClientKnownRequestError' });
    } finally {
      await prisma.close();
    }
  });

  it("fails on a schema that has other tables of the store's names, and creates nothing", async () => {
    await rows('CREATE SCHEMA m_taken');
    await rows('CREATE TABLE m_taken.notes (id serial PRIMARY KEY)');
    const error = await noteSchema.migrate(fromPg(pool()), 'm_taken').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoteSchemaError);
    expect(error).toMatchObject({ schema: 'm_taken', version: 0, requiredVersion: 2 });
    expect((error as Error).message).toBe(
      'PostgresNoteStore: migrating schema "m_taken" from version 0 to 2 failed, and nothing was applied: relation "notes" already exists',
    );
    expect(await tables('m_taken')).toEqual(['notes']);
  });

  it('quotes the schema in every statement, so a mixed-case name is its own schema', async () => {
    expect(await noteSchema.migrate(fromPg(pool()), 'Mixed_Case')).toEqual([1, 2]);
    expect(await tables('Mixed_Case')).toEqual(['migrations', 'note_tags', 'notes']);
    expect(await tables('mixed_case')).toEqual([]);
  });
});

describe('a schema behind the store, and one ahead of it', () => {
  onPostgres(reason);

  it("fails assertMigrated() with the package's error, which says how to migrate (or the hint), and the next versions apply", async () => {
    const executor = fromPg(pool());
    await noteSchemaWith([initialMigration]).migrate(executor, 'm_behind');

    const error = await noteSchema.assertMigrated(executor, 'm_behind').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoteSchemaError);
    expect(error).toMatchObject({ name: 'NoteSchemaError', schema: 'm_behind', version: 1, requiredVersion: 2 });
    expect((error as Error).message).toBe(
      'PostgresNoteStore: schema "m_behind" is at version 1, and this version of @nestjs/notes needs version 2. Apply its migrations: ' +
        'set `migrate: true` to apply them at startup, run `npx @nestjs/notes migrate --url <database url> --schema m_behind`, ' +
        "or apply `PostgresNoteStore.migrationSql({ schema: 'm_behind', from: 1 })` with your migration tool.",
    );
    await expect(noteSchema.assertMigrated(executor, 'm_behind', 'Ask your DBA.')).rejects.toThrow(
      'PostgresNoteStore: schema "m_behind" is at version 1, and this version of @nestjs/notes needs version 2. Ask your DBA.',
    );

    expect(noteSchema.statements({ schema: 'm_behind', from: 1 })).toEqual([
      'ALTER TABLE "m_behind".notes ADD COLUMN archived boolean NOT NULL DEFAULT false',
      'CREATE INDEX notes_archived ON "m_behind".notes (created_at) WHERE archived',
      `INSERT INTO "m_behind".migrations (version, name) VALUES (2, 'archive')`,
    ]);
    expect(await noteSchema.migrate(executor, 'm_behind')).toEqual([2]);
    await expect(noteSchema.assertMigrated(executor, 'm_behind')).resolves.toBeUndefined();
  });

  it('serves a schema ahead of it, which a newer version of the package migrated during a rolling deploy', async () => {
    const executor = fromPg(pool());
    expect(await noteSchemaWith([initialMigration, archiveMigration, extraMigration]).migrate(executor, 'm_ahead')).toEqual([1, 2, 3]);

    await expect(noteSchema.assertMigrated(executor, 'm_ahead')).resolves.toBeUndefined();
    expect(await noteSchema.migrate(executor, 'm_ahead')).toEqual([]);
    expect(await noteSchema.version(executor, 'm_ahead')).toBe(3);
    const store = new PostgresNoteStore({ executor, schema: 'm_ahead', migrate: false });
    expect(await store.add({ id: 'n-1', body: 'hello', createdAt: 1 })).toBe(true);
  });

  it("reads a missing schema, or one without the migrations table, as version 0", async () => {
    const executor = fromPg(pool());
    expect(await noteSchema.version(executor, 'm_missing')).toBe(0);
    await rows('CREATE SCHEMA m_empty');
    expect(await noteSchema.version(executor, 'm_empty')).toBe(0);
  });
});

describe("drizzle-kit's statement breakpoints, on PGlite", () => {
  /** A drizzle-kit migrations folder with one custom migration, as `drizzle-kit generate --custom` makes it. */
  function migrationsFolder(sql: string): string {
    const folder = mkdtempSync(join(tmpdir(), 'skit-drizzle-'));
    mkdirSync(join(folder, 'meta'));
    writeFileSync(join(folder, '0000_notes.sql'), sql);
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', when: 1790000000000, tag: '0000_notes', breakpoints: true }] }),
    );
    return folder;
  }

  it("runs sql({ statementBreakpoints: true }) through Drizzle's migrator one statement at a time: the schema is migrate()'s, and serves", async () => {
    const [migrated, byDrizzle] = [new PGlite(), new PGlite()];
    const folder = migrationsFolder(PostgresNoteStore.migrationSql({ statementBreakpoints: true }));
    try {
      await noteSchema.migrate(fromDrizzle(drizzle(migrated)), 'nest_notes');
      const db = drizzle(byDrizzle);
      await drizzleMigrate(db, { migrationsFolder: folder });

      expect(await catalog(fromDrizzle(db), 'nest_notes')).toEqual(await catalog(fromDrizzle(drizzle(migrated)), 'nest_notes'));
      const store = new PostgresNoteStore({ executor: fromDrizzle(db), migrate: false });
      await expect(store.onModuleInit()).resolves.toBeUndefined();
      expect(await store.add({ id: 'n-1', body: 'hello', tags: ['x'], createdAt: 1 })).toBe(true);
      expect(await store.archive('n-1')).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await migrated.close();
      await byDrizzle.close();
    }
  });

  it("fails a migration through Drizzle with the database's message, not Drizzle's \"Failed query\", and keeps Drizzle's error as the cause", async () => {
    const pglite = new PGlite();
    try {
      const broken: StoreMigration = { version: 3, name: 'broken', up: () => ['SELECT 1 / 0'] };
      const error = await noteSchemaWith([initialMigration, archiveMigration, broken])
        .migrate(fromDrizzle(drizzle(pglite)), 'nest_notes')
        .catch((e: unknown) => e);
      expect((error as Error).message).toBe('PostgresNoteStore: migrating schema "nest_notes" from version 0 to 3 failed, and nothing was applied: division by zero');
      const cause = (error as Error).cause as Error;
      expect([cause.constructor.name, cause.message]).toEqual(['DrizzleQueryError', expect.stringMatching(/^Failed query: SELECT 1 \/ 0/)]);
    } finally {
      await pglite.close();
    }
  });

  it("is what PGlite needs: the script without breakpoints fails there, as one prepared statement can't hold several", async () => {
    const pglite = new PGlite();
    const folder = migrationsFolder(PostgresNoteStore.migrationSql());
    try {
      await expect(drizzleMigrate(drizzle(pglite), { migrationsFolder: folder })).rejects.toSatisfy((error: Error) =>
        /multiple commands/.test(`${error.message} ${(error.cause as Error | undefined)?.message}`),
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await pglite.close();
    }
  });
});

describe('StoreSchema.sql() and statements()', () => {
  it('print the default schema from a new database, a range of versions, and never a downgrade', () => {
    const script = noteSchema.sql();
    expect(script).toMatch(/^-- @nestjs\/notes: PostgresNoteStore's schema "nest_notes", from version 0 to 2\.\n-- Run it in one transaction\.\n\n/);
    expect(script).toContain('CREATE SCHEMA IF NOT EXISTS "nest_notes";\n\nCREATE TABLE IF NOT EXISTS "nest_notes".migrations (');
    expect(script).toContain(`INSERT INTO "nest_notes".migrations (version, name) VALUES (1, 'initial');`);
    expect(script.endsWith(`INSERT INTO "nest_notes".migrations (version, name) VALUES (2, 'archive');\n`)).toBe(true);
    expect(noteSchema.sql({ from: 1 })).not.toContain('CREATE SCHEMA');
    expect(noteSchema.statements({ from: 1, to: 1 })).toEqual([]);
    expect(noteSchema.statements({ from: 0, to: 1 })).toHaveLength(2 + initialMigration.up('s').length + 1);

    expect(() => noteSchema.sql({ from: 1, to: 0 })).toThrow(RangeError);
    expect(() => noteSchema.sql({ from: 1, to: 0 })).toThrow(
      "PostgresNoteStore.migrationSql(): no migrations lead from version 1 to 0. Versions go from 0 (none applied) to 2, and never back: downgrades aren't supported.",
    );
    expect(() => noteSchema.statements({ to: 3 })).toThrow('no migrations lead from version 0 to 3');
    expect(() => noteSchema.statements({ from: -1 })).toThrow(RangeError);
    expect(() => noteSchema.statements({ from: 0.5 })).toThrow(RangeError);
  });

  it("separate the statements with drizzle-kit's --> statement-breakpoint when asked, under the same header", () => {
    const statements = noteSchema.statements();
    const script = noteSchema.sql({ statementBreakpoints: true });
    expect(script).toBe(
      `-- @nestjs/notes: PostgresNoteStore's schema "nest_notes", from version 0 to 2.\n-- Run it in one transaction.\n\n` +
        `${statements.map((statement) => `${statement};`).join('\n--> statement-breakpoint\n')}\n`,
    );
    expect(script.split('--> statement-breakpoint')).toHaveLength(statements.length);
  });

  it('take a schema name of letters, digits and underscores, not starting with a digit, at most 63 characters', () => {
    for (const schema of ['bad-name', '1st', '', 'x'.repeat(64), 'a"b', 'a$1', 'a b']) {
      expect(() => noteSchema.sql({ schema })).toThrow(`PostgresNoteStore: invalid schema ${JSON.stringify(schema)}.`);
      expect(() => noteSchema.statements({ schema })).toThrow(TypeError);
    }
    expect(noteSchema.statements({ schema: `_${'x'.repeat(62)}` })[0]).toBe(`CREATE SCHEMA IF NOT EXISTS "_${'x'.repeat(62)}"`);
  });
});

describe('new StoreSchema()', () => {
  it("refuses a definition its store's author got wrong", () => {
    const make = (overrides: object) => () => new StoreSchema({ ...noteSchemaOptions, ...overrides });
    expect(make({ packageName: '' })).toThrow('StoreSchema: `packageName` must be a non-empty string, not "".');
    expect(make({ storeName: undefined })).toThrow('StoreSchema: `storeName` must be a non-empty string, not undefined.');
    expect(make({ command: 42 })).toThrow('StoreSchema: `command` must be a non-empty string, not 42.');
    expect(make({ defaultSchema: 'notes-db' })).toThrow('PostgresNoteStore\'s StoreSchema: invalid schema "notes-db".');
    expect(make({ createError: undefined })).toThrow("PostgresNoteStore's StoreSchema: `createError` must be a function that returns the package's schema error.");
    expect(make({ migrations: [] })).toThrow("PostgresNoteStore's StoreSchema: `migrations` must list the schema's versions, version 1 first.");
    expect(make({ migrations: [archiveMigration] })).toThrow(
      "PostgresNoteStore's StoreSchema: the migrations must be versions 1, 2, 3... in order; the one at index 0 is version 2.",
    );
    expect(make({ migrations: [initialMigration, extraMigration] })).toThrow('the one at index 1 is version 3.');
    expect(make({ migrations: [{ ...initialMigration, name: "notes' tags" }] })).toThrow(
      `PostgresNoteStore's StoreSchema: migration 1 is named "notes' tags". Use letters, digits and underscores.`,
    );
    expect(make({ migrations: [{ version: 1, name: 'initial' }] })).toThrow("PostgresNoteStore's StoreSchema: migration 1 (initial) has no up() function.");
  });

  it('keeps its own copy of the migrations, as released versions never change', () => {
    const migrations = [initialMigration];
    const schema = noteSchemaWith(migrations);
    migrations.push(archiveMigration);
    expect(schema.latest).toBe(1);
    expect(schema.statements()).toHaveLength(2 + initialMigration.up('s').length + 1);
    expect(schema.dialect).toBe('postgres');
  });
});
