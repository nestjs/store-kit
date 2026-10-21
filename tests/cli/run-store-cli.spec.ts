/**
 * `runStoreCli()`, the command a package's bin runs (tests/fixtures/notes' `nest-notes`): `sql` prints what `sql()`
 * does, `migrate` applies the migrations, `status` exits with 1 while the schema is behind; `migrate` and `status`
 * reach the database of the URL's dialect, `sql` the one `--dialect` names, and every misuse says what to do instead.
 * The usage, word for word, for a package with one store and for one with a store of each dialect.
 */
import { runStoreCli, type StoreCliIo } from '../../lib/index.js';
import type { CliStoreSchema } from '../../lib/interfaces/index.js';
import { noteSchema, noteSchemaOptions } from '../fixtures/notes/note.schema.js';
import { mysqlNoteSchema } from '../fixtures/notes/mysql-note.schema.js';
import { StoreSchema } from '../../lib/postgres/index.js';
import { onPostgres, testDatabase } from '../postgres/support.js';

const { database, reason } = await testDatabase('cli');

async function run(argv: string[], env: StoreCliIo['env'] = {}, schemas: CliStoreSchema[] = [noteSchema]) {
  const output = { out: '', err: '' };
  const code = await runStoreCli(schemas, argv, { out: (text) => (output.out += text), err: (text) => (output.err += text), env });
  return { code, ...output };
}

describe('runStoreCli()', () => {
  it('sql prints what sql() does, without a database: a schema, a range, the dialect and statement breakpoints', async () => {
    expect(await run(['sql'])).toEqual({ code: 0, out: noteSchema.sql(), err: '' });
    expect(await run(['sql', '--schema', 'shop_notes', '--from', '1', '--to', '2'])).toEqual({
      code: 0,
      out: noteSchema.sql({ schema: 'shop_notes', from: 1, to: 2 }),
      err: '',
    });
    expect(await run(['sql', '--dialect', 'postgres', '--statement-breakpoints'])).toEqual({ code: 0, out: noteSchema.sql({ statementBreakpoints: true }), err: '' });
    expect(await run(['sql', '--from', 'one'])).toEqual({ code: 1, out: '', err: '--from takes a version number, not "one".\n' });
    expect((await run(['sql', '--to', '9'])).err).toContain('no migrations lead from version 0 to 9');
    expect((await run(['sql', '--schema', 'bad-name'])).err).toContain('PostgresNoteStore: invalid schema "bad-name".');
  });

  it("prints a PostgreSQL package's usage word for word as it did before the kit knew MySQL", async () => {
    expect((await run(['--help'])).out).toBe(`Usage: npx @nestjs/notes <command> [options]

PostgresNoteStore's schema (@nestjs/notes/postgres):

  migrate   Apply the migrations the schema hasn't had yet (one transaction, under an advisory lock)
  status    Print the schema's version and the one this version of @nestjs/notes needs;
            exit with 1 while it is behind
  sql       Print the migrations' SQL, for your own migration tool (no database needed)

Options:
  --url <url>        The database (postgres://...). Default: $DATABASE_URL
  --schema <name>    The store's schema. Default: nest_notes
  --from <version>   sql: the version to start from. Default: 0 (a new database)
  --to <version>     sql: the version to end at. Default: the latest
  --dialect <name>   sql: the database it's for (postgres). Default: postgres
  --statement-breakpoints
                     sql: separate the statements with drizzle-kit's "--> statement-breakpoint",
                     for a custom drizzle-kit migration (drizzle-kit generate --custom)
`);
  });

  it("prints the usage of a package with a store of each dialect word for word: one line names both stores, over the commands", async () => {
    expect((await run(['--help'], {}, [noteSchema, mysqlNoteSchema])).out).toBe(`Usage: npx @nestjs/notes <command> [options]

PostgresNoteStore's schema (@nestjs/notes/postgres) or MySqlNoteStore's (@nestjs/notes/mysql):

  migrate   Apply the migrations the schema hasn't had yet (PostgreSQL: one transaction, under an advisory lock;
            MySQL: one statement at a time, under GET_LOCK(), resuming where a failed run stopped)
  status    Print the schema's version and the one this version of @nestjs/notes needs;
            exit with 1 while it is behind
  sql       Print the migrations' SQL, for your own migration tool (no database needed)

Options:
  --url <url>        The database (postgres://... or mysql://...). Default: $DATABASE_URL
  --schema <name>    The store's schema. Default: nest_notes
  --from <version>   sql: the version to start from. Default: 0 (a new database)
  --to <version>     sql: the version to end at. Default: the latest
  --dialect <name>   sql: the database it's for (postgres, mysql). Default: postgres
  --statement-breakpoints
                     sql: separate the statements with drizzle-kit's "--> statement-breakpoint",
                     for a custom drizzle-kit migration (drizzle-kit generate --custom)
`);
  });

  it("prints a MySQL package's usage word for word, its one store over the commands", async () => {
    expect((await run(['--help'], {}, [mysqlNoteSchema])).out).toBe(`Usage: npx @nestjs/notes <command> [options]

MySqlNoteStore's schema (@nestjs/notes/mysql):

  migrate   Apply the migrations the schema hasn't had yet (one statement at a time, under GET_LOCK(), resuming where a failed run stopped)
  status    Print the schema's version and the one this version of @nestjs/notes needs;
            exit with 1 while it is behind
  sql       Print the migrations' SQL, for your own migration tool (no database needed)

Options:
  --url <url>        The database (mysql://...). Default: $DATABASE_URL
  --schema <name>    The store's schema. Default: nest_notes
  --from <version>   sql: the version to start from. Default: 0 (a new database)
  --to <version>     sql: the version to end at. Default: the latest
  --dialect <name>   sql: the database it's for (mysql). Default: mysql
  --statement-breakpoints
                     sql: separate the statements with drizzle-kit's "--> statement-breakpoint",
                     for a custom drizzle-kit migration (drizzle-kit generate --custom)
`);
  });

  it('prints its usage for --help, and on stderr, exiting with 1, for no command, an unknown one or an unknown option', async () => {
    const help = await run(['--help']);
    expect(help).toMatchObject({ code: 0, err: '' });
    expect(help.out).toMatch(/^Usage: npx @nestjs\/notes <command> \[options\]\n\nPostgresNoteStore's schema \(@nestjs\/notes\/postgres\):\n/);
    expect(help.out).toContain('--schema <name>    The store\'s schema. Default: nest_notes\n');
    expect(help.out).toContain('--dialect <name>   sql: the database it\'s for (postgres). Default: postgres\n');
    expect(help.out).toContain('--statement-breakpoints\n');
    expect(await run(['-h'])).toEqual(help);
    expect(await run([])).toEqual({ code: 1, out: '', err: help.out });
    expect(await run(['upgrade'])).toEqual({ code: 1, out: '', err: `Unknown command "upgrade".\n\n${help.out}` });
    expect((await run(['sql', '--verbose'])).err).toMatch(/^Unknown option '--verbose'/);
  });

  it('needs the database for migrate and status: --url, else DATABASE_URL, of a dialect it supports', async () => {
    expect(await run(['migrate'])).toEqual({ code: 1, out: '', err: 'npx @nestjs/notes migrate needs the database: pass --url, or set DATABASE_URL.\n' });
    expect((await run(['status'])).err).toBe('npx @nestjs/notes status needs the database: pass --url, or set DATABASE_URL.\n');

    const secret = 'mysql://root:s3cret@db.internal:3306/shop';
    expect(await run(['migrate', '--url', secret])).toEqual({
      code: 1,
      out: '',
      err: "npx @nestjs/notes: MySQL isn't supported yet: the stores of @nestjs/notes run on PostgreSQL.\n",
    });
    expect(await run(['status'], { DATABASE_URL: 'https://admin:s3cret@db.internal/shop' })).toEqual({
      code: 1,
      out: '',
      err: 'npx @nestjs/notes status takes a database URL that starts with postgres:// or postgresql://.\n',
    });
    expect((await run(['status', '--url', 'localhost:5432/shop'])).err).toBe('npx @nestjs/notes status takes a database URL that starts with postgres:// or postgresql://.\n');
  });

  it("prints the SQL of the dialect --dialect names: one the kit doesn't support yet, or an unknown one, fails", async () => {
    expect(await run(['sql', '--dialect', 'mysql'])).toEqual({
      code: 1,
      out: '',
      err: "npx @nestjs/notes: MySQL isn't supported yet: the stores of @nestjs/notes run on PostgreSQL.\n",
    });
    expect(await run(['sql', '--dialect', 'oracle'])).toEqual({ code: 1, out: '', err: '--dialect takes postgres or mysql, not "oracle".\n' });
  });

  it("takes the schemas of one package's stores: at least one, one per dialect", async () => {
    const io = { out: () => undefined, err: () => undefined, env: {} };
    const message = "runStoreCli() takes the schemas of one package's stores: at least one, one per dialect, with the same command.";
    await expect(runStoreCli([], ['sql'], io)).rejects.toThrow(message);
    await expect(runStoreCli([noteSchema, noteSchema], ['sql'], io)).rejects.toThrow(message);
    await expect(runStoreCli([noteSchema, { ...noteSchema, dialect: 'mysql', command: 'nest-other' } as never], ['sql'], io)).rejects.toThrow(message);
    expect(new StoreSchema({ ...noteSchemaOptions }).dialect).toBe('postgres');
  });

  describe('on PostgreSQL', () => {
    onPostgres(reason);

    it('migrate applies the pending migrations once, and status exits with 1 until they are', async () => {
      const url = database!.url;
      expect(await run(['status', '--url', url, '--schema', 'cli_store'])).toEqual({
        code: 1,
        out: 'Schema "cli_store" is at version 0; this version of @nestjs/notes needs version 2.\n',
        err: '',
      });
      expect(await run(['migrate', '--schema', 'cli_store'], { DATABASE_URL: url })).toEqual({
        code: 0,
        out: 'Migrated schema "cli_store" to version 2 (applied 1, 2).\n',
        err: '',
      });
      expect(await run(['migrate', '--url', url, '--schema', 'cli_store'])).toEqual({ code: 0, out: 'Schema "cli_store" is up to date (version 2).\n', err: '' });
      expect(await run(['status', '--url', url.replace(/^postgres:/, 'postgresql:'), '--schema', 'cli_store'])).toEqual({
        code: 0,
        out: 'Schema "cli_store" is at version 2; this version of @nestjs/notes needs version 2.\n',
        err: '',
      });
      expect(await database!.admin.query('SELECT version FROM cli_store.migrations ORDER BY version')).toMatchObject({ rows: [{ version: 1 }, { version: 2 }] });
    });

    it('reports a database it cannot migrate, and exits with 1', async () => {
      await database!.admin.query('CREATE SCHEMA cli_taken');
      await database!.admin.query('CREATE TABLE cli_taken.note_tags (id int)');
      expect(await run(['migrate', '--url', database!.url, '--schema', 'cli_taken'])).toEqual({
        code: 1,
        out: '',
        err: 'PostgresNoteStore: migrating schema "cli_taken" from version 0 to 2 failed, and nothing was applied: relation "note_tags" already exists\n',
      });
    });
  });
});
