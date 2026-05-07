# Website Health Monitor

A small dependency-free Node app that checks configured websites on an interval and emails you when a site comes back from maintenance mode.

## What it does

- Starts with a monitor for `https://lisdtx.instructure.com/login/canvas`.
- Lets you add more websites from the browser UI.
- Checks each site about every 10 minutes by default.
- Treats a site as recovered when it returns an expected HTTP status and the response body no longer contains configured maintenance keywords.
- Sends one recovery email, then automatically pauses alerts for that site.
- Lets you pause checks, pause alerts, manually check now, or delete a monitor.
- Supports admin-token protection, public-hostname checks, domain allowlists, rate limiting, check jitter, recovery confirmation, and email cooldowns.

## Run it

```bash
cp .env.example .env
```

Fill in the SMTP values in `.env`, then load them before starting:

```bash
set -a
source .env
set +a
npm start
```

Open `http://localhost:3000`.

If `npm` is not installed, run the same app with:

```bash
node server.js
```

## Email setup

The app sends mail through SMTP using these environment variables:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `ALERT_FROM`
- `ALERT_TO`

For Gmail, create an app password and use `smtp.gmail.com`, port `587`, and `SMTP_SECURE=false`.

## Hardening

Before running this anywhere other than your own laptop, set `ADMIN_TOKEN` in `.env`. The browser will show an admin token field and mutation requests must include it.

Useful controls:

- `ALLOWED_DOMAINS`: comma-separated domains that may be monitored, such as `instructure.com,example.org`.
- `BLOCK_PRIVATE_NETWORKS=true`: blocks localhost, private IP ranges, and hostnames that resolve to private networks.
- `MAX_SITES=25`: caps how many monitors can be added.
- `MIN_INTERVAL_MS=300000`: prevents very frequent checks.
- `MUTATION_RATE_MAX=30`: limits add/edit/delete/check/test-email actions per rate window.
- `RECOVERY_CONFIRMATION_CHECKS=2`: requires repeated healthy checks before emailing recovery.
- `ALERT_COOLDOWN_MS=86400000`: prevents repeated recovery emails for flapping sites.
- `CHECK_USER_AGENT`: identifies this as a health monitor instead of a generic script.

These defaults are meant to keep monitoring polite and narrow, not to bypass site defenses. For third-party websites, monitor only targets you are responsible for or have permission to check.

## Data

Monitors are stored in `data/sites.json`. The file is created automatically the first time the app runs.
