# Website Health Monitor

A small dependency-free Node app that checks configured websites on an interval and emails you when a site comes back from maintenance mode.

## What it does

- Starts with a monitor for `https://lisdtx.instructure.com/login/canvas`.
- Lets you add more websites from the browser UI.
- Checks each site about every 10 minutes by default.
- Treats a site as recovered when it returns an expected HTTP status and the response body no longer contains configured maintenance keywords.
- Sends one recovery email, then automatically pauses alerts for that site.
- Lets you pause checks, pause alerts, manually check now, or delete a monitor.

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

## Data

Monitors are stored in `data/sites.json`. The file is created automatically the first time the app runs.
