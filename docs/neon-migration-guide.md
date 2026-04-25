# Migrating to Neon (Serverless PostgreSQL)

This guide covers migrating a Threadbase Streamer instance from in-memory or local PostgreSQL to [Neon](https://neon.tech) serverless PostgreSQL.

## Prerequisites

- Node.js 18+
- `@threadbase/streamer` built with database support (`npm run build`)
- [Neon CLI](https://neon.tech/docs/reference/cli-install) (`neonctl`) installed and authenticated
- `psql` and `pg_dump` available locally (included with PostgreSQL or Homebrew `libpq`)

### Install the Neon CLI

```bash
# macOS
brew install neonctl

# npm (all platforms)
npm install -g neonctl

# Authenticate
neonctl auth
```

## Step 1: Create a Neon Project and Database

```bash
# Create the project (pick a region close to your server)
neonctl projects create --name threadbase --region-id aws-us-east-2 --output json

# Note the project ID from the output (e.g., "falling-wind-18805977")
# Create a dedicated database (the default "neondb" also works)
neonctl databases create --name threadbase --project-id <PROJECT_ID>
```

Get the connection string:

```bash
neonctl connection-string --project-id <PROJECT_ID> --database-name threadbase
```

This returns a URI like:

```
postgresql://neondb_owner:<password>@ep-xxx.region.aws.neon.tech/threadbase?sslmode=require
```

Verify connectivity:

```bash
psql "<NEON_CONNECTION_STRING>" -c "SELECT 1 AS connected;"
```

## Step 2: Migrate Existing Data

### From local PostgreSQL

If you have an existing local database with session data:

```bash
pg_dump -d threadbase --no-owner --no-privileges --no-comments \
  | psql "<NEON_CONNECTION_STRING>"
```

This migrates the full schema (`_migrations`, `managed_sessions`) and all data. The streamer's auto-migration will skip already-applied migrations on next startup.

### From in-memory (no existing database)

Skip this step entirely. The streamer creates tables and runs migrations automatically on first startup when `THREADBASE_DATABASE_URL` is set.

### Verify the migration

```bash
psql "<NEON_CONNECTION_STRING>" -c "\dt"
psql "<NEON_CONNECTION_STRING>" -c "SELECT count(*) FROM managed_sessions;"
psql "<NEON_CONNECTION_STRING>" -c "SELECT count(*) FROM _migrations;"
```

You should see the `_migrations` and `managed_sessions` tables with your data.

## Step 3: Configure the Streamer

Set the following environment variables:

- **`THREADBASE_DATABASE_URL`** — the Neon connection string (required)
- **`THREADBASE_INSTANCE_ID`** — a unique name for this server (e.g., `ronens-mbp`, `office-mac`, `ci-server`). Defaults to the OS hostname if unset. **Required when multiple instances share a database** — each instance only sees sessions tagged with its own ID.

How you set these depends on how the streamer runs.

### Environment variable (direct)

```bash
export THREADBASE_DATABASE_URL="postgresql://neondb_owner:<password>@ep-xxx.region.aws.neon.tech/threadbase?sslmode=require"
export THREADBASE_INSTANCE_ID="my-server-name"
node dist/cli.cjs serve --port 8766 --verbose
```

### .env file

Create a `.env` file in the streamer directory:

```env
THREADBASE_DATABASE_URL=postgresql://neondb_owner:<password>@ep-xxx.region.aws.neon.tech/threadbase?sslmode=require
THREADBASE_INSTANCE_ID=my-server-name
```

### macOS launchd (LaunchAgent)

If the streamer runs as a LaunchAgent, add the env var to the plist's `EnvironmentVariables` dict:

```xml
<key>THREADBASE_INSTANCE_ID</key>
<string>my-server-name</string>
<key>THREADBASE_DATABASE_URL</key>
<string>postgresql://neondb_owner:PASSWORD@ep-xxx.region.aws.neon.tech/threadbase?sslmode=require</string>
```

Then reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.ronen.threadbase.plist
launchctl load  ~/Library/LaunchAgents/com.ronen.threadbase.plist
```

### Linux systemd

Add to the `[Service]` section of the unit file:

```ini
Environment=THREADBASE_DATABASE_URL=postgresql://neondb_owner:PASSWORD@ep-xxx.region.aws.neon.tech/threadbase?sslmode=require
Environment=THREADBASE_INSTANCE_ID=my-server-name
```

Then reload:

```bash
sudo systemctl daemon-reload
sudo systemctl restart threadbase-streamer
```

### Docker / docker-compose

```yaml
services:
  streamer:
    environment:
      THREADBASE_DATABASE_URL: "postgresql://neondb_owner:PASSWORD@ep-xxx.region.aws.neon.tech/threadbase?sslmode=require"
      THREADBASE_INSTANCE_ID: "my-server-name"
```

## Step 4: Verify

After restarting the streamer, check the logs for:

```
Database enabled: postgresql://neondb_owner:***@ep-xxx.region.aws.neon.tech/threadbase?sslmode=require
Instance ID: my-server-name
Database migrations applied, sessions rehydrated
```

Test the API:

```bash
curl -H "Authorization: Bearer <API_KEY>" http://localhost:8766/api/sessions
```

Sessions should include any previously persisted data plus live discovered processes.

## Neon-Specific Notes

### Cold starts

Neon scales to zero after inactivity (default: immediate on free tier). The first query after idle wakes the compute endpoint, adding ~500ms-2s latency. The streamer handles this transparently — the connection pool retries internally.

To keep the endpoint warm, set a suspend timeout in the Neon dashboard or via CLI:

```bash
neonctl endpoints list --project-id <PROJECT_ID>
neonctl endpoints update <ENDPOINT_ID> --project-id <PROJECT_ID> --suspend-timeout 300
```

### SSL

Neon requires SSL. The connection string includes `sslmode=require` by default. You do **not** need to set the `THREADBASE_DATABASE_SSL` env var separately — `pg` reads it from the connection string.

### Connection pooling

Neon provides a built-in connection pooler. To use it, replace the host with the pooler host (add `-pooler` before the region):

```
# Direct (default)
ep-xxx.region.aws.neon.tech

# Pooled
ep-xxx-pooler.region.aws.neon.tech
```

The pooler is recommended if you run multiple streamer instances pointing at the same database.

### Free tier limits

Neon's free tier includes 0.5 GB storage and 191 compute hours/month. Threadbase session metadata is lightweight — a typical instance uses well under 1 MB.

## Rollback

To revert to local PostgreSQL or in-memory mode:

### Back to local PostgreSQL

```bash
# Dump from Neon
pg_dump "<NEON_CONNECTION_STRING>" --no-owner --no-privileges --no-comments \
  | psql -d threadbase

# Update THREADBASE_DATABASE_URL to point to local
export THREADBASE_DATABASE_URL="postgresql://youruser@localhost:5432/threadbase"
```

### Back to in-memory

Unset or remove `THREADBASE_DATABASE_URL` from your environment / plist / unit file, then restart the streamer. Session data will no longer persist across restarts.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED` on startup | Neon endpoint sleeping or wrong host | Check the connection string; try `psql` manually |
| `no pg_hba.conf entry for host` | Missing `sslmode=require` | Ensure `?sslmode=require` is in the URL |
| `password authentication failed` | Wrong credentials | Re-check with `neonctl connection-string` |
| Logs show no "Database enabled" line | Env var not reaching the process | Verify with `ps eww <PID> \| grep DATABASE` or check your plist/unit file |
| Tables missing after startup | Build is stale (pre-DB feature) | Run `npm run build` in the streamer directory |
| Managed sessions missing after migration | Existing rows have `NULL` instance_id | Run: `UPDATE managed_sessions SET instance_id = 'your-id' WHERE instance_id IS NULL;` |
| Sessions from another server showing up | Same or missing `THREADBASE_INSTANCE_ID` | Set a unique `THREADBASE_INSTANCE_ID` on each server |
