import type { SqlTransaction } from '../../interfaces/sql-executor.interface.js';

/** The oldest MySQL a store starts on: `utf8mb4_0900_bin` is 8.0.17's, the row alias of ON DUPLICATE KEY UPDATE 8.0.19's. */
const OLDEST: readonly [number, number, number] = [8, 0, 19];

/** The oldest MariaDB a store starts on: `utf8mb4_0900_bin` (with MySQL's NO PAD, binary comparison) is 11.4's. */
const OLDEST_MARIADB: readonly [number, number] = [11, 4];

/**
 * Checks the server and connection a MySQL store runs on, before anything else it does: MySQL 8.0.19 or later (8.4
 * LTS and 9.x are supported; 8.0 reached its end of life) or MariaDB 11.4 LTS or later (other servers are refused with
 * a clear message rather than failing on SQL), a strict `sql_mode` (without one, the server cuts a value too long for
 * its column and writes a default for a missing one, with only a warning), and a current database (the store's tables
 * live in it). Resolves to the database's name.
 */
export async function checkServer(db: SqlTransaction, storeName: string): Promise<{ database: string }> {
  const [server] = await db.query<{ version?: unknown }>('SELECT VERSION() AS version');
  const version = String(server?.version ?? '');
  // Aurora says "8.0.mysql_aurora.3.05.2": a minor version without a patch.
  const parsed = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (/mariadb/i.test(version)) {
    if (!parsed || Number(parsed[1]) < OLDEST_MARIADB[0] || (Number(parsed[1]) === OLDEST_MARIADB[0] && Number(parsed[2]) < OLDEST_MARIADB[1])) {
      throw new Error(`${storeName} runs on MySQL 8.4 LTS and 9.x, and on MariaDB 11.4 LTS and later, and this server is MariaDB ${version}.`);
    }
  } else {
    if (!parsed) {
      throw new Error(`${storeName} runs on MySQL, and this server is ${version.split(' ').slice(0, 2).join(' ') || 'unknown'}.`);
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
  return { database };
}
