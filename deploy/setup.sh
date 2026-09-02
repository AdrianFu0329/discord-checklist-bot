#!/usr/bin/env bash
# Provision the checklist bot on a fresh Ubuntu VM (Oracle Cloud Always Free,
# or any other host with a dedicated outbound IP).
#
#   curl -fsSL https://raw.githubusercontent.com/AdrianFu0329/discord-checklist-bot/main/deploy/setup.sh | sudo bash
#
# Idempotent: safe to re-run. Re-running updates the code and restarts.

set -euo pipefail

REPO="https://github.com/AdrianFu0329/discord-checklist-bot.git"
APP_DIR="/opt/checklist-bot"
ENV_FILE="/etc/checklist-bot.env"
SERVICE_USER="checklistbot"
NODE_MAJOR=22

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

echo "==> Installing prerequisites"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates

# Node 22 LTS. Pinned deliberately: discord.js 14.27 bundles undici 6.x, which
# breaks on a bleeding-edge runtime. Distro packages lag too far behind.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  echo "==> Installing Node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v) on $(uname -m)"

# A dedicated unprivileged account: no login shell, no home directory to own.
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> Creating service user ${SERVICE_USER}"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "==> Fetching source into ${APP_DIR}"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --quiet origin main
  git -C "$APP_DIR" reset --quiet --hard origin/main
else
  git clone --quiet "$REPO" "$APP_DIR"
fi

echo "==> Installing dependencies"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# Written once with placeholders, then never overwritten — re-running this
# script must not clobber real credentials.
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating ${ENV_FILE} (placeholders)"
  cat > "$ENV_FILE" <<'ENVEOF'
DISCORD_TOKEN=replace-me
CLIENT_ID=replace-me
ENVEOF
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

echo "==> Installing systemd unit"
install -m 644 "$APP_DIR/deploy/checklist-bot.service" /etc/systemd/system/checklist-bot.service
systemctl daemon-reload
systemctl enable --quiet checklist-bot

if grep -q 'replace-me' "$ENV_FILE"; then
  cat <<EOM

==> Almost done. Credentials are still placeholders, so the bot was NOT started.

    sudo nano ${ENV_FILE}        # set DISCORD_TOKEN and CLIENT_ID
    sudo systemctl start checklist-bot
    journalctl -u checklist-bot -f

EOM
else
  echo "==> Restarting service"
  systemctl restart checklist-bot
  echo "    journalctl -u checklist-bot -f"
fi
