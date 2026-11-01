import { inListKind } from '../../utils/params.util.js';

/** A JSON document from its text, on MySQL and MariaDB alike. */
const JSON_DOCUMENT = "JSON_EXTRACT(?, '$')";

/**
 * A statement's parameters, as a MySQL store writes them: every value goes to the client as a string (or `null`) for a
 * `?` placeholder, cast in the statement where it isn't text (`CAST(? AS SIGNED)`), and every column comes back cast
 * to text (`columns()`), read with `toText()`, `toInt()`, `toBool()` and `toJson()`. mysql2, the ORMs and Prisma's
 * adapter parse and send values in their own ways (a BIGINT is a `number` that loses precision to one, a `BigInt` to
 * another; a JSON column an object to one, a string to another), and text passes through all of them as it is.
 *
 * ```ts
 * const p = new SqlParams();
 * const { affectedRows } = await executor.execute(
 *   `UPDATE ${t.jobs} SET lease_owner = ${p.text(owner)}, lease_until = ${p.bigint(until)}
 * WHERE id = ${p.text(id)} AND ${p.equals('group_key', groupKey)} AND ${p.in('state', ['waiting', 'active'])}`,
 *   p.values,
 * );
 * ```
 *
 * Text goes bare (`?`): compared with a key column, the column's binary collation decides, not the connection's. Write
 * no `?` in a statement but its placeholders (none in a literal or a comment), and no `??`: the executors count them.
 *
 * A `?` binds by position, where PostgreSQL's `$n` binds by number: call `p.x()` in the order the placeholders appear
 * in the statement's final text. A fragment built early (`const fence = \`lease_owner = ${p.text(owner)}\``) and
 * placed after one built later binds each value to the other's `?`, and the executors' count can't see it: build each
 * fragment where it goes, or give it a `SqlParams` of its own and concatenate the values in the text's order.
 */
export class SqlParams {
  /** What the statement's placeholders take, in order: pass it as the statement's `params`. */
  readonly values: Array<string | null> = [];

  /** `?`: text, compared by the column's collation. */
  text(value: string | null): string {
    this.values.push(value);
    return '?';
  }

  /** `CAST(? AS SIGNED)`, for an INT column. Throws a `TypeError` for anything but a whole number or `null`. */
  int(value: number | null): string {
    return this.add(wholeNumber(value, 'int'), 'CAST(? AS SIGNED)');
  }

  /** `CAST(? AS SIGNED)`, for a BIGINT column: epoch milliseconds, and any integer past INT's range. */
  bigint(value: number | null): string {
    return this.add(wholeNumber(value, 'bigint'), 'CAST(? AS SIGNED)');
  }

  /** `CAST(? AS UNSIGNED)` of `1` or `0`, for a BOOLEAN (TINYINT(1)) column. */
  bool(value: boolean): string {
    return this.add(value ? '1' : '0', 'CAST(? AS UNSIGNED)');
  }

  /**
   * `JSON_EXTRACT(?, '$')`, for a JSON column: the document parsed from its text, as `CAST(? AS JSON)` would on MySQL,
   * in a form MariaDB takes too (it has no JSON cast); `null` and `undefined` as SQL `NULL`. A value holding numbers
   * other than safe integers (`0.1`, `1e-30`) goes as `JSON_SET(JSON_EXTRACT(?, '$'), ?, CAST(? AS DOUBLE), ...)`: a
   * `0` in the document's text, then each number set at its path. MySQL 8's JSON text parser rounds a double whose
   * digits pass 2^53, or whose exponent is large, to a neighbor (`0.9999999999999999` comes back `1`, `7e-30`
   * `6.999999999999999e-30`), where `CAST(? AS DOUBLE)` reads it exactly; MySQL 9 parses JSON text exactly, and stores
   * the same double either way.
   */
  json(value: unknown): string {
    if (value === null || value === undefined) {
      return this.add(null, JSON_DOCUMENT);
    }
    const text = JSON.stringify(value);
    const doubles: Array<[path: string, value: number]> = [];
    // A function or a symbol stringifies to undefined, as before: nothing to walk.
    const document = text === undefined ? undefined : zeroDoubles(JSON.parse(text), '$', doubles);
    if (doubles.length === 0) {
      return this.add(text, JSON_DOCUMENT);
    }
    this.values.push(JSON.stringify(document));
    for (const [path, double] of doubles) {
      this.values.push(path, String(double));
    }
    return `JSON_SET(${JSON_DOCUMENT}, ${doubles.map(() => '?, CAST(? AS DOUBLE)').join(', ')})`;
  }

  /**
   * `column = ?`, or `column IS NULL` for `null`: keys match exactly, and `NULL = NULL` isn't true. `column` goes into
   * the statement as written (`state`, `j.state`), so a column named after a reserved word (MySQL 8 reserves `key`,
   * `rank`, `signal`...) comes quoted: `` p.equals(`w.${quoteIdentifier('key')}`, key) ``.
   */
  equals(column: string, value: string | null): string {
    return value === null ? `${column} IS NULL` : `${column} = ${this.text(value)}`;
  }

  /**
   * `column IN (?, ...)` of the given values; `FALSE` for none. Strings go bare (`?`), whole numbers (a sequence
   * number, a BIGINT id) as `CAST(? AS SIGNED)`: one kind a list, else a `TypeError`. `column` goes into the statement
   * as written, as in `equals()`.
   *
   * ```ts
   * `DELETE FROM ${t.jobs} WHERE ${p.in('id', ids)}`       // id IN (?, ?)
   * `UPDATE ${t.messages} SET ... WHERE ${p.in('seq', seqs)}` // seq IN (CAST(? AS SIGNED), CAST(? AS SIGNED))
   * ```
   */
  in(column: string, values: readonly string[] | readonly number[]): string {
    if (values.length === 0) {
      return 'FALSE';
    }
    const numbers = inListKind(values) === 'number';
    return `${column} IN (${values.map((value) => (numbers ? this.add(String(value), 'CAST(? AS SIGNED)') : this.text(value as string))).join(', ')})`;
  }

  /**
   * A LIMIT or OFFSET count, written into the statement: MySQL takes no expression there, and a client that binds `?`
   * on its side would send `LIMIT '10'`, a syntax error. Throws a `TypeError` for anything but a whole number from 0.
   */
  limit(value: number): string {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`SqlParams.limit() takes a whole number from 0, not ${JSON.stringify(value)}.`);
    }
    return String(value);
  }

  private add(value: string | null, placeholder: string): string {
    this.values.push(value);
    return placeholder;
  }
}

/**
 * `value`, parsed JSON (changed in place), with each number but a safe integer replaced by `0`, its JSON path
 * (`$."a"[2]`) and value pushed onto `doubles` in document order. Member names go quoted as JSON strings, which
 * MySQL's paths take whatever they hold (`"`, `\`, `.`, `*`, the empty name).
 */
function zeroDoubles(value: unknown, path: string, doubles: Array<[string, number]>): unknown {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      return value;
    }
    doubles.push([path, value]);
    return 0;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => (value[index] = zeroDoubles(item, `${path}[${index}]`, doubles)));
  } else if (value !== null && typeof value === 'object') {
    // Assigned, not copied: JSON.parse() makes a `__proto__` member an own property, which an assignment keeps.
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      object[key] = zeroDoubles(object[key], `${path}.${JSON.stringify(key)}`, doubles);
    }
  }
  return value;
}

/** `value` as text, after checking it's a whole number: MySQL would round `1.5` or wrap `2^63` without an error. */
function wholeNumber(value: number | null, method: string): string | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`SqlParams.${method}() takes a whole number (or null), not ${String(value)}: MySQL would round it, or wrap it past 2^63, without an error.`);
  }
  return String(value);
}
