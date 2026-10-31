import type { SqlExecuteResult, SqlIsolationLevel, SqlTransaction } from '../interfaces/sql-executor.interface.js';
import { columns, toBool, toInt, toJson, toText } from '../mysql/sql/columns.js';
import { SqlParams } from '../mysql/sql/sql-params.js';
import { equal, isTypeError, jitter, messages, rejection, setsNative } from './assertions.js';
import type { DialectCases } from './sql-executor.contract.js';

const ISOLATION_LEVELS: SqlIsolationLevel[] = ['read uncommitted', 'read committed', 'repeatable read', 'serializable'];

/** The connection's thread in `performance_schema`: MySQL's `PS_CURRENT_THREAD_ID()`, which MariaDB doesn't have. */
const THIS_THREAD = '(SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = CONNECTION_ID())';

/**
 * The contract's cases in the SQL of MySQL and MariaDB. A transaction's own isolation level and identity aren't in any
 * variable (`@@transaction_isolation` is the connection's), so the isolation and connection cases read
 * `performance_schema.events_transactions_current`: on by default on MySQL, and readable with SELECT on
 * `performance_schema`. MariaDB needs the performance schema on (`--performance-schema=ON`, a startup option) and its
 * `events_transactions_current` consumer and `transaction` instrument enabled (both off by default).
 */
export const MYSQL_CASES: DialectCases = {
  createTable: (table) =>
    `CREATE TABLE ${table} (id varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL PRIMARY KEY, small_n int, big_n bigint, is_flag boolean, doc_json json, note_text text)`,
  dropTable: (table) => `DROP TABLE IF EXISTS ${table}`,
  cases: {
    async statements({ executor }, table) {
      // Not first_value: FIRST_VALUE is a window function, a reserved word since MySQL 8.0.
      const rows = await executor.query('SELECT ? AS first_param, ? AS second_param, CAST(CAST(? AS SIGNED) AS CHAR) AS big_param', [
        "O'Reilly — ü 🚀 \\ ?",
        null,
        '9007199254740993',
      ]);
      equal(rows, [{ first_param: "O'Reilly — ü 🚀 \\ ?", second_param: null, big_param: '9007199254740993' }], 'query() of a SELECT with parameters');
      equal(await executor.query(`INSERT INTO ${table} (id) VALUES (?)`, ['plain']), [], 'query() of an INSERT');
      equal(await executor.query(`DELETE FROM ${table} WHERE id = ?`, ['plain']), [], 'query() of a DELETE');

      const execute = executeOf(executor, 'the executor');
      equal(await execute(`INSERT INTO ${table} (id, small_n) VALUES (?, 1), (?, 1)`, ['w1', 'w2']), { affectedRows: 2 }, 'execute() of an INSERT of two rows');
      equal(
        await execute(`UPDATE ${table} SET small_n = small_n WHERE id IN (?, ?, ?)`, ['w1', 'w2', 'missing']),
        { affectedRows: 2 },
        "execute() of an UPDATE that matches two rows and changes nothing in them (the rows it matched: the client's FOUND_ROWS flag)",
      );
      equal(await execute(`UPDATE ${table} SET small_n = small_n + 1 WHERE id = ?`, ['w1']), { affectedRows: 1 }, 'execute() of an UPDATE that changes one row');
      equal(await execute(`DELETE FROM ${table} WHERE id = ?`, ['w1']), { affectedRows: 1 }, 'execute() of a DELETE of one row');
      equal(await execute(`DELETE FROM ${table} WHERE id = ?`, ['w1']), { affectedRows: 0 }, 'execute() of a DELETE of no rows');
      await execute(`DELETE FROM ${table}`);

      const failure = await rejection(executor.query(`SELECT id FROM ${table}_missing WHERE id = ?`, ['none']), 'query() of a failing statement');
      includes(messages(failure), "doesn't exist", 'query() of a failing statement');
      equal(await executor.query('SELECT ? AS status', ['next']), [{ status: 'next' }], 'query() after a failed statement');
    },

    async transactions({ executor }, table) {
      const result = await executor.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} (id) VALUES (?)`, ['kept']);
        equal(await executeOf(tx, 'a transaction')(`UPDATE ${table} SET note_text = ? WHERE id = ?`, ['in the transaction', 'kept']), { affectedRows: 1 }, 'execute() in a transaction');
        return (await tx.query(`SELECT id FROM ${table} WHERE id = ?`, ['kept'])).length;
      });
      equal(result, 1, "a committed transaction's result");

      const failure = new Error('changed my mind');
      const rolledBack = await rejection(
        executor.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} (id) VALUES (?)`, ['undone']);
          throw failure;
        }),
        'a transaction whose work rejects',
      );
      if (rolledBack !== failure) {
        throw new Error(`a transaction whose work rejects: expected it to reject with the work's error, got ${messages(rolledBack)}`);
      }

      const duplicate = await rejection(
        executor.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} (id) VALUES (?)`, ['partial']);
          await tx.query(`INSERT INTO ${table} (id) VALUES (?)`, ['kept']);
        }),
        'a transaction whose statement fails',
      );
      includes(messages(duplicate), 'Duplicate entry', 'a transaction whose statement fails');
      equal(await ids(executor, table), ['kept'], 'the rows after a committed transaction and two rolled back');
      equal(await executor.transaction((tx) => tx.query('SELECT ? AS status', ['next'])), [{ status: 'next' }], 'a transaction after failed ones');
    },

    async isolation({ executor }, table) {
      const [connection] = await executor.query<{ level: string }>('SELECT @@session.transaction_isolation AS level');
      const own = connection!.level;
      const level = (isolationLevel?: SqlIsolationLevel) => executor.transaction((tx) => transactionIsolation(tx), isolationLevel ? { isolationLevel } : undefined);
      for (const isolationLevel of ISOLATION_LEVELS) {
        const seen = await level(isolationLevel);
        equal(seen.level, isolationLevel, `a transaction at ${isolationLevel}`);
        equal(seen.connection, own, `the connection's own level during a transaction at ${isolationLevel} (a transaction's level is set for the transaction, not the session)`);
      }
      equal((await level()).level, own.replace('-', ' ').toLowerCase(), "a transaction without an isolation level (the connection's)");

      const refused = await rejection(
        executor.transaction(
          async (tx) => {
            await tx.query(`INSERT INTO ${table} (id) VALUES (?)`, ['ran']);
          },
          { isolationLevel: `snapshot; DROP TABLE ${table}` as SqlIsolationLevel },
        ),
        'a transaction at an unknown isolation level',
      );
      isTypeError(refused, 'a transaction at an unknown isolation level');
      equal(await ids(executor, table), [], 'the rows after a transaction at an unknown isolation level');
    },

    async joins({ executor, transaction, root }, table) {
      const failure = new Error('rolled back by the application');
      const rolledBack = await rejection(
        transaction(async (tx) => {
          await executor.wrapTransaction(tx).query(`INSERT INTO ${table} (id) VALUES (?)`, ['rolled-back']);
          throw failure;
        }),
        "the application's transaction that rejects",
      );
      includes(messages(rolledBack), failure.message, "the application's transaction that rejects");
      await transaction((tx) => executor.wrapTransaction(tx).query(`INSERT INTO ${table} (id) VALUES (?)`, ['committed']));
      equal(await ids(executor, table), ['committed'], "the rows after the application's rollback and commit");
      const written = await transaction((tx) => executeOf(executor.wrapTransaction(tx), 'a joined transaction')(`DELETE FROM ${table} WHERE id = ?`, ['committed']));
      equal(written, { affectedRows: 1 }, "execute() in the application's transaction");
      equal(await ids(executor, table), [], "the rows after execute() in the application's transaction");

      // mysql2 doesn't track a connection's transaction: a connection outside one may be refused at its first
      // statement, before it writes anything, rather than by wrapTransaction() itself.
      const refused: Array<[string, unknown]> = [
        ["the application's database, pool or client", root],
        ['the executor', executor],
        ['an object', {}],
        ['null', null],
        ['undefined', undefined],
        ['a number', 42],
        ['a string', 'tx'],
      ];
      for (const [label, value] of refused) {
        const thrown = await (async () => {
          try {
            await executor.wrapTransaction(value).execute?.(`INSERT INTO ${table} (id) VALUES (?)`, ['joined-nothing']);
          } catch (error) {
            return error;
          }
          return undefined;
        })();
        isTypeError(thrown, `wrapTransaction() of ${label}`);
      }
      equal(await ids(executor, table), [], 'the rows after the refused joins');
    },

    async native(target, table) {
      if (!(await setsNative(target))) {
        return;
      }

      // Nothing reads from outside while the work runs: on one connection, that read would wait for the transaction.
      const { executor } = target;
      const insert = `INSERT INTO ${table} (id) VALUES (?)`;
      const seen = await executor.transaction(async (tx) => {
        const joined = executor.wrapTransaction(tx.native);
        if (joined.native !== tx.native) {
          throw new Error("wrapTransaction() of a transaction's native: expected that native back, as it was given, got another object");
        }
        equal(await executeOf(joined, "a transaction's native, joined")(insert, ['kept']), { affectedRows: 1 }, "execute() through wrapTransaction() of a transaction's native");
        return ids(tx, table);
      });
      equal(seen, ['kept'], "the rows a transaction sees after a write through wrapTransaction() of its native");
      equal(await ids(executor, table), ['kept'], "the rows after that transaction committed");

      const failure = new Error('changed my mind');
      let before: string[] = [];
      const rolledBack = await rejection(
        executor.transaction(async (tx) => {
          await executeOf(executor.wrapTransaction(tx.native), "a transaction's native, joined")(insert, ['undone']);
          before = await ids(tx, table);
          throw failure;
        }),
        "a transaction whose work rejects after a write through wrapTransaction() of its native",
      );
      if (rolledBack !== failure) {
        throw new Error(`a transaction whose work rejects after a write through wrapTransaction() of its native: expected it to reject with the work's error, got ${messages(rolledBack)}`);
      }
      equal(before, ['kept', 'undone'], "the rows a transaction sees after a write through wrapTransaction() of its native, before its work rejects");
      equal(await ids(executor, table), ['kept'], "the rows after that transaction rolled back (the write through its native with it)");
    },

    async connections({ executor }, table) {
      // An autocommit statement is a transaction of its own in performance_schema when it reads an InnoDB table.
      const id = async (db: SqlTransaction) =>
        (
          await db.query<{ id: string }>(
            `SELECT CONCAT(THREAD_ID, ':', EVENT_ID) AS id FROM performance_schema.events_transactions_current
WHERE THREAD_ID = ${THIS_THREAD} AND (SELECT COUNT(*) FROM ${table}) >= 0`,
          )
        )[0]?.id;
      const outside = Array.from({ length: 10 }, () => id(executor));
      const inside = await Promise.all(
        Array.from({ length: 10 }, () =>
          executor.transaction(async (tx) => {
            const first = await id(tx);
            await jitter();
            return [first, await id(tx)] as const;
          }),
        ),
      );

      for (const [first, second] of inside) {
        equal(second, first, "the transaction of a transaction's second statement (performance_schema's thread and event)");
      }
      const distinct = new Set([...inside.map(([first]) => first), ...(await Promise.all(outside))]);
      equal(distinct.size, 20, 'distinct transactions of 10 transactions and 10 statements outside them, run at once');
    },

    async values({ executor }, table) {
      const rows = [
        { id: "O'Reilly — ü 🚀 \\ \n", small: -2147483648, big: 9007199254740991, flag: true, doc: { a: [1, 'two', null, { deep: "it's ? $2" }], n: 1.5 }, note: '' },
        { id: 'nulls', small: null, big: null, flag: false, doc: 'a JSON string', note: null },
        { id: 'no-json', small: 0, big: 0, flag: false, doc: null, note: 'x' },
        // Doubles MySQL 8's JSON text parser reads 1 ulp off (SqlParams.json() sets them with CAST(? AS DOUBLE)), at
        // paths of every kind, a bare one, and many in one document.
        { id: 'doubles', small: 1, big: 1, flag: true, doc: DOUBLES, note: null },
        { id: 'a bare double', small: 1, big: 1, flag: true, doc: 0.12274816974613123, note: null },
        { id: 'many doubles', small: 1, big: 1, flag: true, doc: Array.from({ length: 500 }, (_, i) => (i + 1) / 7 + 0.1), note: null },
      ];
      for (const row of rows) {
        const p = new SqlParams();
        await executor.query(
          `INSERT INTO ${table} (id, small_n, big_n, is_flag, doc_json, note_text)
VALUES (${p.text(row.id)}, ${p.int(row.small)}, ${p.bigint(row.big)}, ${p.bool(row.flag)}, ${p.json(row.doc)}, ${p.text(row.note)})`,
          p.values,
        );
      }

      for (const row of rows) {
        const p = new SqlParams();
        const [read] = await executor.query<Record<string, unknown>>(
          `SELECT ${columns(['id', 'small_n', 'big_n', 'is_flag', 'doc_json', 'note_text'], 't')} FROM ${table} t WHERE t.id = ${p.text(row.id)}`,
          p.values,
        );
        const values = { id: toText(read?.id), small: toInt(read?.small_n), big: toInt(read?.big_n), flag: toBool(read?.is_flag), doc: toJson(read?.doc_json), note: toText(read?.note_text) };
        equal(values, row, `a row written with SqlParams and read with columns() (${JSON.stringify(row.id)})`);
      }

      // A document a statement reads with JSON_TABLE(), as the stores' batch writes do.
      const p = new SqlParams();
      const read = await executor.query<{ n: string; value: string }>(
        `SELECT CAST(j.n AS CHAR) AS n, CAST(j.value AS CHAR) AS value
FROM JSON_TABLE(${p.json([{ value: 0.1 + 0.2 }, { value: 7e-30 }, { value: 2 }])}, '$[*]' COLUMNS (n FOR ORDINALITY, value json PATH '$.value')) AS j
ORDER BY j.n`,
        p.values,
      );
      equal(
        read.map((row) => toJson(row.value)),
        [0.1 + 0.2, 7e-30, 2],
        'the doubles of a SqlParams.json() document read with JSON_TABLE()',
      );
    },
  },
};

/** Doubles a JSON text parser can round, under member names a JSON path must quote (`__proto__` an own member). */
const DOUBLES: Record<string, unknown> = {
  sum: 0.1 + 0.2,
  tiny: 7e-30,
  max: Number.MAX_VALUE,
  min: Number.MIN_VALUE,
  huge: 1.2345678901234567e300,
  unsafe: 2 ** 60,
  negative: -0.12274816974613123,
  list: [0.12274816974613123, [1.5, 'text', null, { deep: 0.49355803101514717 }], 3],
  'with "quote"': 1 / 3,
  'back\\slash': 2 / 3,
  'dot.ted': 0.12274816974613124,
  'sp ace': 0.30000000000000004,
  '': 0.9999999999999999,
  '*': 0.1 + 0.7,
  '$[0]': 1e21 + 0.5,
  'ü 🚀\n': 1.7976931348623157e-300,
  ['__proto__']: 0.1 + 0.6,
};

/** The isolation level of the transaction `tx` runs in, and the connection's own. */
async function transactionIsolation(tx: SqlTransaction): Promise<{ level: string | undefined; connection: string | undefined }> {
  let row: { level?: string; connection?: string } | undefined;
  try {
    [row] = await tx.query<{ level?: string; connection?: string }>(
      `SELECT ISOLATION_LEVEL AS level, @@session.transaction_isolation AS connection FROM performance_schema.events_transactions_current
WHERE THREAD_ID = ${THIS_THREAD}`,
    );
  } catch (error) {
    throw new Error(
      `The MySQL isolation case reads performance_schema.events_transactions_current, which needs SELECT on performance_schema (the performance schema is on by default on MySQL; MariaDB needs --performance-schema=ON): ${messages(error)}`,
    );
  }
  if (!row) {
    throw new Error(
      "The MySQL isolation case reads performance_schema.events_transactions_current, and it has no transaction of this connection's: enable the events_transactions_current consumer and the transaction instrument (on by default on MySQL, off on MariaDB).",
    );
  }
  return { level: row.level?.toLowerCase(), connection: row.connection };
}

/** `db.execute`, which a MySQL executor and its transactions must have. */
function executeOf(db: { execute?: (text: string, params?: readonly unknown[]) => Promise<SqlExecuteResult> }, label: string) {
  if (typeof db.execute !== 'function') {
    throw new Error(`${label} has no execute(): a MySQL executor and its transactions count the rows a statement writes with it.`);
  }
  return db.execute.bind(db);
}

async function ids(executor: SqlTransaction, table: string): Promise<string[]> {
  return (await executor.query<{ id: string }>(`SELECT id FROM ${table}`)).map((row) => row.id).sort();
}

function includes(text: string, part: string, label: string): void {
  if (!text.includes(part)) {
    throw new Error(`${label}: expected an error with "${part}", got "${text}"`);
  }
}
