#!/usr/bin/env bash
# Healthy Fit — установка на чистый Ubuntu 22.04/24.04 (Timeweb, Selectel и т.п.).
# Запуск в консоли сервера под root:
#   curl -fsSL https://raw.githubusercontent.com/ghohgujn/healthy/main/deploy/install.sh | bash
# Скрипт спросит ключ ProxyAPI (вводится скрыто, хранится только в /etc/healthy.env).
set -euo pipefail

REPO="${REPO:-https://github.com/ghohgujn/healthy.git}"
APP=/opt/healthy
ENVF=/etc/healthy.env

[ "$(id -u)" = 0 ] || { echo "Запустите под root (sudo -i)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Пакеты"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates caddy ufw >/dev/null
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "==> Код"
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q; else git clone -q --depth 1 "$REPO" "$APP"; fi
id healthy >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin healthy
chown -R healthy:healthy "$APP"

echo "==> Ключ ProxyAPI"
if ! grep -q '^PROXYAPI_KEY=sk-' "$ENVF" 2>/dev/null; then
  read -r -s -p "Вставьте ключ ProxyAPI (sk-...) и нажмите Enter: " KEY </dev/tty; echo
  case "$KEY" in sk-*) ;; *) echo "Ключ должен начинаться с sk-"; exit 1;; esac
  umask 077; printf 'PROXYAPI_KEY=%s\nPORT=3000\nRATE_LIMIT=30\nAPP_TZ=%s\n' "$KEY" "${APP_TZ:-Asia/Vladivostok}" > "$ENVF"
fi
chmod 600 "$ENVF"

echo "==> Сервис"
cat > /etc/systemd/system/healthy.service <<UNIT
[Unit]
Description=Healthy Fit
After=network-online.target
[Service]
User=healthy
WorkingDirectory=$APP
EnvironmentFile=$ENVF
Environment=DATA_DIR=/var/lib/healthy
StateDirectory=healthy
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning $APP/server/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadOnlyPaths=$APP
ReadWritePaths=/var/lib/healthy
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now healthy
systemctl restart healthy

echo "==> HTTPS"
IP=$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')
HOST="${HOST:-${IP//./-}.sslip.io}"
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
  encode gzip
  request_body { max_size 30MB }
  reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

echo "==> Бэкап базы каждую ночь (7 последних копий)"
cat > /etc/cron.d/healthy-backup <<'BK'
30 3 * * * root mkdir -p /var/backups/healthy && tar czf /var/backups/healthy/data-$(date +\%u).tgz -C /var/lib healthy
BK

echo "==> Автообновление из GitHub каждые 2 минуты"
cat > /usr/local/bin/healthy-update <<'UPD'
#!/usr/bin/env bash
cd /opt/healthy || exit 0
OLD=$(git rev-parse HEAD)
sudo -u healthy git fetch -q origin main && sudo -u healthy git reset -q --hard origin/main
[ "$OLD" != "$(git rev-parse HEAD)" ] && systemctl restart healthy && echo "updated $(date)"
UPD
chmod +x /usr/local/bin/healthy-update
echo '*/2 * * * * root /usr/local/bin/healthy-update >> /var/log/healthy-update.log 2>&1' > /etc/cron.d/healthy-update
git config --system --add safe.directory "$APP"

sleep 3
curl -fsS http://127.0.0.1:3000/healthz && echo
echo
echo "Готово. Откройте на телефоне:  https://$HOST"
echo "(первый заход может занять ~30 сек, пока выпускается сертификат)"
