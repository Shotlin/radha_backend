# RADHA Server

Production-grade NestJS backend for the RADHA platform. Three independently runnable processes share one codebase:

| Process | Entry file | Responsibility |
|---|---|---|
| API | `src/main.api.ts` | HTTP request handling |
| Worker | `src/main.worker.ts` | BullMQ background processors (BE-24+) |
| Scheduler | `src/main.scheduler.ts` | Cron jobs (BE-30, BE-39, BE-49, BE-52, BE-54) |

## Prerequisites

- Node.js 18.17 or higher
- pnpm 8.10 or higher
- (Later phases add: Postgres 15, Redis 7, AWS account)

## Local development

```bash
pnpm install                    # from monorepo root
cp server/.env.example server/.env.local
pnpm --filter @radha/server start:dev
```

Visit http://localhost:3000/api/v1/health

## Build & test

```bash
pnpm --filter @radha/server lint
pnpm --filter @radha/server test
pnpm --filter @radha/server test:e2e
pnpm --filter @radha/server build
```

## Phase progress

This codebase is built phase-by-phase. The current scaffolding satisfies **BE-01 only**:
- ✅ Three entry points
- ✅ Root module + ConfigModule + ScheduleModule
- ✅ Health + readiness endpoints (URI-versioned)
- ✅ Helmet, compression, CORS, ValidationPipe
- ✅ Graceful shutdown on SIGTERM/SIGINT
- ⏳ BE-02 will add Zod env validation
- ⏳ BE-03 will add request context middleware
- ⏳ BE-04 will add structured logging + error handling

See `BACKEND_PHASES/00_MASTER_BACKEND_ROADMAP.md` for the full plan.
