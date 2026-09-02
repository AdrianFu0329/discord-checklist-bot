# Deploying to Fly.io

## Why the move

Render's free tier routes outbound traffic through IPs shared with every other
free-tier tenant, and Discord rate-limits those IPs. The bot's logs showed the
whole story: DNS fine, TCP to `discord.com:443` in 11ms, TLS fine — then
`HTTP 429` in 19ms on the very first API call of a fresh process. discord.js
honours the `retry_after`, so `GET /gateway/bot` never returned and no shard was
ever spawned (`ws.status = 3`, `shards = 0`).

No code change fixes an IP-level block. Hence a different host.

Fly also suits the workload better: a Discord bot holds a long-lived outbound
gateway connection, so it is a persistent process, not a web service. The HTTP
listener and self-ping in `index.js` only ever existed to stop Render sleeping,
and both switch themselves off here.

## One-time setup

```sh
brew install flyctl
fly auth login          # opens a browser
```

`fly auth login` is interactive — run it yourself. In Claude Code you can prefix
it with `!` to run it in-session.

## Launch

From the repo root. `--no-deploy` matters: the app must have its secrets before
it first starts, or it will boot, find no token and exit.

```sh
fly launch --no-deploy --copy-config --name discord-checklist-bot --region sin
```

- `--copy-config` uses the committed `fly.toml` instead of generating one.
- `--region sin` is Singapore, closest to the team's `Asia/Kuala_Lumpur` timezone.
- If the app name is taken, pick another and update `app =` in `fly.toml`.

## Secrets

Never commit these; `fly secrets` stores them encrypted and restarts the app.

```sh
fly secrets set DISCORD_TOKEN=... CLIENT_ID=...
```

## Deploy

```sh
fly deploy
fly logs
```

## What a healthy start looks like

```
PORT not set — no HTTP listener needed (not on Render).
[net] node v22.11.0 on linux/x64
[net] tls discord.com:443 -> OK (TLSv1.3, authorized=true)
[net] node https  GET /users/@me -> HTTP 200
[net] undici fetch GET /users/@me -> HTTP 200
[preflight] REST auth OK -> <botname> (<id>)
Logged in as <botname>#0000
[cron] Weekly checklist scheduled: Saturdays 08:00 Asia/Kuala_Lumpur
```

## If Fly's IP is rate-limited too

This is the one risk the migration does not eliminate: Fly NATs outbound traffic
through shared egress addresses, and those can be rate-limited exactly like
Render's. The diagnostics carry over, so the logs answer it immediately:

- `HTTP 200` on both probes — you are fine.
- `HTTP 429 ... VERDICT=cloudflare-ip-ban` — the shared egress IP is blocked.
  Allocate a dedicated outbound address:
  ```sh
  fly machines egress-ip allocate
  ```
  Note this is a paid add-on, and inbound `fly ips allocate-v4` is a *different*
  thing that does not change egress.
- If that still fails, a small VPS (Hetzner, ~4 EUR/mo) gives a dedicated IP
  outright and is the reliable end of the range.

## Keeping it to one machine

Two machines means two gateway sessions on one token, racing for the same button
clicks. Check and correct with:

```sh
fly status
fly scale count 1
```

## Slash commands

`/checklist` is registered globally against the application, not the host, so it
survives the move. Only re-run `npm run register` if the command definition
changes.

## Render

`render.yaml` is left in place as a rollback path and is excluded from the Docker
image. Delete it once Fly is confirmed working.
