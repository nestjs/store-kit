/**
 * A MySQL store's writes in the application's transaction, through each client's own transaction object (a mysql2
 * connection after beginTransaction(), Drizzle's `tx`, TypeORM's `EntityManager`, Prisma's transaction client,
 * Kysely's `trx`): they commit with the application's row, unseen by other connections until then, or roll back with
 * it; the same object as the `native` of a transaction the executor opened, whose own API writes in it, as does a
 * store given it; an insert that meets a known id is a no-op there, and the application's transaction goes on (MySQL
 * rolls back the statement, not the transaction). And what a store may assume of the application's transactions: REPEATABLE READ,
 * MySQL's default, reads a snapshot, and a locking read sees the latest committed rows (on MariaDB with
 * `innodb_snapshot_isolation` on, its default since 11.6.2, it fails with 1020 instead).
 */
import { mysqlErrorCode } from '../../lib/mysql/index.js';
import { MySqlNoteStore } from '../fixtures/notes/mysql-note.store.js';
import { clients, onMysql, singleConnectionClient, testDatabase, type Client } from './support.js';

const { database, reason } = await testDatabase('transactions');

/** Whether the server is a MariaDB whose REPEATABLE READ refuses a locking read of a row changed since the snapshot. */
const snapshotIsolation =
  !!database?.mariadb && Number(((await database.admin.query('SELECT @@innodb_snapshot_isolation AS on_'))[0] as Array<{ on_: unknown }>)[0]?.on_) === 1;

const targets = [...clients, singleConnectionClient].map((factory, i) => ({ name: `${factory.name} on MySQL`, schema: `tx_${i}`, open: () => factory.open(database!.url) }));

describe.each(targets)('$name', ({ schema, open }) => {
  let client: Client;
  let store: MySqlNoteStore;

  beforeAll(async () => {
    if (reason) {
      return;
    }

    client = await open();
    store = new MySqlNoteStore({ executor: client.executor, schema });
    await store.onModuleInit();
  });
  afterAll(() => client?.close());
  onMysql(reason);

  const orders = async (id: string) => (await client.executor.query('SELECT id FROM orders WHERE id = ?', [id])).length;
  const outside = async (sql: string, params: unknown[]) => (await database!.admin.query(sql, params))[0] as unknown[];

  it("commits the store's writes with the application's row, unseen by other connections until then", async () => {
    const id = `${schema}-committed`;
    await client.transaction(async (tx) => {
      await client.insertOrder(tx, id);
      expect(await store.addInTransaction(tx, { id, body: 'order placed', tags: ['orders'], createdAt: 1 })).toBe(true);
      expect(await outside(`SELECT id FROM ${schema}_notes WHERE id = ?`, [id])).toEqual([]);
    });

    expect(await orders(id)).toBe(1);
    expect(await store.get(id)).toEqual({ id, body: 'order placed', tags: ['orders'], archived: false, createdAt: 1 });
  });

  it("rolls the store's writes back with the application's", async () => {
    const id = `${schema}-rolled-back`;
    await expect(
      client.transaction(async (tx) => {
        await client.insertOrder(tx, id);
        await store.addInTransaction(tx, { id, body: 'order placed', tags: ['orders'], createdAt: 1 });
        throw new Error('payment declined');
      }),
    ).rejects.toThrow('payment declined');

    expect(await orders(id)).toBe(0);
    expect(await store.get(id)).toBeNull();
    expect(await outside(`SELECT tag FROM ${schema}_note_tags WHERE note_id = ?`, [id])).toEqual([]);
  });

  it("hands the executor's own transaction the client's object as native, whose own API and a store given it write in that transaction", async () => {
    const id = `${schema}-native`;
    await client.executor.transaction(async (tx) => {
      await client.insertOrder(tx.native, id);
      expect(await store.addInTransaction(tx.native, { id, body: 'order placed', tags: ['orders'], createdAt: 1 })).toBe(true);
      expect(await tx.query('SELECT id FROM orders WHERE id = ?', [id])).toEqual([{ id }]);
      expect(await outside('SELECT id FROM orders WHERE id = ?', [id])).toEqual([]);
    });
    expect(await orders(id)).toBe(1);
    expect(await store.get(id)).toEqual({ id, body: 'order placed', tags: ['orders'], archived: false, createdAt: 1 });

    const undone = `${schema}-native-undone`;
    await expect(
      client.executor.transaction(async (tx) => {
        await client.insertOrder(tx.native, undone);
        await store.addInTransaction(tx.native, { id: undone, body: 'order placed', tags: ['orders'], createdAt: 1 });
        throw new Error('payment declined');
      }),
    ).rejects.toThrow('payment declined');
    expect(await orders(undone)).toBe(0);
    expect(await store.get(undone)).toBeNull();
  });

  it("adds a note it has as a no-op in the application's transaction, which goes on and commits: MySQL rolls back the statement, not the transaction", async () => {
    const id = `${schema}-known`;
    expect(await store.add({ id, body: 'first', createdAt: 1 })).toBe(true);
    await client.transaction(async (tx) => {
      expect(await store.addInTransaction(tx, { id, body: 'second', tags: ['again'], createdAt: 2 })).toBe(false);
      await client.insertOrder(tx, id);
    });

    expect(await orders(id)).toBe(1);
    expect(await store.get(id)).toEqual({ id, body: 'first', tags: [], archived: false, createdAt: 1 });
  });

  it("reads a snapshot in the application's REPEATABLE READ transaction, and the latest committed rows with a locking read (1020 under MariaDB's snapshot isolation)", async () => {
    const id = `${schema}-late`;
    await client.transaction(async (tx) => {
      const joined = client.executor.wrapTransaction(tx);
      await joined.query(`SELECT COUNT(*) AS n FROM ${schema}_notes`);
      await outside(`INSERT INTO ${schema}_notes (id, body, created_at) VALUES (?, 'late', 1)`, [id]);

      expect(await joined.query(`SELECT id FROM ${schema}_notes WHERE id = ?`, [id])).toEqual([]);
      const locking = joined.query(`SELECT id FROM ${schema}_notes WHERE id = ? LOCK IN SHARE MODE`, [id]);
      if (snapshotIsolation) {
        expect(mysqlErrorCode(await locking.catch((e: unknown) => e))).toBe(1020);
      } else {
        expect(await locking).toEqual([{ id }]);
      }
    }, 'repeatable read');
  });
});
