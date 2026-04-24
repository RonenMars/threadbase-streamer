import type { Pool as PoolType } from "pg";
import type { DbConfig } from "./config";

export function maskConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    // Check if password field is present (including empty password like "user:@host")
    const hasPasswordField =
      parsed.username.length > 0 && url.includes(`${parsed.username}:`) && url.includes("@");
    if (hasPasswordField) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "***masked***";
  }
}

export async function createPool(config: DbConfig): Promise<PoolType> {
  const pg = await import("pg");
  const { Pool } = pg.default ?? pg;

  const poolConfig: ConstructorParameters<typeof Pool>[0] = {
    connectionString: config.connectionString,
    max: config.max,
  };

  if (config.ssl === "require") {
    poolConfig.ssl = { rejectUnauthorized: false };
  } else if (config.ssl === "disable") {
    poolConfig.ssl = false;
  }

  if (config.statementTimeout) {
    poolConfig.statement_timeout = config.statementTimeout;
  }

  return new Pool(poolConfig);
}
