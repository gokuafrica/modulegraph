export type Row = Record<string, unknown>;

/**
 * In-memory relational store. Every method takes the table name first; the
 * module-graph analyzer reads that argument as the side-effect target.
 */
export class Db {
  private tables = new Map<string, Row[]>();

  async select<T extends Row = Row>(table: string, where: Row = {}): Promise<T[]> {
    return this.rows(table).filter((row) => matches(row, where)) as T[];
  }

  async insert(table: string, row: Row): Promise<void> {
    this.rows(table).push({ ...row });
  }

  async update(table: string, where: Row, patch: Row): Promise<number> {
    const hits = this.rows(table).filter((row) => matches(row, where));
    hits.forEach((row) => Object.assign(row, patch));
    return hits.length;
  }

  async delete(table: string, where: Row): Promise<number> {
    const rows = this.rows(table);
    const keep = rows.filter((row) => !matches(row, where));
    this.tables.set(table, keep);
    return rows.length - keep.length;
  }

  private rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => (row[key] ?? null) === value);
}
