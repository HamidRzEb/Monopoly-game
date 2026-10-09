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

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `TRUST_PROXY` | unset | Set to `1` behind your own reverse proxy so visitors' real IPs are used for rate limits. **Do not set it when the game is directly exposed**, or visitors could fake their IP. |
| `LIMIT_CREATE` | 20 | New rooms per IP per 10 minutes |
| `LIMIT_JOIN` | 60 | Join attempts per IP per 10 minutes |
| `LIMIT_API` | 2400 | Other requests per IP per minute |
| `LIMIT_STREAMS` | 40 | Open live connections per IP |

## Checking it

`https://your-domain/api/health` returns `{"ok":true,"rooms":N}`.
