# Runbook — Weekly Video Checklist Bot

Operational guide: setup, health checks, logs, and troubleshooting.

**Live URL:** `https://discord-checklist-bot.spcbc.workers.dev`
**Platform:** Cloudflare Workers (HTTP interactions)
**Source:** `worker/` — see [`worker/README.md`](worker/README.md) for design notes

---

## 1. Architecture in one minute

There are two builds in this repo. Only one runs at a time.

| | `worker/` (**live**) | `index.js` (fallback) |
|---|---|---|
| How Discord reaches it | Discord POSTs each interaction | Bot holds an outbound WebSocket |
| Hosting | Cloudflare Workers, free | Needs an always-on VM |
| State | KV, survives deploys | In-memory, lost on restart |
| Weekly post | Cron Trigger | `node-cron`, only fires if alive |

The gateway build is kept as a fallback and documented in [`DEPLOY.md`](DEPLOY.md).
It requires a host with a **dedicated** outbound IP that Discord is not
rate-limiting — a shared free-tier pool is what took it down on Render (see §5).

**Only one may be active.** Setting an Interactions Endpoint URL stops Discord
delivering over the gateway; running both means clicks land in only one.

---

## 2. Setup from scratch

```sh
cd worker
npm install
npx wrangler login
```

### KV namespace

```sh
npx wrangler kv namespace create CHECKLIST
```

Paste the printed id into `wrangler.toml` under `[[kv_namespaces]]`. If it says
the namespace already exists, list it instead:

```sh
npx wrangler kv namespace list
```

### Secrets

From the [Discord Developer Portal](https://discord.com/developers/applications):

| Secret | Where to find it |
|---|---|
| `DISCORD_TOKEN` | **Bot** tab → Reset Token (shown once) |
| `DISCORD_PUBLIC_KEY` | **General Information** → Public Key |

`DISCORD_PUBLIC_KEY` is *not* the token and *not* the client secret. Mixing them
up is the usual reason the endpoint refuses to save.

```sh
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
```

Wrangler prompts for the value, so nothing lands in shell history.

### Deploy

```sh
npx wrangler deploy
```

### Point Discord at it

Developer Portal → **General Information** → **Interactions Endpoint URL** →
paste the Worker URL → **Save Changes**.

Discord immediately sends one PING with a valid signature and one request with a
deliberately invalid signature. The endpoint must answer PONG to the first and
401 to the second, or the save is rejected.

### Slash command

Registered against the application, not the host, so it survives host changes.
Only needed if the command definition changes. From the repo root:

```sh
npm run register     # needs DISCORD_TOKEN and CLIENT_ID in .env
```

---

## 3. Health checks

### Is it up?

```sh
curl -s https://discord-checklist-bot.spcbc.workers.dev/
```

Expected: `Checklist bot is alive` with HTTP 200.

### Is signature verification working?

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H 'x-signature-ed25519: 00' -H 'x-signature-timestamp: 1' \
  --data '{"type":1}' https://discord-checklist-bot.spcbc.workers.dev/
```

Expected: **401**. Anything else — especially 500 — means Discord's endpoint
validation will fail.

### Is state being written?

```sh
cd worker && npx wrangler kv key list --binding CHECKLIST
```

Each posted checklist appears as `state:<id>` with an expiry ~90 days out. An
empty list after someone has run `/checklist` means KV writes are failing.

### What's deployed?

```sh
npx wrangler deployments list
npx wrangler secret list          # names only, never values
npx wrangler whoami               # which account you're pointed at
```

### End-to-end

In Discord: run `/checklist`, click **Mon: Edited**, submit a link. The QC role
should be pinged in the ping channel and the checklist row should update.

---

## 4. Logs

```sh
cd worker
npx wrangler tail                       # live stream
npx wrangler tail --status error        # errors only
npx wrangler tail --format pretty
```

`wrangler tail` shows nothing until a request arrives — click a button in
Discord to generate traffic.

Logs are also in the dashboard: **Workers & Pages → discord-checklist-bot →
Logs**.

What the Worker logs on its own:

| Message | Meaning |
|---|---|
| `Discord POST /channels/... -> 403` | Bot lacks permission in that channel |
| `Discord POST /channels/... -> 429` | Rate limited (see §5) |
| `Signature verification error: ...` | Malformed signature; request rejected |
| `Could not clear old pins: ...` | Missing "Manage Messages"; new pin still attempted |
| `Interaction error: ...` | Unhandled error; user saw a generic message |

---

## 5. Troubleshooting

### Endpoint URL won't save in the Developer Portal

Discord probes with a valid and an invalid signature. Run both health checks in
§3. Common causes:

- `DISCORD_PUBLIC_KEY` holds the **token** or **client secret** instead of the
  public key
- Secret not set at all — `npx wrangler secret list`
- Worker returning 500 on bad signatures instead of 401

### Buttons say "no longer tracked"

The state id in the button isn't in KV. Either the checklist is older than the
90-day TTL, or the KV binding is wrong. Check `npx wrangler kv key list
--binding CHECKLIST` and confirm the id in `wrangler.toml` matches
`npx wrangler kv namespace list`. Post a fresh `/checklist`.

### Nothing happens when a button is clicked

- `npx wrangler tail` — if no request arrives, Discord isn't reaching the Worker;
  re-check the Interactions Endpoint URL
- If a request arrives and 401s, the public key is wrong
- Confirm the old gateway host (Render/VM) is stopped

### Pings not appearing

The bot needs **View Channel** and **Send Messages** in `PING_CHANNEL_ID`, and
**Mention Everyone** plus **Manage Messages** in `AUTOPOST_CHANNEL_ID` for the
weekly post and pinning. Look for `-> 403` in the logs.

### Weekly post didn't fire

`crons = ["0 0 * * 6"]` in `wrangler.toml`. Workers cron is **UTC**; Saturday
08:00 Asia/Kuala_Lumpur (UTC+8) is Saturday 00:00 UTC. Change both together.
Verify the trigger is attached — `npx wrangler deploy` prints `schedule: 0 0 * * 6`.

### Deploy fails: `KV namespace '...' is not valid [code: 10042]`

`wrangler.toml` still holds a placeholder or a stale id. Fix per §2.

### Deploy fails: `You need to register a workers.dev subdomain`

One-time, account-wide. Register at **Workers & Pages** in the dashboard, then
redeploy.

### New Worker URL doesn't resolve in the browser

Fresh subdomains take a few minutes, and macOS caches the failed lookup:

```sh
sudo dscacheutil -flushcache
```

To test before DNS settles, pin the IP from `dig +short <url>`:

```sh
curl --resolve discord-checklist-bot.spcbc.workers.dev:443:<ip> https://discord-checklist-bot.spcbc.workers.dev/
```

### `HTTP 429` when calling Discord

This is what broke the Render deployment. Discord rate-limits IPs, and shared
free-tier egress pools are blocked. Symptoms: TCP and TLS connect fine, then the
first API call returns 429 in milliseconds.

It's an IP-level block — no code change avoids it. Cloudflare's egress is not
affected, which is why the bot lives here. If you ever move it back to a shared
host, expect this to return.

**A 429 is not a bad token.** A bad token returns **401**.

### Gateway build (`index.js`) won't connect

Only relevant if running the fallback. It self-diagnoses on startup:

```
[net] node v22.11.0 on linux/x64
[net] tcp discord.com:443 -> OK in 11ms
[net] tls discord.com:443 -> OK (TLSv1.3, authorized=true)
[net] node https  GET /users/@me -> HTTP 200
[preflight] REST auth OK -> <botname> (<id>)
```

| Symptom | Cause |
|---|---|
| `HTTP 429` on the probes | Host's IP is rate-limited — change host |
| `HTTP 401` | Token wrong or revoked |
| `tcp ... TIMED OUT` | Outbound 443 blocked by the host |
| `node v26.x` or similar | Runtime too new for the bundled undici; pin Node 22 |
| `Missing script: start` | `package.json` has no `start` script |

Set `DISCORD_DEBUG=1` to keep gateway debug logging on past startup.

---

## 6. Routine tasks

### Deploy a change

```sh
cd worker
npm test
npx wrangler deploy
```

### Rotate the bot token

Developer Portal → **Bot** → Reset Token, then:

```sh
npx wrangler secret put DISCORD_TOKEN
```

Takes effect immediately; no redeploy needed.

### Change the ping or autopost channel

Edit `[vars]` in `worker/wrangler.toml`, then `npx wrangler deploy`. These are
plain vars, not secrets — channel ids aren't sensitive.

### Change roles or days

`worker/src/checklist.js` — `QC_BY_DAY`, `EDITOR_BY_DAY`, `DAYS_OF_WEEK`. Run
`npm test` afterwards; the suite checks the button layout still fits Discord's
5×5 limit.

### Run the tests

```sh
cd worker && npm test
```

Drives the whole editor → QC → approve flow with KV and the Discord API stubbed,
plus signature rejection and the cron path.

---

## 7. Cost

Cloudflare Workers free tier: 100k requests/day, 1k KV writes/day. A team of six
working through a weekly checklist uses a few hundred requests a week — roughly
three orders of magnitude below the limit.
