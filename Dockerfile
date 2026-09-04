# Bypasses Railway/Nixpacks' apt-install step, which currently fails with
# "secret ID missing" when auto-installing libatomic1 (a system dependency
# of @libsql/client). Installing it here via a plain `apt-get` in a normal
# Dockerfile sidesteps that broken build path entirely.

FROM node:20-slim

# libatomic1 is required by @libsql/client's native bindings.
RUN apt-get update && \
    apt-get install -y --no-install-recommends libatomic1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching on rebuilds)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
