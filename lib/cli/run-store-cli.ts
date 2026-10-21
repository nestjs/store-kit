import { parseArgs } from 'node:util';
import type { CliStoreSchema } from '../interfaces/cli-store-schema.interface.js';
import type { StoreCliIo } from '../interfaces/store-cli-io.interface.js';
import { DIALECT_NAMES, type SqlDialect } from '../schema/dialect.js';
import { CLI_DIALECTS, URL_SCHEMES } from './cli-dialects.js';

/**
 * A package's command for its stores' schemas (`npx @nestjs/outbox migrate|status|sql`), from a shell or a CI step:
 * resolves to the process's exit code. `migrate` and `status` reach the database of the URL's dialect (`postgres://`,
 * `postgresql://`, `mysql://`) with its driver from the application's dependencies (`pg`, `mysql2`); `sql` prints the
 * SQL of `--dialect` (default: the only one, or `postgres`) and needs no database. `schemas` holds one `StoreSchema`
 * per dialect the package's stores run on (`[pgSchema, mysqlSchema]`). A package's bin:
 *
 * ```ts
 * #!/usr/bin/env node
 * import { runStoreCli } from '@nestjs/store-kit';
 * import { outboxSchema } from './outbox.schema.js';
 *
 * process.exitCode = await runStoreCli([outboxSchema], process.argv.slice(2));
 * ```
 */
export async function runStoreCli(schemas: readonly CliStoreSchema[], argv: readonly string[], io: StoreCliIo = processIo()): Promise<number> {
  const [first] = schemas;
  const dialects = new Set(schemas.map((schema) => schema.dialect));
  if (!first || dialects.size !== schemas.length || schemas.some((schema) => schema.command !== first.command || schema.packageName !== first.packageName)) {
    throw new TypeError("runStoreCli() takes the schemas of one package's stores: at least one, one per dialect, with the same command.");
  }

  // The package's bin as users run it: npx runs a package's only bin by the package's name.
  const command = `npx ${first.packageName}`;
  const usage = usageOf(schemas);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${usage}`);
    return 1;
  }

  const { positionals, values } = parsed;
  const [name] = positionals;
  if (values.help || name === undefined || name === 'help') {
    (name === undefined && !values.help ? io.err : io.out)(usage);
    return name === undefined && !values.help ? 1 : 0;
  }

  try {
    if (name === 'sql') {
      const schema = pick(schemas, dialectOption(values.dialect, schemas));
      io.out(
        schema.sql({
          schema: values.schema ?? schema.defaultSchema,
          from: version(values.from, '--from'),
          to: version(values.to, '--to'),
          statementBreakpoints: values['statement-breakpoints'],
        }),
      );
      return 0;
    }
    if (name !== 'migrate' && name !== 'status') {
      io.err(`Unknown command "${name}".\n\n${usage}`);
      return 1;
    }

    const url = values.url ?? io.env.DATABASE_URL;
    if (!url) {
      io.err(`${command} ${name} needs the database: pass --url, or set DATABASE_URL.\n`);
      return 1;
    }

    const schema = pick(schemas, dialectOfUrl(url, `${command} ${name}`, schemas));
    const dialect = CLI_DIALECTS[schema.dialect]!;
    const database = await dialect.open(url);
    if (!database) {
      io.err(
        `${command} needs the ${dialect.driver} package to reach the database (npm i ${dialect.driver}), or print the SQL with \`${command} sql\` and apply it with your own tool.\n`,
      );
      return 1;
    }

    const target = values.schema ?? schema.defaultSchema;
    try {
      if (name === 'status') {
        const current = await schema.version(database.executor, target);
        io.out(`Schema "${target}" is at version ${current}; this version of ${schema.packageName} needs version ${schema.latest}.\n`);
        return current >= schema.latest ? 0 : 1;
      }

      const applied = await schema.migrate(database.executor, target);
      io.out(
        applied.length > 0
          ? `Migrated schema "${target}" to version ${applied.at(-1)} (applied ${applied.join(', ')}).\n`
          : `Schema "${target}" is up to date (version ${await schema.version(database.executor, target)}).\n`,
      );
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    io.err(`${(error as Error)?.message ?? error}\n`);
    return 1;
  }
}

function usageOf(schemas: readonly CliStoreSchema[]): string {
  const [{ packageName, defaultSchema }] = schemas;
  // One line over the commands, which serve every store: "PostgresOutboxStore's schema (@nestjs/outbox/postgres):",
  // or "... (@nestjs/outbox/postgres) or MySqlOutboxStore's (@nestjs/outbox/mysql):" for a package with both.
  const named = schemas.map((schema, i) => `${schema.storeName}'s${i === 0 ? ' schema' : ''} (${schema.packageName}/${schema.dialect})`);
  const stores = `${named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named.at(-1)}` : named[0]}:`;
  // A PostgreSQL package's usage reads as it did before the kit knew MySQL.
  const mysql = schemas.some((schema) => schema.dialect === 'mysql');
  const postgres = schemas.some((schema) => schema.dialect === 'postgres');
  const migrate = !mysql
    ? "Apply the migrations the schema hasn't had yet (one transaction, under an advisory lock)"
    : `Apply the migrations the schema hasn't had yet${postgres ? ' (PostgreSQL: one transaction, under an advisory lock;\n            MySQL: ' : ' ('}one statement at a time, under GET_LOCK(), resuming where a failed run stopped)`;
  const urls = [...(postgres ? ['postgres://...'] : []), ...(mysql ? ['mysql://...'] : [])].join(' or ');
  return `Usage: npx ${packageName} <command> [options]

${stores}

  migrate   ${migrate}
  status    Print the schema's version and the one this version of ${packageName} needs;
            exit with 1 while it is behind
  sql       Print the migrations' SQL, for your own migration tool (no database needed)

Options:
  --url <url>        The database (${urls}). Default: $DATABASE_URL
  --schema <name>    The store's schema. Default: ${defaultSchema}
  --from <version>   sql: the version to start from. Default: 0 (a new database)
  --to <version>     sql: the version to end at. Default: the latest
  --dialect <name>   sql: the database it's for (${schemas.map((schema) => schema.dialect).join(', ')}). Default: ${defaultDialect(schemas)}
  --statement-breakpoints
                     sql: separate the statements with drizzle-kit's "--> statement-breakpoint",
                     for a custom drizzle-kit migration (drizzle-kit generate --custom)
`;
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      schema: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      dialect: { type: 'string' },
      'statement-breakpoints': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

function version(value: string | undefined, option: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${option} takes a version number, not "${value}".`);
  }
  return Number(value);
}

function defaultDialect(schemas: readonly CliStoreSchema[]): SqlDialect {
  return schemas.length === 1 ? schemas[0]!.dialect : 'postgres';
}

function dialectOption(value: string | undefined, schemas: readonly CliStoreSchema[]): SqlDialect {
  if (value === undefined) {
    return defaultDialect(schemas);
  }
  if (!Object.hasOwn(DIALECT_NAMES, value)) {
    throw new TypeError(`--dialect takes ${Object.keys(DIALECT_NAMES).join(' or ')}, not "${value}".`);
  }
  return value as SqlDialect;
}

/** The URL's dialect, by its scheme; the URL itself never goes into a message, as it may hold a password. */
function dialectOfUrl(url: string, what: string, schemas: readonly CliStoreSchema[]): SqlDialect {
  let scheme: string | undefined;
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = undefined;
  }

  const dialect = scheme === undefined || !Object.hasOwn(URL_SCHEMES, scheme) ? undefined : URL_SCHEMES[scheme];
  if (dialect === undefined) {
    const schemes = Object.keys(URL_SCHEMES).filter((known) => schemas.some((schema) => schema.dialect === URL_SCHEMES[known]));
    throw new TypeError(`${what} takes a database URL that starts with ${schemes.map((known) => `${known}//`).join(' or ')}.`);
  }
  return dialect;
}

/** The package's schema of `dialect`: a dialect the package has no store of (yet) fails. */
function pick(schemas: readonly CliStoreSchema[], dialect: SqlDialect): CliStoreSchema {
  const schema = schemas.find((candidate) => candidate.dialect === dialect);
  if (schema) {
    return schema;
  }

  const [{ packageName }] = schemas;
  const supported = schemas.map((candidate) => DIALECT_NAMES[candidate.dialect]).join(' and ');
  throw new Error(`npx ${packageName}: ${DIALECT_NAMES[dialect]} isn't supported yet: the stores of ${packageName} run on ${supported}.`);
}

function processIo(): StoreCliIo {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    env: process.env,
  };
}
