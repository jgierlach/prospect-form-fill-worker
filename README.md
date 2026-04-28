# prospect-form-fill-worker

Long-running worker that automates contact-form submissions on prospect
websites. Sibling service to `email-verification-service`. Companion to the
admin panel at `admin.corelabs.digital`.

Build spec: `admin-core-labs/PROSPECT_FORM_FILL_PROMPT.md`.

## Status

Through **step 7 of the build order** — discovery + submission + Decodo wired.

What works today:
- `GET /health` → `{ status: "ok" }`, no auth.
- `POST /batches/:id/run` → bearer-auth, claims items, runs Playwright form-fill,
  writes results.
- Discovery CLI: `npm run dev:discover <domain>` (heuristic mapper, with Claude Sonnet 4.6 fallback for opaque field names).
- Submission CLI: `npm run dev:submit <item_id>` for single-item iteration.
- Residential proxy via Decodo (sticky session per submission, response bytes
  tracked into `proxy_bytes_used`). Proxy is **optional** — without
  `DECODO_USERNAME`/`PASSWORD` set, traffic uses the box's IP (fine for
  smoke testing, useless against real prospect WAFs).

LLM field-mapping (step 8), 2Captcha (step 9), and Docker/systemd packaging
land in later steps.

## Local dev

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_TOKEN, etc.

npm install
npm run dev
```

`npm run dev` uses `node --watch` for hot reload.

Smoke test:

```bash
curl http://localhost:3000/health
# {"status":"ok"}

curl -X POST http://localhost:3000/batches/abc-123/run \
  -H "Authorization: Bearer $API_TOKEN"
# {"batch_id":"abc-123","status":"accepted"}
```

## Environment variables

See `.env.example` for the canonical list. As features land in subsequent build
steps, more vars will be added (Anthropic for LLM mapping, 2Captcha; sender
identity stays in admin-core-labs, not here).

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS — worker writes go through this |
| `API_TOKEN` | Bearer expected on `/batches/:id/run` from admin panel |
| `PORT` | HTTP listen port (default `3000`) |
| `LOG_LEVEL` | Pino level (`info`, `debug`, etc.) |
| `DECODO_USERNAME` / `DECODO_PASSWORD` | Optional; without these, no proxy |
| `DECODO_HOST` / `DECODO_PORT` | Default `gate.decodo.com:10001` |
| `ANTHROPIC_API_KEY` | Optional; without it the LLM mapper is skipped (heuristic only) |
| `ANTHROPIC_MODEL` | Default `claude-sonnet-4-6` |
| `TWOCAPTCHA_API_KEY` | Optional; without it captcha-protected forms are skipped |

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS — worker writes go through this |
| `API_TOKEN` | Bearer token expected on `/batches/:id/run` from admin panel |
| `PORT` | HTTP listen port (default `3000`) |
| `LOG_LEVEL` | Pino level (`info`, `debug`, etc.) |

## Deployment (Hetzner)

Target: a new Hetzner Cloud box (CCX23 sizing — 4 vCPU / 16GB), separate from
`email-verification-service`. Co-locating risks one bad Chromium OOM-killing
the email verification service.

Step-by-step deployment runbook lives in the build spec, but the high-level shape
matches the existing email-verification-service:

1. Provision Hetzner box (Ubuntu 24.04 LTS).
2. Install Node 20 LTS.
3. `git clone` this repo.
4. `npm ci --omit=dev`.
5. Set `/etc/<service>/env` with production values.
6. systemd unit (lands in step 12 — see spec §7.2 `deploy/`).
7. Configure DNS: an A record for the worker subdomain pointing at the box's IP.
8. Optional: Caddy in front for TLS termination.

## Conventions

This service mirrors `email-verification-service` patterns intentionally so
operational knowledge transfers:

- ESM JavaScript with JSDoc (`// @ts-check` via `jsconfig.json`).
- Fastify + Pino (built-in logger).
- `secure-json-parse` for tolerant body parsing (empty bodies → `{}`).
- Bearer-token auth via `onRequest` hook, exempting `/health`.
- Singleton Supabase client with `supabaseEnabled` flag — nothing throws at
  import time; endpoints check the flag and 500 with a clear message if
  Supabase isn't configured.
- Fire-and-forget `POST /batches/:id/run` returning 202 immediately.

## Layout

```
src/
├── index.js            # Fastify entry, route registration
└── supabase.js         # singleton client

# coming in later steps:
# src/discovery/        # contact-page resolver, form extractor, LLM mapper
# src/submission/       # Playwright + Decodo + 2Captcha + outcome detector
# src/queue/            # claim/complete/log helpers
# src/lib/              # user agents, delays, screenshots, retry
# deploy/               # Dockerfile, systemd unit, etc.
```
