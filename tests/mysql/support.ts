/**
 * The database clients an application may hand a MySQL store (mysql2, Drizzle, TypeORM, Prisma with its MariaDB
 * adapter, Kysely), each with the ORM's own way of running a transaction, and a database per test file on the MySQL
 * of `SQL_TEST_MYSQL_URL` (else those tests are skipped with the reason), through tests/support/mysql.ts, which names
 * (`skit_`) and sweeps them. Every pool has at most 4 connections: the server may be shared.
 */
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { MySqlTransaction, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { Kysely, MysqlDialect, Transaction } from 'kysely';
import mysqlCallbacks from 'mysql2';
import mysql from 'mysql2/promise';
import { Column, DataSource, Entity, EntityManager, PrimaryColumn } from 'typeorm';
import { fromDrizzle, fromKysely, fromMysql2, fromPrisma, fromTypeOrm, type SqlExecutor } from '../../lib/mysql/index.js';
import { PrismaClient } from '../fixtures/prisma-mysql/generated/client.js';
import { startMysql } from '../support/mysql.js';

/** The application's table, written in the same transactions as the store's rows. */
export const ORDERS_DDL = 'CREATE TABLE IF NOT EXISTS orders (id varchar(191) NOT NULL PRIMARY KEY, status varchar(32) NOT NULL)';

export type Isolation = 'read committed' | 'repeatable read';

/** The connections each client's pool may open. */
export const POOL_SIZE = 4;

/** A database client as an application holds one. */
export interface Client {
  name: string;
  executor: SqlExecutor;
  /** A transaction as the application runs one with this client: `work` gets the ORM's own transaction object. */
  transaction<T>(work: (tx: unknown) => Promise<T>, isolation?: Isolation): Promise<T>;
  /** What an application might pass by mistake instead of its transaction: the pool, the database, the client. */
  root: unknown;
  /** The application's write, through its transaction object. */
  insertOrder(tx: unknown, id: string): Promise<void>;
  /** Whether `value` is the client's own transaction object, the kind its transactions hand the application's work. */
  isNative(value: unknown): boolean;
  close(): Promise<void>;
}

export interface ClientFactory {
  name: string;
  open(url: string): Promise<Client>;
}

const drizzleOrders = mysqlTable('orders', { id: varchar('id', { length: 191 }).primaryKey(), status: varchar('status', { length: 32 }).notNull() });

@Entity('orders')
class OrderEntity {
  @PrimaryColumn('varchar', { length: 191 })
  id!: string;

  @Column('varchar', { length: 32 })
  status!: string;
}

interface KyselyDatabase {
  orders: { id: string; status: string };
}

export const mysql2Client: ClientFactory = {
  name: 'fromMysql2 (mysql2 pool)',
  async open(url) {
    const pool = mysql.createPool({ uri: url, connectionLimit: POOL_SIZE });
    return {
      name: this.name,
      executor: fromMysql2(pool),
      root: pool,
      async transaction(work, isolation) {
        const connection = await pool.getConnection();
        try {
          if (isolation) {
            await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
          }
          await connection.beginTransaction();
          const result = await work(connection);
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      },
      insertOrder: async (tx, id) => {
        await (tx as mysql.PoolConnection).query("INSERT INTO orders (id, status) VALUES (?, 'placed')", [id]);
      },
      isNative: (value) => value instanceof mysql.PoolConnection,
      close: () => pool.end(),
    };
  },
};

export const drizzleClient: ClientFactory = {
  name: 'fromDrizzle (mysql2)',
  async open(url) {
    const pool = mysql.createPool({ uri: url, connectionLimit: POOL_SIZE });
    const db = drizzle(pool);
    return {
      name: this.name,
      executor: fromDrizzle(db),
      root: db,
      transaction: (work, isolation) => db.transaction(work, isolation ? { isolationLevel: isolation } : undefined),
      insertOrder: async (tx, id) => {
        await (tx as typeof db).insert(drizzleOrders).values({ id, status: 'placed' });
      },
      isNative: (value) => is(value, MySqlTransaction),
      close: () => pool.end(),
    };
  },
};

export const typeOrmClient: ClientFactory = {
  name: 'fromTypeOrm',
  async open(url) {
    const dataSource = await new DataSource({ type: 'mysql', url, entities: [OrderEntity], poolSize: POOL_SIZE }).initialize();
    return {
      name: this.name,
      executor: fromTypeOrm(dataSource),
      root: dataSource.manager,
      transaction: (work, isolation) => (isolation ? dataSource.transaction(isolation.toUpperCase() as 'REPEATABLE READ', work) : dataSource.transaction(work)),
      insertOrder: async (tx, id) => {
        await (tx as DataSource['manager']).insert(OrderEntity, { id, status: 'placed' });
      },
      isNative: (value) => value instanceof EntityManager && value.queryRunner?.isTransactionActive === true,
      close: () => dataSource.destroy(),
    };
  },
};

export const prismaClient: ClientFactory = {
  name: 'fromPrisma (@prisma/adapter-mariadb)',
  async open(url) {
    const prisma = new PrismaClient({ adapter: new PrismaMariaDb(mariadbConfig(url)) });
    return {
      name: this.name,
      executor: fromPrisma(prisma),
      root: prisma,
      // The application's own limits: Prisma's default maxWait (2 s) is short for a busy machine.
      transaction: (work, isolation) =>
        prisma.$transaction((tx) => work(tx), {
          maxWait: 10_000,
          timeout: 30_000,
          ...(isolation ? { isolationLevel: isolation === 'repeatable read' ? 'RepeatableRead' : 'ReadCommitted' } : {}),
        }),
      insertOrder: async (tx, id) => {
        await (tx as PrismaClient).order.create({ data: { id, status: 'placed' } });
      },
      // A transaction client: the client's models, without $connect().
      isNative: (value) => typeof (value as PrismaClient | null)?.order?.create === 'function' && typeof (value as { $connect?: unknown }).$connect !== 'function',
      close: () => prisma.$disconnect(),
    };
  },
};

export const kyselyClient: ClientFactory = {
  name: 'fromKysely',
  async open(url) {
    const db = new Kysely<KyselyDatabase>({ dialect: new MysqlDialect({ pool: mysqlCallbacks.createPool({ uri: url, connectionLimit: POOL_SIZE }) }) });
    return {
      name: this.name,
      executor: fromKysely(db),
      root: db,
      transaction: (work, isolation) => (isolation ? db.transaction().setIsolationLevel(isolation).execute(work) : db.transaction().execute(work)),
      insertOrder: async (tx, id) => {
        await (tx as typeof db).insertInto('orders').values({ id, status: 'placed' }).execute();
      },
      isNative: (value) => value instanceof Transaction,
      close: () => db.destroy(),
    };
  },
};

/** fromMysql2() on one connection: its statements and transactions take turns, the application's run on it directly. */
export const singleConnectionClient: ClientFactory = {
  name: 'fromMysql2 (a single mysql2 connection)',
  async open(url) {
    const connection = await mysql.createConnection({ uri: url });
    return {
      name: this.name,
      executor: fromMysql2(connection),
      root: connection,
      async transaction(work, isolation) {
        if (isolation) {
          await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
        }
        await connection.beginTransaction();
        try {
          const result = await work(connection);
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      },
      insertOrder: async (tx, id) => {
        await (tx as mysql.Connection).query("INSERT INTO orders (id, status) VALUES (?, 'placed')", [id]);
      },
      isNative: (value) => value === connection,
      close: () => connection.end(),
    };
  },
};

/** Every client on MySQL. */
export const clients = [mysql2Client, drizzleClient, typeOrmClient, prismaClient, kyselyClient];

/**
 * The MariaDB connector's settings for `url`. `allowPublicKeyRetrieval`: MySQL's `caching_sha2_password` over a
 * connection without TLS needs the server's RSA key until the server has cached the password (a fresh server, as in CI).
 */
export function mariadbConfig(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    connectionLimit: POOL_SIZE,
    allowPublicKeyRetrieval: true,
  };
}

export interface TestDatabase {
  /** The database's name. */
  name: string;
  url: string;
  /** A pool for looking at the database from outside the store. */
  admin: mysql.Pool;
  /** Whether the server is MariaDB rather than MySQL. */
  mariadb: boolean;
}

/**
 * A database of this test file on MySQL (with `orders`), dropped after the file; `null`, with the reason, where
 * there's no MySQL. Tests that need it skip with the reason.
 */
export async function testDatabase(name: string): Promise<{ database: TestDatabase; reason?: undefined } | { database: null; reason: string }> {
  const { mysql: server, reason } = await startMysql();
  if (!server) {
    return { database: null, reason: `no MySQL: ${reason}` };
  }

  const { name: database, url } = await server.createDatabase(name);
  const admin = mysql.createPool({ uri: url, connectionLimit: 2 });
  // A statement the tests run from outside waits 30 seconds for a table's metadata lock, not a year.
  admin.on('connection', (connection) => {
    connection.query('SET SESSION lock_wait_timeout = 30');
  });
  await admin.query(ORDERS_DDL);
  afterAll(async () => {
    await admin.end();
    await server.stop();
  });
  return { database: { name: database, url, admin, mariadb: server.mariadb } };
}

/** In a describe of tests that run on MySQL: skips them, with the reason, where there's none. */
export function onMysql(reason: string | undefined): void {
  beforeEach((context) => {
    if (reason) {
      context.skip(reason);
    }
  });
}

/** An executor that records every statement it runs, and its parameters. */
export function recording(executor: SqlExecutor): { executor: SqlExecutor; statements: Array<{ text: string; params?: readonly unknown[] }> } {
  const statements: Array<{ text: string; params?: readonly unknown[] }> = [];
  const record = (tx: Pick<SqlExecutor, 'query' | 'execute'>) => ({
    query: <R extends object>(text: string, params?: readonly unknown[]) => {
      statements.push({ text, params });
      return tx.query<R>(text, params);
    },
    execute: (text: string, params?: readonly unknown[]) => {
      statements.push({ text, params });
      return tx.execute(text, params);
    },
  });
  return {
    statements,
    executor: {
      dialect: executor.dialect,
      query: (text, params) => record(executor).query(text, params),
      execute: (text, params) => record(executor).execute(text, params),
      transaction: (work, options) => executor.transaction((tx) => work(record(tx)), options),
      wrapTransaction: (transaction) => record(executor.wrapTransaction(transaction)),
    },
  };
}
