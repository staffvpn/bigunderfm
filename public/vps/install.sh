#!/bin/bash
# BIGUNDER FM broadcast server installer (Icecast + Liquidsoap + nginx/HTTPS + control bridge + TURN).
# Usage: curl -fsSL https://bigunderfm.pages.dev/vps/install.sh | bash -s -- <master-secret> <public-ip>
set -euo pipefail
MASTER="${1:?master secret missing}"
IP="${2:-$(curl -4 -fsS https://api.ipify.org)}"
HOST="${IP//./-}.sslip.io"
BASE="https://bigunderfm.pages.dev/vps"
WORKER_URL="https://bigunderfm-api.fillat0ff321.workers.dev"
R2_PUBLIC_BASE="https://pub-4940e64168824086a7fd4cf46cf01d65.r2.dev"
sec() { printf '%s' "$1:$MASTER" | sha256sum | cut -c1-32; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/8 packages"
apt-get update -qq
apt-get install -y -qq icecast2 liquidsoap nginx certbot python3-certbot-nginx coturn curl cron python3 ca-certificates >/dev/null
apt-get install -y -qq liquidsoap-plugin-all >/dev/null 2>&1 || true
liquidsoap --version | head -1

echo "== 2/8 swap"
if [ "$(swapon --show --noheadings | wc -l)" = "0" ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 3/8 files"
id radio >/dev/null 2>&1 || useradd --system --home /var/radio --shell /usr/sbin/nologin radio
mkdir -p /var/radio /etc/radio
chown -R radio:radio /var/radio
for f in radio.liq bridge.py sync-playlist.sh; do curl -fsSL "$BASE/$f" -o "/tmp/$f"; done
install -m 644 /tmp/radio.liq /etc/radio/radio.liq
install -m 755 /tmp/bridge.py /usr/local/bin/radio-bridge.py
install -m 755 /tmp/sync-playlist.sh /usr/local/bin/sync-playlist.sh
cat > /etc/radio.env <<ENV
SKIP_BRIDGE_SECRET=$(sec bridge)
LIVE_PASSWORD=$(sec live)
ICECAST_SOURCE_PASSWORD=$(sec icecast-source)
INTERNAL_SECRET=$(sec internal)
WORKER_URL=$WORKER_URL
R2_PUBLIC_BASE=$R2_PUBLIC_BASE
ENV
chown root:radio /etc/radio.env; chmod 640 /etc/radio.env

echo "== 4/8 icecast"
cat > /etc/icecast2/icecast.xml <<XML
<icecast>
  <limits><clients>800</clients><sources>2</sources><queue-size>524288</queue-size><client-timeout>30</client-timeout><header-timeout>15</header-timeout><source-timeout>10</source-timeout><burst-on-connect>1</burst-on-connect><burst-size>65535</burst-size></limits>
  <authentication><source-password>$(sec icecast-source)</source-password><relay-password>$(sec icecast-relay)</relay-password><admin-user>admin</admin-user><admin-password>$(sec icecast-admin)</admin-password></authentication>
  <hostname>$HOST</hostname>
  <listen-socket><port>8000</port><bind-address>127.0.0.1</bind-address></listen-socket>
  <fileserve>1</fileserve>
  <paths><basedir>/usr/share/icecast2</basedir><logdir>/var/log/icecast2</logdir><webroot>/usr/share/icecast2/web</webroot><adminroot>/usr/share/icecast2/admin</adminroot><alias source="/" dest="/status.xsl"/></paths>
  <logging><accesslog>access.log</accesslog><errorlog>error.log</errorlog><loglevel>2</loglevel><logsize>5000</logsize></logging>
  <security><chroot>0</chroot><changeowner><user>icecast2</user><group>icecast</group></changeowner></security>
</icecast>
XML
sed -i 's/^ENABLE=.*/ENABLE=true/' /etc/default/icecast2 2>/dev/null || true
systemctl enable --now icecast2 >/dev/null 2>&1
systemctl restart icecast2

echo "== 5/8 liquidsoap, bridge, playlist"
systemctl disable --now liquidsoap >/dev/null 2>&1 || true
cat > /etc/systemd/system/radio-liq.service <<UNIT
[Unit]
Description=BIGUNDER FM Liquidsoap
After=network-online.target icecast2.service
Wants=network-online.target
[Service]
User=radio
EnvironmentFile=/etc/radio.env
ExecStart=/usr/bin/liquidsoap /etc/radio/radio.liq
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/radio-bridge.service <<UNIT
[Unit]
Description=BIGUNDER FM control bridge
After=radio-liq.service
[Service]
User=radio
EnvironmentFile=/etc/radio.env
ExecStart=/usr/bin/python3 /usr/local/bin/radio-bridge.py
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
echo '* * * * * radio /usr/local/bin/sync-playlist.sh' > /etc/cron.d/radio-playlist
systemctl daemon-reload
/usr/local/bin/sync-playlist.sh || true
chown radio:radio /var/radio/playlist.m3u 2>/dev/null || true
systemctl enable --now radio-liq radio-bridge >/dev/null 2>&1
systemctl restart radio-liq radio-bridge

echo "== 6/8 nginx"
cat > /etc/nginx/sites-available/radio <<NGINX
server {
  listen 80;
  server_name $HOST;
  location = /status-json.xsl {
    proxy_pass http://127.0.0.1:8000;
    proxy_hide_header Access-Control-Allow-Origin;
    add_header Access-Control-Allow-Origin * always;
  }
  location /radio {
    proxy_pass http://127.0.0.1:8000/radio;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_hide_header Access-Control-Allow-Origin;
    add_header Access-Control-Allow-Origin * always;
  }
  location /skip-bridge/ {
    proxy_pass http://127.0.0.1:8001/;
    proxy_read_timeout 15s;
  }
  location /live/ {
    proxy_pass http://127.0.0.1:8005/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_buffering off;
    proxy_read_timeout 86400s;
  }
  location / { return 404; }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/radio /etc/nginx/sites-enabled/radio
nginx -t
systemctl enable --now nginx >/dev/null 2>&1
systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 3478; ufw allow 49152:49200/udp
fi
certbot --nginx -d "$HOST" --non-interactive --agree-tos --register-unsafely-without-email --redirect

echo "== 7/8 turn (calls between hosts)"
cat > /etc/turnserver.conf <<TURN
listening-port=3478
listening-ip=0.0.0.0
min-port=49152
max-port=49200
fingerprint
use-auth-secret
static-auth-secret=$(sec turn)
realm=$HOST
no-tls
no-dtls
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
TURN
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable --now coturn >/dev/null 2>&1
systemctl restart coturn || true

echo "== 8/8 checks"
sleep 12
echo "icecast:   $(curl -fsS http://127.0.0.1:8000/status-json.xsl | python3 -c 'import sys,json; s=json.load(sys.stdin)["icestats"].get("source"); print("ON AIR: "+str(s.get("title")) if s else "no source yet")' 2>&1)"
echo "bridge:    $(curl -fsS -H "Authorization: Bearer $(sec bridge)" http://127.0.0.1:8001/voice-gain 2>&1)"
echo "https:     $(curl -fsS -o /dev/null -w '%{http_code}' https://$HOST/status-json.xsl 2>&1)"
echo "r2 access: $(curl -s -o /dev/null -m 15 -w '%{http_code}' -I "$R2_PUBLIC_BASE/$(head -1 /var/radio/playlist.m3u | sed 's/.*://;s#.*/##')" 2>&1)  (200 = ok)"
echo "services:  $(systemctl is-active icecast2 radio-liq radio-bridge nginx coturn | tr '\n' ' ')"
echo
echo "ГОТОВО: https://$HOST/radio"
