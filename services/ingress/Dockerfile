# ── Build & Run: EGAP Ingress Gateway ─────────────────────────────────
FROM node:20-slim

WORKDIR /app

# 1. Install production dependencies only
COPY package*.json ./
RUN npm install

# 2. Copy source and TypeScript config
COPY tsconfig.json ./
COPY src/ ./src/

# 3. Compile TypeScript → JavaScript
RUN npx tsc

# 4. Cloud Run injects PORT=8080 by default
EXPOSE 8080

# 5. Start the compiled server
CMD ["node", "dist/index.js"]
