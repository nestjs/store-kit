import type { SqlTransaction } from '../../interfaces/sql-executor.interface.js';
import type { MySqlServer } from '../interfaces/mysql-store.interface.js';
import { mysqlErrorCode } from '../sql/errors.js';

/** The oldest MySQL a store starts on: `utf8mb4_0900_bin` is 8.0.17's, the row alias of ON DUPLICATE KEY UPDATE 8.0.19's. */
const OLDEST: readonly [number, number, number] = [8, 0, 19];

/** ER_UNKNOWN_COLLATION: MariaDB before 11.4.5 has no `utf8mb4_0900_bin`. */
const UNKNOWN_COLLATION = 1273;

/**
 * Checks the server and connection a MySQL store runs on, before anything else it does: MySQL 8.0.19 or later (8.4
 * LTS and 9.x are supported; 8.0 reached its end of life), or MariaDB for a store that opts in (`mariadb`) where
 * `utf8mb4_0900_bin` is MySQL's NO PAD binary collation (other servers are refused with a clear message rather than
 * failing on SQL); a strict `sql_mode` (without one, the server cuts a value too long for its column and writes a
 * default for a missing one, with only a warning); and a current database (the store's tables live in it). Resolves
 * to the database's name and the server.
 *
 * MariaDB is checked by its collation, not its version: `utf8mb4_0900_bin` arrived in 11.4.5 (MDEV-20912) as an alias
 * of the PAD SPACE `utf8mb4_bin`, and became NO PAD in 11.4.7 and 11.8.2 (MDEV-36361). On a padding one, `abc` and
 * `abc ` would be the same key.
 */
export async function checkServer(db: SqlTransaction, storeName: string, options: { mariadb?: boolean } = {}): Promise<{ database: string; server: MySqlServer }> {
  const [found] = await db.query<{ version?: unknown }>('SELECT VERSION() AS version');
  const version = String(found?.version ?? '');
  const server: MySqlServer = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
  if (server === 'mariadb') {
    if (!options.mariadb) {
      throw new Error(`${storeName} runs on MySQL, and this server is MariaDB (${version}): MariaDB isn't supported yet.`);
    }
    const problem = await collationProblem(db);
    if (problem) {
      throw new Error(
        `${storeName} runs on MySQL 8.4 LTS and 9.x, and on MariaDB 11.4.7 and later or 11.8.2 and later, where utf8mb4_0900_bin compares without padding, and this server (${version}) ${problem}.`,
      );
    }
  } else {
    // Aurora says "8.0.mysql_aurora.3.05.2": a minor version without a patch.
    const parsed = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
    if (!parsed) {
      const servers = options.mariadb ? 'MySQL or MariaDB' : 'MySQL';
      throw new Error(`${storeName} runs on ${servers}, and this server is ${version.split(' ').slice(0, 2).join(' ') || 'unknown'}.`);
    }
    const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), parsed[3] === undefined ? undefined : Number(parsed[3])];
    if (major < OLDEST[0] || (major === OLDEST[0] && minor === OLDEST[1] && patch !== undefined && patch < OLDEST[2])) {
      throw new Error(`${storeName} runs on MySQL 8.4 LTS and 9.x (8.0.19 and later may work), and this server is MySQL ${version}.`);
    }
  }

  const [settings] = await db.query<{ sql_mode?: unknown; current_database?: unknown }>('SELECT @@session.sql_mode AS sql_mode, DATABASE() AS current_database');
  const mode = String(settings?.sql_mode ?? '');
  if (!/(^|,)STRICT_(TRANS|ALL)_TABLES(,|$)/.test(mode)) {
    throw new Error(
      `${storeName} needs a strict sql_mode (STRICT_TRANS_TABLES, MySQL's default), and this connection's is "${mode}": without it, MySQL cuts a value too long for its column, ` +
        "and writes a default for a missing one, with only a warning. Set it back for the server, or for the store's connections (a pool of their own).",
    );
  }

  const database = settings?.current_database;
  if (typeof database !== 'string' || database.length === 0) {
    throw new Error(`${storeName} keeps its tables in the connection's database, and this connection has none: name one in the pool's or the ORM's settings (its database, or the URL's path).`);
  }
  return { database, server };
}

/** Why MariaDB's `utf8mb4_0900_bin` can't hold the store's keys, or `undefined` when it compares them byte for byte. */
async function collationProblem(db: SqlTransaction): Promise<string | undefined> {
  try {
    const [row] = await db.query<{ padded?: unknown }>("SELECT CAST(_utf8mb4'abc' = _utf8mb4'abc ' COLLATE utf8mb4_0900_bin AS CHAR) AS padded");
    return String(row?.padded) === '0' ? undefined : 'pads it, so abc and "abc " would be the same key';
  } catch (error) {
    if (mysqlErrorCode(error) === UNKNOWN_COLLATION) {
      return "doesn't have it";
    }
    throw error;
  }
}
