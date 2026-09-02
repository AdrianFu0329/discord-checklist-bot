# Pinned to the Node 22 LTS line. discord.js 14.27 bundles undici 6.x, which
# does not tolerate a bleeding-edge runtime — letting a host resolve "latest"
# is what put this bot on Node 26 and broke its HTTPS stack.
FROM node:22.11.0-slim

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of source.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Run unprivileged; the node image ships a suitable user already.
USER node

CMD ["node", "index.js"]
