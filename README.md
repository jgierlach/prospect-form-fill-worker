# prospect-form-fill-worker

Long-running worker that automates contact-form submissions on prospect
websites. Sibling service to `email-verification-service`. Companion to the
admin panel at `admin.corelabs.digital`.

Build spec: `admin-core-labs/PROSPECT_FORM_FILL_PROMPT.md`.

## Status

All 12 build-order steps shipped. Currently in production-ready state.

What works today:

- **`GET /health`** → `{ status: "ok" }`, no auth, used for liveness checks.
- **`POST /batches/:id/run`** → bearer-auth, claims items from
  `prospect_form_submission_batch_items`, runs Playwright form-fill
  end-to-end, writes results.
- **Discovery pipeline** with hybrid heuristic→LLM field mapping (Claude
  Sonnet 4.6 fallback for plugin-driven forms with opaque field names).
- **Decodo residential proxy** with sticky session per submission (different
  IP per form-fill). Bytes tracked per item.
- **2Captcha solving** for reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile.
  Solve cost tracked per item.
- **Retry/backoff** (5min → 30min → terminal) with non-retryable categories
  (`captcha_failed`, `blocked`, `no_form_cache`, `form_disappeared`).
- **Crash recovery** on startup — `recoverOnStartup` reclaims stale claims
  and resumes any in-flight batches. Safe to `pm2 restart` mid-batch.
- **Screenshots** uploaded to Supabase Storage (`prospect-form-fill-evidence`
  bucket) at three points per submission: before, pre-submit, after.
- **CLIs** for iteration: `npm run dev:discover <domain>` and
  `npm run dev:submit <item_id>`.

## Quick reference

| Item | Value |
|---|---|
| Public IPv4 | `87.99.154.66` (Ashburn, VA) |
| Default port | `3000` |
| Process manager | pm2 (`prospect-form-fill-worker`) |
| Install path | `/root/prospect-form-fill-worker` |
| SSH | `ssh form-fill` (per `~/.ssh/config`) |
| Auth | Bearer token in `Authorization` header (everything except `/health`) |
| Trigger from admin | `POST /batches/:id/run` |

## Local development

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_TOKEN at minimum

npm install
npx playwright install chromium     # one-time, downloads ~170MB
npm run dev
```

`npm run dev` uses `node --watch` for hot reload.

Smoke-test the running server:

```bash
curl http://localhost:3000/health
# {"status":"ok"}

curl -X POST http://localhost:3000/batches/abc-123/run \
  -H "Authorization: Bearer $API_TOKEN"
# {"batch_id":"abc-123","status":"accepted"}
```

For developer iteration on the discovery / submission flows without setting
up a full batch:

```bash
# Probe a domain — populates prospect_form_cache when --persist is set
npm run dev:discover wpforms.com
npm run dev:discover wpforms.com -- --persist

# Process a single batch item end-to-end with verbose logs
npm run dev:submit <item_id>
npm run dev:submit <item_id> -- --headed     # show the Chromium window
```

## Environment variables

`.env.example` is the canonical list.

| Var | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Bypasses RLS — worker writes go through this |
| `API_TOKEN` | yes | Bearer expected on `/batches/:id/run` from admin panel |
| `PORT` | no (default `3000`) | HTTP listen port |
| `LOG_LEVEL` | no (default `info`) | Pino level (`info`, `debug`, `warn`, `error`) |
| `DECODO_USERNAME` | no | Without it, no residential proxy (uses box's IP) |
| `DECODO_PASSWORD` | no | Decodo account password |
| `DECODO_HOST` | no (default `gate.decodo.com`) | Decodo gateway host |
| `DECODO_PORT` | no (default `10001`) | Decodo gateway port |
| `ANTHROPIC_API_KEY` | no | Without it, LLM mapper is skipped — heuristic only |
| `ANTHROPIC_MODEL` | no (default `claude-sonnet-4-6`) | Model ID for field-mapping |
| `TWOCAPTCHA_API_KEY` | no | Without it, captcha-protected forms are skipped (`captcha_pending`) |
| `SUBMISSION_CONCURRENCY` | no (default `3`) | Parallel submissions per batch |
| `SUBMISSION_TIMEOUT_MS` | no (default `120000`) | Hard cap per item |
| `WORKER_ID_PREFIX` | no (default `hetzner-prospect-fill`) | Trace prefix for `worker_id` column |

The worker auto-loads `.env` via `dotenv/config` at startup — no need to
`source` before launching.

## Deployment runbook

### Provisioning a new Hetzner box (one-time)

1. **Hetzner Console** → Add Server.
   - Type: **CCX23** (4 vCPU / 16 GB / 160 GB) — Dedicated, AMD x86. Don't
     pick CX (cost-optimized, shared); Playwright needs predictable CPU.
   - Location: **Ashburn, VA (us-east)** — closest to Decodo's US edge.
   - Image: **Ubuntu 24.04**.
   - Networking: IPv4 + IPv6.
   - SSH key: add the `~/.ssh/hetzner.pub` key from the existing setup.
2. After provisioning, copy the public IP. Add to `~/.ssh/config`:
   ```
   Host form-fill
     HostName <new-ip>
     User root
     IdentityFile ~/.ssh/hetzner
     IdentitiesOnly yes
   ```

### First-time setup on the box

Run as root after `ssh form-fill`:

```bash
# Node 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# pm2 globally
npm install -g pm2

# Clone (push the repo to your GitHub remote first if it doesn't already exist)
cd ~
git clone git@github.com:<your-org>/prospect-form-fill-worker.git
cd prospect-form-fill-worker

# Production deps only
npm ci --omit=dev

# Playwright — required once per box, again whenever package.json bumps Playwright
npx playwright install chromium
npx playwright install-deps chromium    # apt-installs Chromium's OS deps

# Configure
cp .env.example .env
nano .env       # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_TOKEN at minimum
                # add DECODO_*, ANTHROPIC_*, TWOCAPTCHA_* as services come online

# Launch under pm2
pm2 start npm --name prospect-form-fill-worker -- start
pm2 save
pm2 startup     # follow the printed instruction to enable on boot

# Verify
curl http://localhost:3000/health
# {"status":"ok"}
```

### Routine deploy (code change pushed to GitHub)

```bash
ssh form-fill
cd ~/prospect-form-fill-worker
git pull
npm ci --omit=dev                 # picks up any new deps
# If package.json bumped the Playwright version:
#   npx playwright install chromium
pm2 restart prospect-form-fill-worker --update-env
pm2 logs prospect-form-fill-worker --lines 20
```

The startup line should read `Prospect form-fill worker listening on port 3000`. If a batch was running mid-restart, you'll also see
`[runner] resuming in-flight batches { count: N, batchIds: [...] }`.

### Adding or updating an env var

```bash
ssh form-fill
cd ~/prospect-form-fill-worker
nano .env
pm2 restart prospect-form-fill-worker --update-env
```

The `--update-env` flag is **required** — without it, pm2 keeps the old env
from when the process was last started. New keys silently won't load.

### Enabling each optional service

The worker degrades gracefully when an optional service isn't configured.
Enable them one at a time in this order so you can attribute behavior changes:

1. **Decodo** — without it, traffic uses the box's datacenter IP. Most
   prospect-site WAFs (Cloudflare especially) will block. Sign up at
   `decodo.com`, pick PAYG residential proxies, set `DECODO_USERNAME` +
   `DECODO_PASSWORD`. Verify with the curl in the
   *Verifying end-to-end* section below.
2. **Anthropic API** — without it, the LLM field-mapper is skipped. Heuristic
   mapping handles plain HTML forms but fails on plugin-driven sites
   (WPForms, Gravity Forms with opaque field names). Set `ANTHROPIC_API_KEY`.
3. **2Captcha** — without it, captcha-protected forms are marked `skipped`
   with reason `captcha_pending`. Sign up at `2captcha.com`, fund the
   account ($10 minimum recommended), set `TWOCAPTCHA_API_KEY`.

## Verifying end-to-end

After a fresh deploy or a meaningful config change, run this gauntlet from
the box. It exercises every shipped feature in order.

```bash
ssh form-fill
cd ~/prospect-form-fill-worker
set -a; source .env; set +a    # for the curls below

# 1. Worker is alive
curl -sS http://localhost:3000/health                                    # {"status":"ok"}

# 2. Bearer auth works (and rejects bad tokens)
curl -sS -X POST http://localhost:3000/batches/test-id/run \
  -H "Authorization: Bearer $API_TOKEN"                                  # 202
curl -sS -X POST http://localhost:3000/batches/test-id/run               # 401

# 3. Decodo proxy + sticky sessions (skip if DECODO_* unset)
for i in 1 2; do
  curl -sS -U "${DECODO_USERNAME}-session-test$i:${DECODO_PASSWORD}" \
       -x "${DECODO_HOST}:${DECODO_PORT}" \
       "https://ip.decodo.com/json"
  echo
done
# Expect two 200 responses with DIFFERENT residential IPs from US ISPs
# (Comcast, Spectrum, AT&T, etc.) — confirms session syntax + auth.

# 4. 2Captcha balance (skip if TWOCAPTCHA_API_KEY unset)
curl -sS "https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=getbalance&json=1"
# Expect: {"status":1,"request":"<dollars remaining>"}

# 5. Discovery on a known-permissive domain
node scripts/dev-discover.js wpforms.com 2>&1 | tail -25
# Expect: "status": "success", a fieldMapping with email + message,
# mappingMethod = "heuristic" (no Anthropic call needed) or "llm".
```

Then in the **admin Queue UI** (`/app/prospect-form-submissions/queue`):

6. Pick 1-3 websites that have `discovery_status = 'success'` in
   `prospect_form_cache`.
7. Run a **dry-run** batch first. Watch the active-batch progress bar at
   the top of the Queue. Items should flip pending → processing → success
   within ~30s each. Click the screenshot link on a completed item to see
   the filled form.
8. Run a **live** batch (uncheck Dry run) against one website. Watch
   `pm2 logs prospect-form-fill-worker -f` while it runs:
   - `[browser] session launched` with `proxyEnabled: true`
   - `[captcha] solved` if the site has one
   - `[runner] item complete` with `outcome.status` and `proxyBytes`

If all of that lands without errors, the deploy is healthy.

## Common operations

```bash
pm2 status                                      # one-line process health
pm2 logs prospect-form-fill-worker -f           # follow logs (Ctrl+C exits)
pm2 logs prospect-form-fill-worker --err        # only stderr
pm2 logs prospect-form-fill-worker --lines 200  # tail with N lines
pm2 flush prospect-form-fill-worker             # wipe cumulative log files
pm2 monit                                       # live CPU/memory dashboard
pm2 reload prospect-form-fill-worker            # zero-downtime reload (if cluster-mode)
pm2 restart prospect-form-fill-worker --update-env  # restart picking up new .env
pm2 stop prospect-form-fill-worker              # stop the process (still tracked)
pm2 start prospect-form-fill-worker             # start a stopped process
```

To inspect what a running batch is doing:

```sql
-- In Supabase SQL Editor:
SELECT id, status, total, succeeded, failed, skipped, created_at
FROM prospect_form_submission_batches
WHERE status = 'running'
ORDER BY created_at DESC;

-- Items currently in flight
SELECT id, sourced_website_id, status, attempts, claimed_at, worker_id, failure_reason
FROM prospect_form_submission_batch_items
WHERE batch_id = '<batch-id>'
ORDER BY status, created_at;

-- Per-step audit trail for a specific item
SELECT step, status, duration_ms, metadata, created_at
FROM prospect_form_submission_logs
WHERE item_id = '<item-id>'
ORDER BY created_at;
```

## Troubleshooting

### `ERR_MODULE_NOT_FOUND: Cannot find package '<x>'`

`npm ci --omit=dev` wasn't run after `git pull` brought in a new dep. Fix:

```bash
cd ~/prospect-form-fill-worker
npm ci --omit=dev
pm2 restart prospect-form-fill-worker --update-env
```

If the missing package is `playwright`, ALSO run
`npx playwright install chromium` after the `npm ci`.

### `[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing`

The worker can't see those env vars at startup. Check:

```bash
cd ~/prospect-form-fill-worker
cat .env | grep SUPABASE       # confirm both keys present, non-empty
pm2 restart prospect-form-fill-worker --update-env   # the --update-env flag is required
```

If `.env` has them but the warning persists, you might be looking at stale
log entries — `pm2 flush prospect-form-fill-worker` then `pm2 restart` and
re-check.

### Chromium fails to launch with missing system libs

```bash
npx playwright install-deps chromium
```

Installs the apt packages Chromium needs (fonts, X libs). Required once per
box. Re-run after major OS upgrades.

### Items stuck in `processing` status

The worker died mid-claim. `recoverOnStartup` is supposed to handle this on
the next launch, but if a manual nudge is needed:

```sql
-- In Supabase SQL Editor:
SELECT public.reclaim_stale_prospect_form_submission_items(60);
-- Returns the number of items flipped pending → processing → pending again.
```

Then `pm2 restart prospect-form-fill-worker` and the new process will pick
them up.

### Decodo auth fails (`407 Proxy Authentication Required`)

Either the credentials are wrong or the username didn't get the
`-session-XXX` suffix. Verify:

```bash
set -a; source .env; set +a
curl -v -U "${DECODO_USERNAME}-session-test1:${DECODO_PASSWORD}" \
     -x "${DECODO_HOST}:${DECODO_PORT}" \
     "https://ip.decodo.com/json" 2>&1 | head -20
```

Look for `HTTP/1.1 200`. If you see `407`, double-check the password (regenerate in
the Decodo dashboard if exposed) and confirm the account has balance.

### 2Captcha solves are timing out

Two common causes:

1. **Account out of balance.** Check with
   `curl "https://2captcha.com/res.php?key=$TWOCAPTCHA_API_KEY&action=getbalance&json=1"`.
   If `request` is `0` or low, top up.
2. **Site uses an unsupported captcha variant.** The worker handles
   reCAPTCHA v2, reCAPTCHA v3, hCaptcha, and Cloudflare Turnstile. Anything
   else (Arkose Labs, GeeTest, image puzzles) won't solve and will fail
   with `captcha_failed`. Mark those domains disqualified.

### LLM mapper returns garbage

Worker logs `[llm-field-mapper] could not parse JSON`. Usually transient —
Claude occasionally wraps the JSON in prose despite the prompt. The
heuristic mapping is used as fallback, and discovery proceeds. If you see
this consistently, increase `max_tokens` in `src/discovery/llm-field-mapper.js`
or tighten the prompt.

## Conventions

This service mirrors `email-verification-service` patterns intentionally so
operational knowledge transfers between the two:

- **ESM JavaScript with JSDoc** (`// @ts-check` via `jsconfig.json`).
- **Fastify + Pino** (built-in logger).
- **`secure-json-parse`** for tolerant body parsing (empty bodies → `{}`).
- **Bearer-token auth** via `onRequest` hook, exempting `/health`.
- **Singleton Supabase client** with `supabaseEnabled` flag — nothing throws
  at import time; endpoints check the flag and 500 with a clear message if
  Supabase isn't configured.
- **Fire-and-forget** `POST /batches/:id/run` returning 202 immediately.
- **`dotenv/config` at every entry point** (`src/index.js`, dev CLIs) so the
  worker self-loads `.env` regardless of launching shell.
- **pm2** as process manager. `--update-env` on every restart after `.env`
  changes.

## Layout

```
src/
├── index.js                       # Fastify entry, /health + POST /batches/:id/run
├── supabase.js                    # singleton client with supabaseEnabled flag
├── lib/
│   ├── delays.js                  # human-typed timing helpers
│   ├── fetchHtml.js               # bounded-timeout GET, never throws
│   ├── screenshots.js             # capture + Storage upload
│   └── userAgents.js              # rotating UA + viewport pool
├── discovery/
│   ├── crawler.js                 # contact URL resolver (cache → links → probe)
│   ├── extractor.js               # form scoring, scoping, field extraction
│   ├── field-mapper.js            # heuristic name→semantic-key mapping
│   ├── llm-field-mapper.js        # Claude Sonnet 4.6 fallback
│   ├── captcha-detector.js        # vendor + sitekey detection
│   └── runner.js                  # discoverDomain orchestrator + persistDiscovery
├── submission/
│   ├── browser.js                 # Chromium + Decodo + bytes tracking
│   ├── filler.js                  # human-typed fill, iframe-aware
│   ├── captcha-solver.js          # 2Captcha API + per-type token injection
│   ├── outcome-detector.js        # success / failed / ambiguous classification
│   ├── submitter.js               # click + wait + classify
│   └── runner.js                  # runSubmissionBatch + recoverOnStartup
└── queue/
    ├── claim.js                   # claim_prospect_form_submission_items RPC
    ├── complete.js                # success/failure/skipped + retry backoff
    └── log.js                     # prospect_form_submission_logs insert

scripts/
├── dev-discover.js                # CLI: discover a single domain
├── dev-submit.js                  # CLI: process a single batch item
├── smoke-decodo.mjs               # Standalone Decodo wiring check
└── smoke-fill.mjs                 # Standalone Playwright + filler check
```
