# Deploying Tycoon

The game is one small Node program with no dependencies. It keeps games in memory, so run **one
instance** (a restart ends games in progress).

## Option A: Docker + automatic HTTPS (recommended)

On a Linux server with Docker and a domain whose DNS **A record** points at the server
(ports **80 and 443** open in the firewall):

```bash
git clone <your-repo-url> tycoon && cd tycoon
DOMAIN=play.example.com docker compose up -d --build
```

Caddy fetches and renews the HTTPS certificate by itself. Open `https://play.example.com`.

Update later:

```bash
cd tycoon && git pull && DOMAIN=play.example.com docker compose up -d --build
```

## Option B: plain Node + systemd

```bash
sudo useradd -r tycoon && sudo mkdir -p /opt/tycoon
# copy the project to /opt/tycoon (git clone, or rsync), then:
sudo cp deploy/tycoon.service /etc/systemd/system/
sudo systemctl enable --now tycoon
```

Put any reverse proxy with HTTPS in front (Caddy, nginx, Cloudflare Tunnel). For live updates to
work through the proxy, response buffering must be off for `/api/events`
(Caddy: `flush_interval -1`, already in `deploy/Caddyfile`; nginx: `proxy_buffering off;`).

## Option C: pm2

With Node and [pm2](https://pm2.keymetrics.io) installed (no Docker or root needed):

```bash
git clone <your-repo-url> tycoon && cd tycoon
pm2 start ecosystem.config.js     # starts "tycoon" on port 3001
pm2 save                          # remember it for restarts
```

Everyday use: `pm2 status`, `pm2 logs tycoon`, `pm2 restart tycoon`, `pm2 stop tycoon`.
Update: `cd tycoon && git pull && pm2 restart tycoon` (this ends games in progress).

The config forces a single process, because games live in memory. To change the port or set
`TRUST_PROXY`, edit `ecosystem.config.js` and run `pm2 restart tycoon --update-env`.
Start on boot, three ways:
- `pm2 startup` + `pm2 save` (standard; **`pm2 save` overwrites pm2's saved list**, so only use it if
  this game is the only thing pm2 should bring back).
- `deploy/tycoon-pm2.service`: no root, starts **only** the game at boot and leaves pm2's saved list alone.
- `deploy/pm2-user.service`: no root, restores everything in pm2's saved list.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `TRUST_PROXY` | unset | Set to `1` behind your own reverse proxy so visitors' real IPs are used for rate limits. **Do not set it when the game is directly exposed**, or visitors could fake their IP. |
| `CLIENT_IP_HEADER` | unset | Header the proxy **overwrites** with the visitor's address (ArvanCloud: `ar-real-ip`). Without it, `X-Forwarded-For` is used, counting `TRUST_PROXY` hops from the right. |
| `TRUSTED_PROXY_CIDRS` | unset | Comma-separated proxy address ranges. Visitor headers are only believed when the connection comes from one of them, so nobody can fake them by calling the server directly. The ArvanCloud ranges are in `deploy/arvancloud-ips.txt` (`ecosystem.config.js` loads them). |
| `DEBUG_HEADERS` | unset | Set to `1` to log the proxy headers (and the address the game derived) on `/api/health` requests, for setting up a CDN. |
| `DATA_DIR` | `./data` | Where games are saved (`<DATA_DIR>/rooms/*.json`). Must be writable; if it isn't, saving is switched off and the server says so at startup. Back it up or keep it across deploys: it is what lets a restart keep games alive. Under Docker, mount a volume here. |
| `GAME_KEEP_HOURS` | 72 | How long a game nobody is in is kept before it is deleted. |
| `PERSIST` | on | `off` disables saving. |
| `LIMIT_CREATE` | 20 | New rooms per IP per 10 minutes |
| `LIMIT_JOIN` | 60 | Join attempts per IP per 10 minutes |
| `LIMIT_API` | 2400 | Other requests per IP per minute |
| `LIMIT_STREAMS` | 40 | Open live connections per IP |

## Checking it

`https://your-domain/api/health` returns `{"ok":true,"rooms":N}`.
