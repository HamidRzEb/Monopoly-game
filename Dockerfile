FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html ./
COPY js ./js
COPY css ./css
COPY assets ./assets
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
