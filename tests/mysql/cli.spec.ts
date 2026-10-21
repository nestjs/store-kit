/**
 * `runStoreCli()` with MySQL: a package with a PostgreSQL and a MySQL store (`[noteSchema, mysqlNoteSchema]`), and one
 * with a MySQL store alone. `migrate` and `status` reach the MySQL of a `mysql://` URL (whose path names the database
 * the tables live in), `sql --dialect mysql` prints the MySQL schema's script, and the usage says how each dialect
 * migrates. A PostgreSQL package's texts are unchanged (tests/cli/run-store-cli.spec.ts).
 */
import { runStoreCli, type StoreCliIo } from '../../lib/index.js';
import type { CliStoreSchema } from '../../lib/interfaces/index.js';
import { noteSchema } from '../fixtures/notes/note.schema.js';
import { mysqlNoteSchema } from '../fixtures/notes/mysql-note.schema.js';
import { onMysql, testDatabase } from './support.js';

const { database, reason } = await testDatabase('cli');

async function run(schemas: CliStoreSchema[], argv: string[], env: StoreCliIo['env'] = {}) {
  const output = { out: '', err: '' };
  const code = await runStoreCli(schemas, argv, { out: (text) => (output.out += text), err: (text) => (output.err += text), env });
  return { code, ...output };
}

const both = [noteSchema, mysqlNoteSchema];
const mysqlOnly = [mysqlNoteSchema];

describe('runStoreCli() and MySQL', () => {
  it("prints a package's usage with how each of its dialects migrates, and the URLs it takes", async () => {
    const help = await run(both, ['--help']);
    expect(help).toMatchObject({ code: 0, err: '' });
    // One line names both stores, right over the commands (tests/cli/run-store-cli.spec.ts has the whole text).
    expect(help.out).toContain("\n\nPostgresNoteStore's schema (@nestjs/notes/postgres) or MySqlNoteStore's (@nestjs/notes/mysql):\n\n  migrate   ");
    expect(help.out.match(/NoteStore's/g)).toHaveLength(2);
    expect(help.out).toContain(
      "  migrate   Apply the migrations the schema hasn't had yet (PostgreSQL: one transaction, under an advisory lock;\n" +
        '            MySQL: one statement at a time, under GET_LOCK(), resuming where a failed run stopped)\n',
    );
    expect(help.out).toContain('  --url <url>        The database (postgres://... or mysql://...). Default: $DATABASE_URL\n');
    expect(help.out).toContain("  --dialect <name>   sql: the database it's for (postgres, mysql). Default: postgres\n");

    const alone = await run(mysqlOnly, ['--help']);
    expect(alone.out).toContain("  migrate   Apply the migrations the schema hasn't had yet (one statement at a time, under GET_LOCK(), resuming where a failed run stopped)\n");
    expect(alone.out).toContain('  --url <url>        The database (mysql://...). Default: $DATABASE_URL\n');
    expect(alone.out).toContain("  --dialect <name>   sql: the database it's for (mysql). Default: mysql\n");
  });

  it('sql prints the script of the dialect --dialect names (the only one by default, else PostgreSQL), without a database', async () => {
    expect(await run(both, ['sql'])).toEqual({ code: 0, out: noteSchema.sql(), err: '' });
    expect(await run(both, ['sql', '--dialect', 'mysql', '--schema', 'shop_notes', '--from', '1'])).toEqual({
      code: 0,
      out: mysqlNoteSchema.sql({ schema: 'shop_notes', from: 1 }),
      err: '',
    });
    expect(await run(mysqlOnly, ['sql', '--statement-breakpoints'])).toEqual({ code: 0, out: mysqlNoteSchema.sql({ statementBreakpoints: true }), err: '' });
    expect(await run(mysqlOnly, ['sql', '--dialect', 'postgres'])).toEqual({
      code: 1,
      out: '',
      err: "npx @nestjs/notes: PostgreSQL isn't supported yet: the stores of @nestjs/notes run on MySQL.\n",
    });
    expect((await run(mysqlOnly, ['sql', '--schema', 'Shop'])).err).toContain('MySqlNoteStore: invalid schema "Shop".');
  });

  it('takes the URLs of its dialects only, and never prints one', async () => {
    expect(await run(mysqlOnly, ['migrate', '--url', 'postgres://admin:s3cret@db.internal/shop'])).toEqual({
      code: 1,
      out: '',
      err: "npx @nestjs/notes: PostgreSQL isn't supported yet: the stores of @nestjs/notes run on MySQL.\n",
    });
    expect(await run(mysqlOnly, ['status', '--url', 'mariadb://admin:s3cret@db.internal/shop'])).toEqual({
      code: 1,
      out: '',
      err: 'npx @nestjs/notes status takes a database URL that starts with mysql://.\n',
    });
    expect((await run(both, ['status', '--url', 'mariadb://admin:s3cret@db.internal/shop'])).err).toBe(
      'npx @nestjs/notes status takes a database URL that starts with postgres:// or postgresql:// or mysql://.\n',
    );
  });

  describe('on MySQL', () => {
    onMysql(reason);

    it('migrate applies the pending migrations once, and status exits with 1 until they are', async () => {
      const url = database!.url;
      expect(await run(both, ['status', '--url', url, '--schema', 'cli_store'])).toEqual({
        code: 1,
        out: 'Schema "cli_store" is at version 0; this version of @nestjs/notes needs version 2.\n',
        err: '',
      });
      expect(await run(both, ['migrate', '--schema', 'cli_store'], { DATABASE_URL: url })).toEqual({
        code: 0,
        out: 'Migrated schema "cli_store" to version 2 (applied 1, 2).\n',
        err: '',
      });
      expect(await run(mysqlOnly, ['migrate', '--url', url, '--schema', 'cli_store'])).toEqual({ code: 0, out: 'Schema "cli_store" is up to date (version 2).\n', err: '' });
      expect(await run(mysqlOnly, ['status', '--url', url, '--schema', 'cli_store'])).toEqual({
        code: 0,
        out: 'Schema "cli_store" is at version 2; this version of @nestjs/notes needs version 2.\n',
        err: '',
      });
      expect((await database!.admin.query('SELECT version FROM cli_store_migrations ORDER BY version'))[0]).toEqual([{ version: 1 }, { version: 2 }]);
    });

    it('reports a database it cannot migrate, or a URL without a database, and exits with 1', async () => {
      await database!.admin.query('CREATE TABLE cli_taken_note_tags (id int NOT NULL PRIMARY KEY)');
      expect(await run(mysqlOnly, ['migrate', '--url', database!.url, '--schema', 'cli_taken'])).toEqual({
        code: 1,
        out: '',
        err:
          'MySqlNoteStore: migrating schema "cli_taken" from version 0 to 2 stopped at migration 1 (initial), statement 2 of 4: ' +
          "Table 'cli_taken_note_tags' already exists. The statements before it are applied, and migrating again resumes at it.\n",
      });

      const noDatabase = new URL(database!.url);
      noDatabase.pathname = '/';
      expect(await run(mysqlOnly, ['status', '--url', noDatabase.toString()])).toEqual({
        code: 1,
        out: '',
        err: "MySqlNoteStore keeps its tables in the connection's database, and this connection has none: name one in the pool's or the ORM's settings (its database, or the URL's path).\n",
      });
    });
  });
});
