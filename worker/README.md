# Cloudflare Workers build

The gateway build (`../index.js`) holds a WebSocket open to Discord. That needs
an always-on process and an outbound IP Discord is not rate-limiting — and
Render's shared free-tier IPs are rate-limited, which is what broke it.

This build inverts the direction: Discord **POSTs each interaction here**, and
most replies go straight back in the HTTP response. No persistent connection, no
always-on process, and nothing on the hot path depends on outbound IP reputation.

It also fixes a bug the gateway build always had: checklist state lived in a
`Map`, so every restart expired every open checklist. Here it lives in KV.

| | Gateway build | Workers build |
|---|---|---|
| Connection | outbound WebSocket, always on | inbound HTTPS per interaction |
| State | in-memory, lost on restart | KV, survives deploys |
| Weekly post | `node-cron`, only if alive | Cron Trigger |
| Hosting | VM or paid web service | Workers free tier |

## Setup

```sh
cd worker
npm install
npx wrangler login
```

### 1. KV namespace

```sh
npx wrangler kv namespace create CHECKLIST
```

Paste the printed id into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 2. Secrets

`DISCORD_PUBLIC_KEY` is on the Discord Developer Portal under **General
Information → Public Key**. It is not the bot token, and not the client secret.

```sh
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
```

### 3. Deploy

```sh
npx wrangler deploy
```

Note the URL it prints, e.g. `https://discord-checklist-bot.<subdomain>.workers.dev`.

### 4. Point Discord at it

Developer Portal → your app → **General Information** → **Interactions Endpoint
URL** → paste the Worker URL → **Save Changes**.

Discord immediately sends a PING with a valid signature, and a second request
with a deliberately invalid one. Both must be handled correctly or the save is
rejected — the Worker answers PONG to the first and 401 to the second. If the
save fails, check that `DISCORD_PUBLIC_KEY` is the Public Key rather than the
token.

### 5. Slash command

Registered against the application, not the host, so if you already ran this for
the gateway build it is still in place. Otherwise, from the repo root:

```sh
npm run register
```

## Once the endpoint is set

Discord **stops delivering interactions over the gateway** once an Interactions
Endpoint URL is configured. Do not run both builds at once — turn off the Render
service / VM first, or button clicks will land in only one of them.

## Testing

```sh
npm test
```

Drives the whole editor → QC → approve flow against the Worker's handler with KV
and the Discord API stubbed, including signature rejection and the cron job.

```sh
npx wrangler dev      # local
npx wrangler tail     # live logs from the deployed Worker
```

## Cron

`crons = ["0 0 * * 6"]` in `wrangler.toml`. Workers cron is **UTC**, and
Saturday 08:00 Asia/Kuala_Lumpur (UTC+8) is Saturday 00:00 UTC. Adjust both
together if the schedule ever moves.

## Cost

Free tier is 100k requests/day and 1k KV writes/day. A team of six clicking
through a weekly checklist uses a few hundred requests a week.
