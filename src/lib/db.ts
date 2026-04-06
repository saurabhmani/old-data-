import mysql from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

let pool: mysql.Pool | null = null;

/** Convert PostgreSQL ?, ? placeholders to MySQL ? placeholders */
function toMysqlParams(sql: string, params?: any[]): [string, any[]] {
  if (!params?.length) return [sql, []];
  const newParams: any[] = [];
  const newSql = sql.replace(/\$([0-9]+)/g, (_match, num) => {
    const idx = parseInt(num, 10) - 1;
    if (idx >= 0 && idx < params.length) {
      newParams.push(params[idx]);
      return '?';
    }
    return '?';
  });
  return [newSql, newParams];
}

/** Convert PostgreSQL INTERVAL to MySQL DATE_SUB */
function convertInterval(sql: string): string {
  return sql.replace(
    /NOW\(\)\s*-\s*INTERVAL\s+'(\d+)\s+(\w+)'/gi,
    (_, n, unit) => {
      const u = unit.toLowerCase().replace(/s$/, '').toUpperCase();
      const map: Record<string, string> = {
        DAY: 'DAY', HOUR: 'HOUR', WEEK: 'WEEK', MONTH: 'MONTH', YEAR: 'YEAR',
        MINUTE: 'MINUTE', SECOND: 'SECOND',
      };
      return `DATE_SUB(NOW(), INTERVAL ${n} ${map[u] || 'DAY'})`;
    }
  );
}

/** Convert PostgreSQL ILIKE to MySQL LIKE (case-insensitive with utf8mb4) */
function convertIlike(sql: string): string {
  return sql.replace(/ILIKE/gi, 'LIKE');
}

/** Convert PostgreSQL ON CONFLICT to MySQL ON DUPLICATE KEY UPDATE */
function convertOnConflict(sql: string): string {
  return sql.replace(
    /ON CONFLICT\s*\([^)]+\)\s*DO UPDATE SET\s+([^;]+)/gi,
    (_, setClause) => {
      // Replace ?, ? in set clause with VALUES(col) for MySQL
      const mysqlSet = setClause.replace(/(\w+)=\$(\d+)/g, (m: string, col: string, _n: string) => {
        return `${col}=VALUES(${col})`;
      });
      return `ON DUPLICATE KEY UPDATE ${mysqlSet}`;
    }
  );
}

/** Handle INSERT ... RETURNING for MySQL (no native support) */
async function handleReturning(
  pool: mysql.Pool,
  sql: string,
  params: any[]
): Promise<{ rows: any[] }> {
  const returnIdMatch = sql.match(/RETURNING\s+id\s*$/i);
  const returnAllMatch = sql.match(/RETURNING\s+\*\s*$/i);
  const insertMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i);

  let baseSql = sql.replace(/\s*RETURNING\s+(id|\*)\s*$/i, '').trim();
  baseSql = convertInterval(convertIlike(convertOnConflict(baseSql)));
  const [mysqlSql, mysqlParams] = toMysqlParams(baseSql, params);

  const [result] = await pool.execute<ResultSetHeader>(mysqlSql, mysqlParams);
  const header = result as unknown as ResultSetHeader;

  if (returnIdMatch && header.insertId) {
    return { rows: [{ id: header.insertId }] };
  }

  if (returnAllMatch && insertMatch && header.insertId) {
    const table = insertMatch[1];
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM \`${table}\` WHERE id = ?`,
      [header.insertId]
    );
    return { rows: Array.isArray(rows) ? rows : [rows] };
  }

  return { rows: [] };
}

/** Execute SELECT/UPDATE/DELETE and return pg-compatible { rows } */
async function executeQuery(
  pool: mysql.Pool,
  sql: string,
  params?: any[]
): Promise<{ rows: any[] }> {
  let finalSql = convertInterval(convertIlike(convertOnConflict(sql)));
  const [mysqlSql, mysqlParams] = toMysqlParams(finalSql, params || []);

  const [rows] = await pool.execute<RowDataPacket[]>(mysqlSql, mysqlParams);
  const arr = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  return { rows: arr };
}

export function getDb(): mysql.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');

    // Parse mysql://user:pass@host:port/db
    const parsed = new URL(url);
    const config: mysql.PoolOptions = {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 3306,
      user: parsed.username,
      password: parsed.password,
      database: parsed.pathname?.slice(1) || 'quantorus365',
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0,
    };
    pool = mysql.createPool(config);
  }
  return pool;
}

export const db = {
  query: async <T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> => {
    const p = getDb();

    // INSERT with RETURNING
    if (/INSERT\s+INTO.*RETURNING/i.test(text)) {
      return handleReturning(p, text, params || []) as Promise<{ rows: T[] }>;
    }

    // Regular query
    const { rows } = await executeQuery(p, text, params);
    return { rows: rows as T[] };
  },
};
