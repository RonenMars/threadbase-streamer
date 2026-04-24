export interface DbConfig {
  connectionString: string;
  max: number;
  ssl?: string;
  statementTimeout?: number;
}

export function isDbEnabled(): boolean {
  const url = process.env.THREADBASE_DATABASE_URL;
  return typeof url === "string" && url.length > 0;
}

export function getDbConfig(): DbConfig | null {
  if (!isDbEnabled()) return null;

  const connectionString = process.env.THREADBASE_DATABASE_URL ?? "";
  const poolMax = Number.parseInt(process.env.THREADBASE_DATABASE_POOL_MAX ?? "", 10);
  const stmtTimeout = Number.parseInt(
    process.env.THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS ?? "",
    10,
  );
  const ssl = process.env.THREADBASE_DATABASE_SSL || undefined;

  return {
    connectionString,
    max: Number.isNaN(poolMax) ? 10 : poolMax,
    ssl,
    statementTimeout: Number.isNaN(stmtTimeout) ? undefined : stmtTimeout,
  };
}
