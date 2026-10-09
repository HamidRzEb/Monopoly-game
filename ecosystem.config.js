const fs = require('fs');
// Arvan's edge ranges (deploy/arvancloud-ips.txt); their headers are only trusted from these.
const arvanRanges = fs.readFileSync(__dirname + '/deploy/arvancloud-ips.txt', 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join(',');

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
      PORT: 3001, // 3000 is used by another app on the home server
      // Behind ArvanCloud: take the visitor's address from the header Arvan overwrites, and only
      // believe it when the connection comes from one of Arvan's ranges (see DEPLOY.md).
      TRUST_PROXY: '1',
      CLIENT_IP_HEADER: 'ar-real-ip',
      TRUSTED_PROXY_CIDRS: arvanRanges,
    },
  }],
};
