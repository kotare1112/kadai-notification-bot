import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

// node:sqlite で D1 の最小限の互換層を作る(prepare/bind/run/all/first のみ)。
export function fakeD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_myfit.sql"]) sqlite.exec(readFileSync(`migrations/${f}`, "utf8"));
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) {
          params = p;
          return stmt;
        },
        async run() {
          const r = sqlite.prepare(sql).run(...(params as never[]));
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...(params as never[])) };
        },
        async first() {
          return sqlite.prepare(sql).get(...(params as never[])) ?? null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}
