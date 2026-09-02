# Deploying the checklist bot

## Why it moved off Render

Render's free tier routes outbound traffic through IPs shared with every other
free-tier tenant, and Discord rate-limits those IPs. The logs showed the whole
chain: DNS fine, TCP to `discord.com:443` in 11ms, TLS fine — then `HTTP 429` in
19ms on the first API call of a fresh process, from both undici and Node's own
HTTP client. discord.js honours the `retry_after`, so `GET /gateway/bot` never
returned and no shard was ever spawned (`ws.status = 3`, `shards = 0`).

No code change routes around an IP-level block. The fix is an IP Discord is not
rate-limiting — which means a host with a **dedicated** outbound address, not a
shared NAT pool. Oracle Cloud's Always Free tier gives one at no cost.

## 1. Create the VM

In the Oracle Cloud console: **Compute → Instances → Create instance**.

- **Image:** Canonical Ubuntu 24.04
- **Shape:** `VM.Standard.A1.Flex` (Ampere ARM, Always Free) — 1 OCPU and 6GB is
  ample; the bot idles well under 100MB. `VM.Standard.E2.1.Micro` also works.
- **SSH key:** upload your public key.

Confirm the shape is badged **Always Free eligible** before creating. If capacity
is unavailable in your home region, retry later or pick another availability
domain — a known annoyance of the free tier.

No inbound ports are needed. The bot only dials out, so leave the default
security list alone and do not open anything.

## 2. Provision

SSH in, then:

```sh
curl -fsSL https://raw.githubusercontent.com/AdrianFu0329/discord-checklist-bot/main/deploy/setup.sh | sudo bash
```

That installs Node 22, creates an unprivileged `checklistbot` user, clones the
repo to `/opt/checklist-bot`, installs dependencies from the lockfile, and
registers a systemd service. It is idempotent — re-run it to deploy updates.

It deliberately stops short of starting the bot, because credentials are still
placeholders at that point.

## 3. Credentials

```sh
sudo nano /etc/checklist-bot.env       # set DISCORD_TOKEN and CLIENT_ID
sudo systemctl start checklist-bot
```

The file is `root:checklistbot` `0640`, outside the repo, and never overwritten
by re-running setup.

## 4. Verify

```sh
journalctl -u checklist-bot -f
```

A healthy start:

```
PORT not set — no HTTP listener needed (not on Render).
[net] node v22.x.x on linux/aarch64
[net] tcp discord.com:443 -> OK in 11ms
[net] tls discord.com:443 -> OK (TLSv1.3, authorized=true)
[net] node https  GET /users/@me -> HTTP 200
[net] undici fetch GET /users/@me -> HTTP 200
[preflight] REST auth OK -> <botname> (<id>)
Logged in as <botname>#0000
[cron] Weekly checklist scheduled: Saturdays 08:00 Asia/Kuala_Lumpur
```

`HTTP 200` on both probes is the line that matters — it is the exact check that
returned 429 on Render.

## Operating it

```sh
sudo systemctl status checklist-bot
sudo systemctl restart checklist-bot
journalctl -u checklist-bot -n 200 --no-pager
journalctl -u checklist-bot -f
```

Deploy a change: push to `main`, then re-run the setup command from step 2. It
fetches, resets to `origin/main`, reinstalls dependencies and restarts.

Set `DISCORD_DEBUG=1` in `/etc/checklist-bot.env` to keep gateway debug logging
on past startup. It is otherwise silenced once the bot is ready.

## Things worth knowing

**Only ever run one instance.** Two processes on one token open two gateway
sessions and race for the same button clicks. Stop the Render service before
starting this one.

**Checklist state is in memory.** A restart drops any open checklist; buttons on
an old message then report that it expired. `Restart=always` keeps the bot up,
but does not preserve state. Move `checklistState` to SQLite if that matters.

**Cron does not catch up.** The Saturday 08:00 job only fires if the process is
alive at that moment. A VM that stays up is precisely why this host suits the job
better than a sleeping free-tier web service.

**Oracle reclaims idle Always Free instances.** Ampere instances flagged as idle
can be reclaimed. A bot holding a gateway connection generally stays above the
threshold, but keep a backup of `/etc/checklist-bot.env` so a rebuild is quick.

## Other hosts

`Dockerfile`, `fly.toml` and `render.yaml` remain in the repo as alternative
paths. Both Fly and Render free tiers NAT outbound through shared addresses, so
each carries the same 429 risk that prompted this move; a small VPS (Hetzner,
~4 EUR/mo) is the paid option with a dedicated IP.
