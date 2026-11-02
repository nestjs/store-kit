/**
 * The MySQL schema of the notes store (tests/fixtures/notes), as a package defines one next to its PostgreSQL one: DDL
 * only, key columns with a binary collation, no foreign keys (the store deletes a note's tags with it, in one
 * transaction), and the same package error. The tests build variants of it (other migrations) to check the kit's
 * behaviour at other versions.
 */
import { keyColumn, StoreSchema, type StoreMigration, type StoreSchemaOptions } from '../../../lib/mysql/index.js';
import { NoteSchemaError } from './note.schema.js';

export const initialMigration: StoreMigration = {
  version: 1,
  name: 'initial',
  up: (t) => [
    `CREATE TABLE ${t('notes')} (
  id ${keyColumn(191)} NOT NULL PRIMARY KEY,
  body text NOT NULL,
  created_at bigint NOT NULL
)`,
    `CREATE TABLE ${t('note_tags')} (
  note_id ${keyColumn(191)} NOT NULL,
  tag ${keyColumn(64)} NOT NULL,
  PRIMARY KEY (note_id, tag)
)`,
    `CREATE INDEX notes_created ON ${t('notes')} (created_at, id)`,
    `CREATE INDEX note_tags_tag ON ${t('note_tags')} (tag)`,
  ],
};

/** A later migration changes tables in use: online DDL, which fails rather than copy or lock the table if it can't. */
export const archiveMigration: StoreMigration = {
  version: 2,
  name: 'archive',
  up: (t) => [
    `ALTER TABLE ${t('notes')} ADD COLUMN archived boolean NOT NULL DEFAULT false, ALGORITHM=INSTANT`,
    `CREATE INDEX notes_archived ON ${t('notes')} (archived, created_at) ALGORITHM=INPLACE LOCK=NONE`,
  ],
};

export const mysqlNoteSchemaOptions: StoreSchemaOptions = {
  packageName: '@nestjs/notes',
  storeName: 'MySqlNoteStore',
  command: 'nest-notes',
  defaultSchema: 'nest_notes',
  migrations: [initialMigration, archiveMigration],
  createError: (message, details) => new NoteSchemaError(message, details),
  mariadb: true,
};

export const mysqlNoteSchema = new StoreSchema(mysqlNoteSchemaOptions);

/** The same store's schema with other migrations: an older or a newer version of the package. */
export const mysqlNoteSchemaWith = (migrations: StoreMigration[]) => new StoreSchema({ ...mysqlNoteSchemaOptions, migrations });
