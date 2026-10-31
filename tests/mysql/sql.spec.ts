/**
 * The helpers a MySQL store writes its statements with: SqlParams' placeholders, casts and values (whole numbers
 * checked, LIMIT written in, IN lists of strings or numbers), columns() and the readers, quoteIdentifier(), quoteTable()
 * and keyColumn(); lockKeys()'s row locks (held until the transaction ends, shared or exclusive, several keys sorted and
 * taken once, in READ COMMITTED and REPEATABLE READ transactions alike); ensureLockRows(), which creates lock rows ahead
 * of time so that a holder's rollback never deadlocks the transactions waiting for it; retryOnDeadlock() on a real
 * deadlock through every client; and mysqlErrorCode() on each client's error shapes.
 */
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import {
  columns,
  ensureLockRows,
  fromMysql2,
  keyColumn,
  lockKeys,
  lockRowId,
  mysqlErrorCode,
  quoteIdentifier,
  quoteTable,
  retryOnDeadlock,
  SqlParams,
  toBool,
  toInt,
  toJson,
  toText,
  type SqlExecutor,
  type SqlTransaction,
} from '../../lib/mysql/index.js';
import { mysqlNoteSchema } from '../fixtures/notes/mysql-note.schema.js';
import { clients, onMysql, testDatabase } from './support.js';

const { database, reason } = await testDatabase('sql');

describe('SqlParams on MySQL', () => {
  it('writes a ? per value, casts what isn\'t text, collects the values as strings in order, and writes NULL-safe equality and IN lists', () => {
    const p = new SqlParams();
    expect([p.text('a'), p.int(7), p.bigint(1_790_000_000_000), p.bool(false), p.bool(true), p.json({ a: 1 }), p.json(undefined), p.text(null), p.int(null)]).toEqual([
      '?',
      'CAST(? AS SIGNED)',
      'CAST(? AS SIGNED)',
      'CAST(? AS UNSIGNED)',
      'CAST(? AS UNSIGNED)',
      "JSON_EXTRACT(?, '$')",
      "JSON_EXTRACT(?, '$')",
      '?',
      'CAST(? AS SIGNED)',
    ]);
    expect(p.values).toEqual(['a', '7', '1790000000000', '0', '1', '{"a":1}', null, null, null]);

    const q = new SqlParams();
    expect(q.equals('group_key', null)).toBe('group_key IS NULL');
    expect(q.equals('group_key', 'g1')).toBe('group_key = ?');
    expect(q.in('state', [])).toBe('FALSE');
    expect(q.in('state', ['waiting', 'active'])).toBe('state IN (?, ?)');
    expect(q.values).toEqual(['g1', 'waiting', 'active']);
  });

  it('writes an IN list of whole numbers as CAST(? AS SIGNED), one kind a list, in the order of the values', () => {
    const p = new SqlParams();
    expect(p.in('m.seq', [3, 1_790_000_000_000, -2])).toBe('m.seq IN (CAST(? AS SIGNED), CAST(? AS SIGNED), CAST(? AS SIGNED))');
    expect(p.in('m.seq', [] as number[])).toBe('FALSE');
    expect(p.values).toEqual(['3', '1790000000000', '-2']);
    expect(() => new SqlParams().in('seq', [1, 'a'] as never)).toThrow('SqlParams.in() takes strings or numbers, not both: a column is compared with values of its own type.');
    expect(() => new SqlParams().in('id', ['a', 1] as never)).toThrow('SqlParams.in() takes strings or numbers, not both');
    for (const value of [1.5, Number.NaN, 2 ** 63]) {
      expect(() => new SqlParams().in('seq', [1, value])).toThrow(`SqlParams.in() takes whole numbers (or strings), not ${String(value)}.`);
    }
  });

  it('writes JSON with numbers other than safe integers as JSON_SET() of each at its path, cast from text as a DOUBLE', () => {
    const p = new SqlParams();
    expect(p.json({ n: 2 ** 53 - 1, list: [1, 0.5], 'a "b"': { c: 1e-30 } })).toBe("JSON_SET(JSON_EXTRACT(?, '$'), ?, CAST(? AS DOUBLE), ?, CAST(? AS DOUBLE))");
    expect(p.json(0.1 + 0.2)).toBe("JSON_SET(JSON_EXTRACT(?, '$'), ?, CAST(? AS DOUBLE))");
    expect(p.values).toEqual([
      '{"n":9007199254740991,"list":[1,0],"a \\"b\\"":{"c":0}}',
      '$."list"[1]',
      '0.5',
      '$."a \\"b\\""."c"',
      '1e-30',
      '0',
      '$',
      '0.30000000000000004',
    ]);
    // What JSON.stringify() writes is what's walked: toJSON(), and no undefined members.
    const q = new SqlParams();
    expect(q.json({ at: new Date(0), skipped: undefined, n: 2 ** 60 })).toBe("JSON_SET(JSON_EXTRACT(?, '$'), ?, CAST(? AS DOUBLE))");
    expect(q.values).toEqual(['{"at":"1970-01-01T00:00:00.000Z","n":0}', '$."n"', '1152921504606847000']);
  });

  describe('on the server', () => {
    onMysql(reason);

    it('finds the rows of INT and BIGINT columns by an IN list of numbers, through every client', async () => {
      for (const factory of clients) {
        const client = await factory.open(database!.url);
        try {
          const r = new SqlParams();
          const rows = await client.executor.query(
            `SELECT ${columns(['n', 'big'], 't')} FROM (SELECT CAST(1 AS SIGNED) AS n, CAST(1790000000000 AS SIGNED) AS big UNION ALL SELECT 2, 2 UNION ALL SELECT 3, 3) AS t
WHERE ${r.in('t.n', [1, 3, 4])} AND ${r.in('t.big', [1_790_000_000_000, 3])} ORDER BY t.n`,
            r.values,
          );
          expect(rows, factory.name).toEqual([
            { n: '1', big: '1790000000000' },
            { n: '3', big: '3' },
          ]);
        } finally {
          await client.close();
        }
      }
    });
  });

  it('refuses a number that isn\'t whole, which MySQL would round or wrap without an error, and writes LIMIT counts into the statement', () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 63]) {
      expect(() => new SqlParams().int(value)).toThrow(
        `SqlParams.int() takes a whole number (or null), not ${String(value)}: MySQL would round it, or wrap it past 2^63, without an error.`,
      );
      expect(() => new SqlParams().bigint(value)).toThrow(`SqlParams.bigint() takes a whole number (or null), not ${String(value)}`);
    }

    const p = new SqlParams();
    expect(`LIMIT ${p.limit(10)} OFFSET ${p.limit(0)}`).toBe('LIMIT 10 OFFSET 0');
    expect(p.values).toEqual([]);
    for (const value of [-1, 1.5, '10', Number.NaN]) {
      expect(() => p.limit(value as number)).toThrow(`SqlParams.limit() takes a whole number from 0, not ${JSON.stringify(value)}.`);
    }
  });
});

describe('columns(), the readers, and identifiers on MySQL', () => {
  it('cast each column to text under its own name, in backticks, prefixed with the alias, and read the text back', () => {
    expect(columns(['id', 'run_at'])).toBe('CAST(`id` AS CHAR) AS `id`, CAST(`run_at` AS CHAR) AS `run_at`');
    expect(columns(['id', 'rank'], 'j')).toBe('CAST(`j`.`id` AS CHAR) AS `id`, CAST(`j`.`rank` AS CHAR) AS `rank`');
    expect(() => columns(['id; DROP TABLE x'])).toThrow('Invalid MySQL identifier "id; DROP TABLE x"');

    expect([toText('a'), toText(null), toInt('1790000000000'), toInt(null), toBool('1'), toBool('0'), toBool(null), toJson('{"a": [1]}'), toJson(null)]).toEqual([
      'a',
      null,
      1_790_000_000_000,
      null,
      true,
      false,
      false,
      { a: [1] },
      null,
    ]);
  });

  it('quote identifiers and tables after checking them, and bound key columns', () => {
    expect(quoteIdentifier('key')).toBe('`key`');
    for (const name of ['', '1st', 'a`b', 'a b', 'x'.repeat(65), null]) {
      expect(() => quoteIdentifier(name)).toThrow(`Invalid MySQL identifier ${JSON.stringify(name)}: use letters, digits and underscores, not starting with a digit, at most 64 characters.`);
    }

    expect(quoteTable('nest_outbox', 'messages', 'MySqlOutboxStore')).toBe('`nest_outbox_messages`');
    expect(() => quoteTable('Nest', 'messages', 'MySqlOutboxStore')).toThrow('MySqlOutboxStore: invalid schema "Nest".');
    expect(() => quoteTable('nest_outbox', 'Messages', 'MySqlOutboxStore')).toThrow(
      'MySqlOutboxStore: invalid table name "Messages". Use lowercase letters, digits and underscores, starting with a letter.',
    );
    expect(() => quoteTable('nest_outbox', 'migrations', 'MySqlOutboxStore')).toThrow('MySqlOutboxStore: the table name "migrations" is taken');
    expect(() => quoteTable('x'.repeat(40), 'y'.repeat(24), 'MySqlOutboxStore')).toThrow('is 65 characters long, and MySQL allows 64: use a shorter schema.');

    expect(keyColumn(255)).toBe('varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin');
    for (const length of [0, 769, 1.5]) {
      expect(() => keyColumn(length)).toThrow(`keyColumn() takes a length from 1 to 768 characters (InnoDB's 3,072-byte index keys hold 768 four-byte characters), not ${length}.`);
    }
  });
});

describe('lockKeys()', () => {
  onMysql(reason);

  let pool: mysql.Pool;
  let executor: SqlExecutor;
  beforeAll(async () => {
    if (database) {
      pool = mysql.createPool({ uri: database.url, connectionLimit: 4 });
      executor = fromMysql2(pool);
      await mysqlNoteSchema.migrate(executor, 'sql_locks');
    }
  });
  afterAll(async () => {
    await pool?.end();
  });

  /** Holds `keys` in a transaction of its own until `release()`; `acquired` says whether it has them yet. */
  function holder(keys: string | string[], options: { shared?: boolean; isolationLevel?: 'read committed' | 'repeatable read' } = {}) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = false;
    const done = executor.transaction(
      async (tx) => {
        await lockKeys(tx, 'sql_locks', keys, options);
        acquired = true;
        await released;
      },
      { isolationLevel: options.isolationLevel ?? 'read committed' },
    );
    return { release, done, acquired: () => acquired };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('holds an exclusive lock until the transaction ends, in READ COMMITTED and REPEATABLE READ transactions alike', async () => {
    for (const isolationLevel of ['read committed', 'repeatable read'] as const) {
      const key = `exclusive:${isolationLevel}`;
      const first = holder(key, { isolationLevel });
      await settle();
      const second = holder(key, { isolationLevel });
      await settle();
      expect([first.acquired(), second.acquired()]).toEqual([true, false]);
      first.release();
      await first.done;
      await settle();
      expect(second.acquired()).toBe(true);
      second.release();
      await second.done;
    }
  });

  it("lets shared locks of a key share while excluding an exclusive one, once the key's row exists", async () => {
    const created = holder('shared');
    await settle();
    created.release();
    await created.done;

    const readers = [holder('shared', { shared: true }), holder('shared', { shared: true })];
    await settle();
    const writer = holder('shared');
    await settle();
    expect([...readers.map((reader) => reader.acquired()), writer.acquired()]).toEqual([true, true, false]);
    readers.forEach((reader) => reader.release());
    await Promise.all(readers.map((reader) => reader.done));
    await settle();
    expect(writer.acquired()).toBe(true);
    writer.release();
    await writer.done;
  });

  it("releases the lock when the transaction rolls back, and keys the row by the key's hash", async () => {
    const failing = executor.transaction(async (tx) => {
      await lockKeys(tx, 'sql_locks', 'rolled-back');
      throw new Error('changed my mind');
    });
    await expect(failing).rejects.toThrow('changed my mind');
    const next = holder('rolled-back');
    await settle();
    expect(next.acquired()).toBe(true);
    next.release();
    await next.done;

    const [row] = (await pool.query("SELECT COUNT(*) AS n FROM sql_locks_locks WHERE id = SHA2('rolled-back', 256)"))[0] as Array<{ n: number }>;
    expect(row).toEqual({ n: 1 });
  });

  it('takes several keys in two statements, ordered and deduplicated by their rows (the keys\' SHA-256), and shared ones one by one in that order', async () => {
    const taken: unknown[] = [];
    const tx: SqlTransaction = {
      query: async <R extends object>(text: string, params?: readonly unknown[]) => {
        taken.push([text, ...(params ?? [])]);
        return (text.includes('LOCK IN SHARE MODE') && params?.[0] === hash('k:held') ? [{ id: 'held' }] : []) as R[];
      },
      execute: async (text, params) => {
        taken.push([text, ...(params ?? [])]);
        return { affectedRows: 1 };
      },
    };
    const ordered = ['k:b', 'k:a', 'k:c'].map(hash).sort();
    await lockKeys(tx, 'nest_notes', ['k:b', 'k:a', 'k:b', 'k:c']);
    expect(taken).toEqual([
      ['INSERT INTO `nest_notes_locks` (id) VALUES (?), (?), (?) ON DUPLICATE KEY UPDATE id = id', ...ordered],
      ['SELECT id FROM `nest_notes_locks` WHERE id IN (?, ?, ?) ORDER BY id FOR UPDATE', ...ordered],
    ]);

    taken.length = 0;
    await lockKeys(tx, 'nest_notes', []);
    await lockKeys(tx, 'nest_notes', ['k:held', 'k:new'], { shared: true });
    const [first, second] = ['k:held', 'k:new'].map(hash).sort();
    const newest = hash('k:new');
    expect(taken).toEqual([
      ['SELECT id FROM `nest_notes_locks` WHERE id = ? LOCK IN SHARE MODE', first],
      ...(first === newest
        ? [
            ['INSERT INTO `nest_notes_locks` (id) VALUES (?) ON DUPLICATE KEY UPDATE id = id', first],
            ['SELECT id FROM `nest_notes_locks` WHERE id IN (?) ORDER BY id FOR UPDATE', first],
          ]
        : []),
      ['SELECT id FROM `nest_notes_locks` WHERE id = ? LOCK IN SHARE MODE', second],
      ...(second === newest
        ? [
            ['INSERT INTO `nest_notes_locks` (id) VALUES (?) ON DUPLICATE KEY UPDATE id = id', second],
            ['SELECT id FROM `nest_notes_locks` WHERE id IN (?) ORDER BY id FOR UPDATE', second],
          ]
        : []),
    ]);
  });

  it("can't deadlock: many transactions lock overlapping keys at once, in opposite argument orders", async () => {
    const keys = Array.from({ length: 6 }, (_, i) => `many:${i}`);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        executor.transaction(async (tx) => {
          await lockKeys(tx, 'sql_locks', i % 2 === 0 ? keys : [...keys].reverse(), { shared: i % 3 === 0 });
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        }, { isolationLevel: 'read committed' }),
      ),
    );
  });

  const lockRows = async (keys: string[]) => {
    const ids = keys.map(lockRowId);
    const [rows] = await pool.query(`SELECT id FROM sql_locks_locks WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`, ids);
    return (rows as Array<{ id: string }>).map((row) => row.id);
  };

  it('ensureLockRows() creates the rows of keys ahead of time, each once, and names a row as lockKeys() does (lockRowId())', async () => {
    expect(lockRowId('rolled-back')).toBe(hash('rolled-back'));
    const [[sha]] = (await pool.query("SELECT SHA2('fixed:é', 256) AS id")) as unknown as [[{ id: string }]];
    expect(lockRowId('fixed:é')).toBe(sha.id);

    await ensureLockRows(executor, 'sql_locks', ['fixed:a', 'fixed:b', 'fixed:a']);
    expect(await lockRows(['fixed:a', 'fixed:b'])).toEqual(['fixed:a', 'fixed:b'].map(lockRowId).sort());
    // Again, and from three processes at once: still one row a key.
    await ensureLockRows(executor, 'sql_locks', 'fixed:a');
    await Promise.all([1, 2, 3].map(() => ensureLockRows(executor, 'sql_locks', ['fixed:c', 'fixed:b', 'fixed:d'])));
    const [[{ n }]] = (await pool.query(`SELECT COUNT(*) AS n FROM sql_locks_locks WHERE id IN (?, ?, ?, ?)`, ['fixed:a', 'fixed:b', 'fixed:c', 'fixed:d'].map(lockRowId))) as unknown as [
      [{ n: number }],
    ];
    expect(n).toBe(4);

    // More keys than one statement takes (1,000 rows a statement).
    const many = Array.from({ length: 2_345 }, (_, i) => `bucket:${i}`);
    await ensureLockRows(executor, 'sql_locks', many);
    expect(await lockRows(many)).toHaveLength(2_345);
    await ensureLockRows(executor, 'sql_locks', []);
  });

  it("ensureLockRows() only notes a row that exists, without waiting for the transaction holding its lock, and takes no transaction", async () => {
    await ensureLockRows(executor, 'sql_locks', 'noted');
    const held = holder('noted');
    await settle();
    expect(held.acquired()).toBe(true);
    try {
      const started = Date.now();
      await ensureLockRows(executor, 'sql_locks', ['noted', 'noted:new']);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await lockRows(['noted', 'noted:new'])).toHaveLength(2);
    } finally {
      held.release();
      await held.done;
    }

    await executor.transaction(async (tx) => {
      await expect(ensureLockRows(tx as never, 'sql_locks', 'k')).rejects.toThrow(
        "ensureLockRows() takes the store's executor, not a transaction: it creates the rows in transactions of its own, which commit at once.",
      );
    });
    await expect(ensureLockRows(executor, 'Bad-Schema', 'k')).rejects.toThrow('ensureLockRows(): invalid schema "Bad-Schema".');
  });

  /**
   * One transaction takes a key's lock, two others wait for it, then the first rolls back: the waiters' outcomes (the
   * MySQL error number of those that failed). All three READ COMMITTED: no REPEATABLE READ gap locks are involved.
   */
  async function rollBackWhileTwoWait(key: string): Promise<Array<'committed' | number | string>> {
    const connections = await Promise.all([1, 2, 3].map(() => pool.getConnection()));
    try {
      const threads = await Promise.all(connections.map(async (c) => ((await c.query('SELECT CONNECTION_ID() AS id'))[0] as Array<{ id: number }>)[0]!.id));
      for (const connection of connections) {
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
      }
      const [first, ...waiters] = connections;
      await lockKeys(executor.wrapTransaction(first), 'sql_locks', key);
      const outcomes = waiters.map(async (connection) => {
        try {
          await lockKeys(executor.wrapTransaction(connection), 'sql_locks', key);
          await connection.commit();
          return 'committed' as const;
        } catch (error) {
          await connection.rollback();
          return mysqlErrorCode(error) ?? (error as Error).message;
        }
      });

      // Both wait for the first's lock. InnoDB serves INNODB_TRX from a cache it refreshes only once it hasn't been read
      // for 0.1 s: ask less often than that.
      for (let waiting = 0, polls = 0; waiting < waiters.length; polls++) {
        expect(polls).toBeLessThan(50);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const [[row]] = (await pool.query("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT' AND trx_mysql_thread_id IN (?)", [
          threads.slice(1),
        ])) as unknown as [[{ n: number }]];
        waiting = row.n;
      }
      await first!.rollback();
      return await Promise.all(outcomes);
    } finally {
      for (const connection of connections) {
        connection.release();
      }
    }
  }

  it("keeps the transactions waiting for a lock from deadlocking when its holder rolls back, if ensureLockRows() created its row: a row the holder's transaction created deadlocks them", async () => {
    await ensureLockRows(executor, 'sql_locks', 'ahead-of-time');
    expect(await rollBackWhileTwoWait('ahead-of-time')).toEqual(['committed', 'committed']);

    // The control: the first lock of a key creates its row, in the transaction that then rolls back.
    const outcomes = await rollBackWhileTwoWait(`created-in-the-transaction:${Date.now()}`);
    expect(outcomes.every((outcome) => outcome === 'committed' || outcome === 1213)).toBe(true);
    expect(outcomes).toContain(1213);
  });
});

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

describe.each(clients)('retryOnDeadlock() through $name', (factory) => {
  onMysql(reason);

  it("runs a store's own transaction again when MySQL rolled it back to break a deadlock, and it's READ COMMITTED", async () => {
    const client = await factory.open(database!.url);
    const table = `deadlocks_${factory.name.replace(/\W+/g, '_').toLowerCase()}`.slice(0, 60);
    try {
      await client.executor.execute(`CREATE TABLE ${table} (id varchar(8) NOT NULL PRIMARY KEY, n int NOT NULL)`);
      await client.executor.execute(`INSERT INTO ${table} (id, n) VALUES ('a', 0), ('b', 0)`);

      // Each locks its first row, waits until the other has its own, then asks for the other's: a deadlock, which MySQL
      // breaks by rolling one of them back. That one runs again, and waits for the other's row this time.
      const locked = { a: signal(), b: signal() };
      const attempts = { a: 0, b: 0 };
      const levels: string[] = [];
      const cross = (mine: 'a' | 'b', theirs: 'a' | 'b') =>
        retryOnDeadlock(client.executor, async (tx) => {
          attempts[mine]++;
          const [level] = await tx.query<{ level: string }>(
            'SELECT ISOLATION_LEVEL AS level FROM performance_schema.events_transactions_current WHERE THREAD_ID = (SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = CONNECTION_ID())',
          );
          levels.push(level!.level);
          await tx.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [mine]);
          if (attempts[mine] === 1) {
            locked[mine].resolve();
            await locked[theirs].promise;
          }
          await tx.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [theirs]);
          await tx.execute(`UPDATE ${table} SET n = n + 1`);
        });

      await Promise.all([cross('a', 'b'), cross('b', 'a')]);
      expect(attempts.a + attempts.b).toBe(3);
      expect(await client.executor.query(`SELECT id, CAST(n AS CHAR) AS n FROM ${table} ORDER BY id`)).toEqual([
        { id: 'a', n: '2' },
        { id: 'b', n: '2' },
      ]);
      expect(new Set(levels)).toEqual(new Set(['READ COMMITTED']));
    } finally {
      await client.executor.execute(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
      await client.close();
    }
  });
});

describe('retryOnDeadlock() and mysqlErrorCode()', () => {
  const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { errno: 1213, sqlState: '40001', sqlMessage: 'Deadlock found' });
  const executor = (work: () => unknown) => ({ transaction: async (run: (tx: never) => unknown) => run(work() as never) }) as unknown as SqlExecutor;

  it('gives up after `attempts` runs, rethrows any other error at once, and takes a whole number of attempts from 1', async () => {
    let runs = 0;
    const failing = executor(() => undefined);
    await expect(
      retryOnDeadlock(
        failing,
        async () => {
          runs++;
          throw deadlock();
        },
        { attempts: 2 },
      ),
    ).rejects.toThrow('Deadlock found');
    expect(runs).toBe(2);

    runs = 0;
    const duplicate = Object.assign(new Error('Duplicate entry'), { errno: 1062, sqlMessage: 'Duplicate entry' });
    await expect(
      retryOnDeadlock(failing, async () => {
        runs++;
        throw duplicate;
      }),
    ).rejects.toBe(duplicate);
    expect(runs).toBe(1);
    await expect(retryOnDeadlock(failing, async () => 1, { attempts: 0 })).rejects.toThrow('retryOnDeadlock() takes a whole number of attempts from 1, not 0.');
  });

  it("reads MySQL's error number from mysql2's, Drizzle's, TypeORM's and Prisma's errors, and none from other errors", () => {
    const server = deadlock();
    expect(mysqlErrorCode(server)).toBe(1213);
    expect(mysqlErrorCode(Object.assign(new Error('Failed query: ...'), { cause: server }))).toBe(1213);
    expect(mysqlErrorCode(Object.assign(new Error('QueryFailedError'), { driverError: server }))).toBe(1213);
    expect(mysqlErrorCode({ code: 'P2034', meta: { driverAdapterError: { cause: { originalCode: '1213', originalMessage: 'Deadlock found' } } } })).toBe(1213);
    expect(mysqlErrorCode(Object.assign(new Error('connect ECONNREFUSED'), { errno: -61, code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(mysqlErrorCode(Object.assign(new Error('relation "x" already exists'), { code: '42P07' }))).toBeUndefined();
    expect(mysqlErrorCode(undefined)).toBeUndefined();
  });
});

function signal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
