# Coolify-ready image for the FlowManager license server (no dependencies, plain Node).
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Hanya kode + dashboard statis. licenses.json SENGAJA tidak di-copy:
# database dibuat saat runtime di volume persisten (lihat README).
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data

ENV LICENSES_FILE=/app/data/licenses.json
ENV PLANS_FILE=/app/data/plans.json
ENV PORT=8787

# Sengaja jalan sebagai root: volume persisten milik host (root) sehingga
# user non-root akan EACCES saat menulis licenses.json/plans.json -> crash.
# Service ini single-purpose di balik HTTPS; risikonya minimal dan
# didokumentasikan di sini.
# USER node
EXPOSE 8787

# dipakai Coolify sebagai health check (GET / -> {ok:true}).
# WAJIB pakai $PORT (Coolify menyuntik PORT sendiri, mis. 3000) — jangan hardcode!
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8787}/ || exit 1

CMD ["node", "server.js"]
