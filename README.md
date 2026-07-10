# Radha Backend

NestJS backend for the RADHA platform. Three processes share one codebase:

| Process | Entry point | Responsibility |
|---|---|---|
| API | `src/main.api.ts` | HTTP — all REST endpoints |
| Worker | `src/main.worker.ts` | BullMQ processors (notifications, reports) |
| Scheduler | `src/main.scheduler.ts` | Cron jobs (expiry status, reminders, cleanup) |

Repo: `github.com/Shotlin/radha_backend`

**No local install.** This project deploys via Docker on the EC2 server.
There is no local `pnpm install` or local dev server. The EC2 host itself has
no Node.js — only Docker. All builds happen inside the Docker build stage.

## Production deploy

```bash
cd ~/radha_backend
git pull
docker compose -f docker-compose.selfhosted.yml --env-file .env.production up -d --build
```

SSH: `ssh -i "AWS.pem" ubuntu@ec2-13-203-219-243.ap-south-1.compute.amazonaws.com`

API health: `https://radha.opslin.com/api/v1/health`

**IMPORTANT**: The deploy directory on the EC2 host is `~/radha_backend`. There
is also a directory `~/radha_RETIRED_rollback_only_DO_NOT_DEPLOY` — this is the
old codebase, kept for rollback reference only. Never `cd` into it or run
`docker compose` from it (it shares the same Compose project name `radha` as
the live stack and would silently overwrite the running containers).

## Running migrations

Migrations do NOT run automatically on deploy. After any new migration file:

```bash
docker exec radha-api-1 sh -c "cd /app && ./node_modules/.bin/tsx src/db/migrate.ts"
```

Do not use `pnpm db:migrate` inside the container — corepack requires Node 22
but the container runs Node 20.

## Adding npm dependencies

The bare EC2 host has no Node.js. To update `pnpm-lock.yaml`:

```bash
docker run --rm \
  -v ~/radha_backend:/app -w /app \
  node:20-bookworm-slim \
  bash -c "corepack enable && corepack prepare pnpm@8.15.0 --activate && pnpm install --no-frozen-lockfile --lockfile-only"
```

Then commit the updated lockfile before rebuilding.

## Environment

Secrets live in `~/.env.production` on the EC2 host (flat path, no `server/`
prefix). Never paste values into this file from a chat or commit secrets to
any repo.

Key env vars:

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | Postgres container password |
| `DB_PASSWORD` | App connection pool password (must match POSTGRES_PASSWORD) |
| `DATABASE_URL` | Full Postgres connection string |
| `REDIS_PASSWORD` | Redis auth password |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO credentials |
| `AWS_S3_ENDPOINT` | MinIO public endpoint (self-hosted, not real AWS) |
| `AWS_S3_FORCE_PATH_STYLE` | `true` for MinIO path-style addressing |
| `GEMINI_API_KEY` | Google Gemini for AI product-label analysis |
| `FCM_SERVICE_ACCOUNT_JSON` | Firebase service account for push (set after Firebase provisioning) |
| `DEMO_MOBILE` / `DEMO_OTP` | Demo account bypass (enabled on prod; do NOT disable without testing real OTP) |

## Key directories

```
src/
  db/
    migrations/    SQL migration files (run explicitly, not auto)
    schema/        Drizzle schema files
  modules/         Feature modules (auth, products, expiry, notifications, …)
  jobs/
    cron/          Scheduled jobs (expiry-status, expiry-reminders, cleanup, …)
  integrations/    External APIs (Gemini, S3/MinIO, 2factor.in, Razorpay)
  config/          Zod env validation, typed config service
docker-compose.selfhosted.yml   Live compose file (6 containers + MinIO)
Dockerfile                      Multi-stage build — no local install needed
```

## Containers

```
radha-api-1        NestJS API          → 127.0.0.1:3000
radha-worker-1     BullMQ worker
radha-scheduler-1  Cron scheduler
radha-postgres     Postgres 16-alpine  → 127.0.0.1:5432
radha-redis        Redis 7-alpine      → 127.0.0.1:6379
radha-minio        MinIO S3-compatible → 127.0.0.1:9000/9001
radha-dashboard    Next.js dashboard   → 127.0.0.1:3100
```

## Backups

Nightly pg_dump → MinIO runs at **01:00 UTC** via cron
(`/home/ubuntu/scripts/backup_pg_redis.sh`). Bucket: `radha-backups`, 30-day
lifecycle. Backup freshness alert runs at **05:00 UTC**.

Restore:
```bash
# List available backups
aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://radha-backups/postgres/

# Download and restore
aws --endpoint-url http://127.0.0.1:9000 s3 cp s3://radha-backups/postgres/<file>.sql.gz /tmp/
gunzip /tmp/<file>.sql.gz
docker exec -i radha-postgres psql -U radha -d radha < /tmp/<file>.sql
```
