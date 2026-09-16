# AuraDetector — production image
# Node 24 is required: the app uses the built-in `node:sqlite` module.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY . .

# Persistent-ish data dir for the SQLite database (ephemeral on free PaaS tiers)
RUN mkdir -p /data
ENV DATA_DIR=/data

# PaaS providers inject PORT; 8787 is the local default
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
