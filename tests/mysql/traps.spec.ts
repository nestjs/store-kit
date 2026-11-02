/**
 * MySQL's traps a store is built around, each shown on the server and with what the kit does about it (on MariaDB
 * too, where a trap differs or doesn't exist, as noted at it):
 *
 * - collation: the default compares case- and accent-insensitively, `utf8mb4_bin` ignores trailing spaces;
 *   keyColumn()'s `utf8mb4_0900_bin` keeps `abc`, `ABC`, `ábc` and `abc ` apart;
 * - key length: InnoDB's 3,072-byte index keys bound keyColumn(); a longer value fails in strict mode, and is cut
 *   without it (why readiness refuses a lax sql_mode, readiness.spec.ts);
 * - INSERT IGNORE turns errors into warnings: the kit's insert-if-absent catches ER_DUP_ENTRY instead;
 * - no RETURNING: a claim is SELECT ... FOR UPDATE SKIP LOCKED, then an UPDATE, in one READ COMMITTED transaction, and
 *   claimers at once never take a row twice;
 * - time: epoch milliseconds in a BIGINT read the same in every session time zone, where a TIMESTAMP moves;
 * - foreign keys: a child's insert takes a shared lock on its parent row;
 * - keywords: MySQL 8 reserves names such as `rank` and `first_value`: columns() puts every column in backticks;
 * - LIMIT ?: a client that binds on its side sends `LIMIT '10'`, a syntax error: SqlParams.limit() writes the number;
 * - values: BIGINT and JSON come back parsed, differently per client, unless read as text (columns()).
 *
 * Every table has a primary key (sql_require_primary_key: migrations.spec.ts).
 */
import mysql from 'mysql2/promise';
import { columns, fromMysql2, keyColumn, mysqlErrorCode, retryOnDeadlock, SqlParams, toInt, toJson, type SqlExecutor } from '../../lib/mysql/index.js';
import { onMysql, testDatabase } from './support.js';

const { database, reason } = await testDatabase('traps');

describe("MySQL's traps", () => {
  onMysql(reason);

  let pool: mysql.Pool;
  let executor: SqlExecutor;
  beforeAll(() => {
    if (database) {
      pool = mysql.createPool({ uri: database.url, connectionLimit: 4 });
      executor = fromMysql2(pool);
    }
  });
  afterAll(async () => {
    await pool?.end();
  });

  const insertAll = async (table: string, keys: string[]) => {
    const outcomes: string[] = [];
    for (const key of keys) {
      outcomes.push(
        await executor.execute(`INSERT INTO ${table} (k) VALUES (?)`, [key]).then(
          () => `${JSON.stringify(key)} inserted`,
          (error: unknown) => `${JSON.stringify(key)} ${mysqlErrorCode(error) === 1062 ? 'duplicate' : String(error)}`,
        ),
      );
    }
    return outcomes;
  };

  it('collation: keyColumn() keeps abc, ABC, ábc and "abc " apart, where the default merges case and accents and utf8mb4_bin trailing spaces', async () => {
    const keys = ['abc', 'ABC', 'ábc', 'abc '];
    await executor.execute(`CREATE TABLE trap_keys_default (k varchar(20) NOT NULL PRIMARY KEY)`);
    await executor.execute(`CREATE TABLE trap_keys_bin (k varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY)`);
    await executor.execute(`CREATE TABLE trap_keys_kit (k ${keyColumn(20)} NOT NULL PRIMARY KEY)`);

    // MariaDB's default (utf8mb4_uca1400_ai_ci) ignores trailing spaces too.
    expect(await insertAll('trap_keys_default', keys)).toEqual(['"abc" inserted', '"ABC" duplicate', '"ábc" duplicate', database?.mariadb ? '"abc " duplicate' : '"abc " inserted']);
    expect(await insertAll('trap_keys_bin', keys)).toEqual(['"abc" inserted', '"ABC" inserted', '"ábc" inserted', '"abc " duplicate']);
    expect(await insertAll('trap_keys_kit', keys)).toEqual(keys.map((key) => `${JSON.stringify(key)} inserted`));
    // A lookup compares by the column's collation, not the connection's: the text goes bare (?).
    const p = new SqlParams();
    expect(await executor.query(`SELECT k FROM trap_keys_kit WHERE k = ${p.text('ABC')}`, p.values)).toEqual([{ k: 'ABC' }]);
  });

  it("key length: keyColumn() stops at InnoDB's 768 four-byte characters, and a longer value fails in strict mode, where a lax one cuts it", async () => {
    expect(() => keyColumn(769)).toThrow(RangeError);
    await executor.execute(`CREATE TABLE trap_widest (k ${keyColumn(768)} NOT NULL PRIMARY KEY)`);
    const tooWide = await executor.execute(`CREATE TABLE trap_too_wide (k varchar(769) CHARACTER SET utf8mb4 NOT NULL PRIMARY KEY)`).catch((e: unknown) => e);
    expect(mysqlErrorCode(tooWide)).toBe(1071); // Specified key was too long; max key length is 3072 bytes

    await executor.execute(`CREATE TABLE trap_ids (k ${keyColumn(255)} NOT NULL PRIMARY KEY)`);
    const long = 'x'.repeat(256);
    const failed = await executor.execute('INSERT INTO trap_ids (k) VALUES (?)', [long]).catch((e: unknown) => e);
    expect(mysqlErrorCode(failed)).toBe(1406); // Data too long for column 'k'
    expect(await executor.query('SELECT k FROM trap_ids')).toEqual([]);

    const lax = await pool.getConnection();
    try {
      await lax.query("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'");
      await lax.query('INSERT INTO trap_ids (k) VALUES (?)', [long]);
      expect(await executor.query('SELECT CAST(CHAR_LENGTH(k) AS CHAR) AS n FROM trap_ids')).toEqual([{ n: '255' }]);
    } finally {
      lax.destroy();
    }
  });

  it("INSERT IGNORE: turns a value too long for its column into a warning and cuts it, where the kit's insert surfaces the error, and a duplicate as 1062", async () => {
    await executor.execute(`CREATE TABLE trap_ignore (k ${keyColumn(8)} NOT NULL PRIMARY KEY)`);
    expect(await executor.execute('INSERT IGNORE INTO trap_ignore (k) VALUES (?)', ['much-too-long'])).toEqual({ affectedRows: 1 });
    expect(await executor.query('SELECT k FROM trap_ignore')).toEqual([{ k: 'much-too' }]);

    const surfaced = await executor.execute('INSERT INTO trap_ignore (k) VALUES (?)', ['also-far-too-long']).catch((e: unknown) => e);
    expect(mysqlErrorCode(surfaced)).toBe(1406);
    const duplicate = await executor.execute('INSERT INTO trap_ignore (k) VALUES (?)', ['much-too']).catch((e: unknown) => e);
    expect(mysqlErrorCode(duplicate)).toBe(1062);
  });

  it('no RETURNING: claims (SELECT ... FOR UPDATE SKIP LOCKED, then an UPDATE, in one READ COMMITTED transaction) at once never take a job twice', async () => {
    await executor.execute(`CREATE TABLE trap_jobs (id ${keyColumn(32)} NOT NULL PRIMARY KEY, run_at bigint NOT NULL, owner varchar(32))`);
    const p = new SqlParams();
    const jobs = Array.from({ length: 20 }, (_, i) => `(${p.text(`job-${String(i).padStart(2, '0')}`)}, ${p.bigint(i)})`);
    await executor.execute(`INSERT INTO trap_jobs (id, run_at) VALUES ${jobs.join(', ')}`, p.values);

    const claim = (owner: string) =>
      retryOnDeadlock(executor, async (tx) => {
        const q = new SqlParams();
        const due = await tx.query<{ id: string }>(
          `SELECT ${columns(['id'], 'j')} FROM trap_jobs j WHERE j.owner IS NULL ORDER BY j.run_at, j.id LIMIT ${q.limit(3)} FOR UPDATE SKIP LOCKED`,
          q.values,
        );
        if (due.length === 0) {
          return [];
        }
        const u = new SqlParams();
        const { affectedRows } = await tx.execute(`UPDATE trap_jobs SET owner = ${u.text(owner)} WHERE ${u.in('id', due.map((job) => job.id))}`, u.values);
        expect(affectedRows).toBe(due.length);
        return due.map((job) => job.id);
      });
    const claimer = async (owner: string) => {
      const taken: string[] = [];
      for (let batch = await claim(owner); batch.length > 0; batch = await claim(owner)) {
        taken.push(...batch);
      }
      return taken;
    };

    const taken = (await Promise.all(['w1', 'w2', 'w3', 'w4'].map(claimer))).flat();
    expect(taken.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `job-${String(i).padStart(2, '0')}`));
    expect(await executor.query('SELECT id FROM trap_jobs WHERE owner IS NULL')).toEqual([]);
  });

  it('time: epoch milliseconds in a BIGINT read the same in every session time zone, where a TIMESTAMP moves with it', async () => {
    await executor.execute('CREATE TABLE trap_times (id int NOT NULL PRIMARY KEY, at_ms bigint NOT NULL, at_ts timestamp NOT NULL)');
    const at = Date.UTC(2026, 8, 30, 12, 0, 0, 250);
    const utc = await pool.getConnection();
    const kolkata = await pool.getConnection();
    try {
      await utc.query("SET SESSION time_zone = '+00:00'");
      await kolkata.query("SET SESSION time_zone = '+05:30'");
      const p = new SqlParams();
      await utc.query(`INSERT INTO trap_times (id, at_ms, at_ts) VALUES (1, ${p.bigint(at)}, '2026-09-30 12:00:00')`, p.values);

      const read = async (connection: mysql.PoolConnection) =>
        ((await connection.query(`SELECT ${columns(['at_ms', 'at_ts'], 't')} FROM trap_times t WHERE t.id = 1`))[0] as Array<Record<string, string>>)[0]!;
      const [inUtc, inKolkata] = [await read(utc), await read(kolkata)];
      expect([toInt(inUtc.at_ms), toInt(inKolkata.at_ms)]).toEqual([at, at]);
      expect([inUtc.at_ts, inKolkata.at_ts]).toEqual(['2026-09-30 12:00:00', '2026-09-30 17:30:00']);
    } finally {
      utc.destroy();
      kolkata.destroy();
    }
  });

  it("foreign keys: a child's insert takes a shared lock on its parent row, which another transaction's FOR UPDATE then meets", async () => {
    await executor.execute(`CREATE TABLE trap_parents (id ${keyColumn(16)} NOT NULL PRIMARY KEY)`);
    await executor.execute(`CREATE TABLE trap_children (id ${keyColumn(16)} NOT NULL PRIMARY KEY, parent_id ${keyColumn(16)} NOT NULL, FOREIGN KEY (parent_id) REFERENCES trap_parents (id))`);
    await executor.execute("INSERT INTO trap_parents (id) VALUES ('p')");

    const child = await pool.getConnection();
    try {
      await child.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await child.beginTransaction();
      await child.query("INSERT INTO trap_children (id, parent_id) VALUES ('c', 'p')");
      const blocked = await executor
        .transaction((tx) => tx.query("SELECT id FROM trap_parents WHERE id = 'p' FOR UPDATE NOWAIT"), { isolationLevel: 'read committed' })
        .catch((e: unknown) => e);
      // Statement aborted because lock(s) could not be acquired immediately and NOWAIT is set; MariaDB says lock wait timeout.
      expect(mysqlErrorCode(blocked)).toBe(database?.mariadb ? 1205 : 3572);
      await child.rollback();
    } finally {
      child.release();
    }
    expect(await executor.transaction((tx) => tx.query("SELECT id FROM trap_parents WHERE id = 'p' FOR UPDATE NOWAIT"))).toEqual([{ id: 'p' }]);
  });

  it('keywords: MySQL 8 reserves rank and first_value, which columns() puts in backticks', async () => {
    await executor.execute('CREATE TABLE trap_words (id int NOT NULL PRIMARY KEY, `rank` int NOT NULL)');
    await executor.execute('INSERT INTO trap_words (id, `rank`) VALUES (1, 7)');
    // MariaDB reserves neither: the backticks are harmless there.
    if (!database?.mariadb) {
      expect(mysqlErrorCode(await executor.query('SELECT rank FROM trap_words').catch((e: unknown) => e))).toBe(1064);
      expect(mysqlErrorCode(await executor.query('SELECT 1 AS first_value').catch((e: unknown) => e))).toBe(1064);
    }
    expect(await executor.query(`SELECT ${columns(['id', 'rank'], 'w')} FROM trap_words w`)).toEqual([{ id: '1', rank: '7' }]);
  });

  it("LIMIT ?: a client that binds on its side sends LIMIT '1', a syntax error, so SqlParams.limit() writes the number", async () => {
    expect(mysqlErrorCode(await executor.query('SELECT 1 AS one LIMIT ?', ['1']).catch((e: unknown) => e))).toBe(1064);
    const p = new SqlParams();
    expect(await executor.query(`SELECT ${p.text('1')} AS one LIMIT ${p.limit(1)}`, p.values)).toEqual([{ one: '1' }]);
  });

  it("values: mysql2 parses a BIGINT past 2^53 and a JSON column its own way, where columns() reads their text", async () => {
    await executor.execute('CREATE TABLE trap_values (id int NOT NULL PRIMARY KEY, big bigint NOT NULL, doc json NOT NULL)');
    const p = new SqlParams();
    await executor.execute(`INSERT INTO trap_values (id, big, doc) VALUES (1, CAST(${p.text('9007199254740993')} AS SIGNED), ${p.json({ z: 1, a: [true] })})`, p.values);
    const [raw] = (await pool.query('SELECT big, doc FROM trap_values'))[0] as Array<{ big: number; doc: unknown }>;
    expect(raw).toEqual({ big: 9007199254740992, doc: { a: [true], z: 1 } });
    const [text] = await executor.query<Record<string, string>>(`SELECT ${columns(['big', 'doc'], 'v')} FROM trap_values v`);
    // MySQL stores a document normalized (its members sorted), MariaDB as it was written: toJson() reads either.
    expect(text).toEqual({ big: '9007199254740993', doc: database?.mariadb ? '{"z": 1, "a": [true]}' : '{"a": [true], "z": 1}' });
    expect(toJson(text!.doc)).toEqual({ z: 1, a: [true] });
  });
});
