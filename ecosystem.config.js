// pm2 process file:  pm2 start ecosystem.config.js   (then: pm2 save)
module.exports = {
  apps: [{
    name: 'tycoon',
    script: 'server.js',
    // Games live in this process's memory, so there must be exactly ONE instance (no cluster mode).
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: 20,
    min_uptime: '10s',
    restart_delay: 2000,
    max_memory_restart: '400M',
    kill_timeout: 5000,
    time: true, // timestamp log lines
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      // Set TRUST_PROXY: '1' when a reverse proxy (nginx, Caddy, Cloudflare tunnel) sits in front,
      // so visitors' real IPs are used for the rate limits. Never set it when directly exposed.
    },
  }],
};
