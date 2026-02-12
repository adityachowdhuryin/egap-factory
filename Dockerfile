# Single-stage build - run source directly with ts-node
FROM node:18-slim

# Install system dependencies for Prisma
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install ts-node and typescript globally
RUN npm install -g ts-node typescript

WORKDIR /app

# Copy all project files
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY prisma/ ./prisma/
COPY src/ ./src/
COPY client/ ./client/

# Install backend dependencies
RUN npm install

# Build frontend
RUN cd client && npm install && npm run build

# Generate Prisma client
RUN npx prisma generate

# Expose port 8080 for Cloud Run
EXPOSE 8080

ENV NODE_ENV=production

# Run source directly with ts-node (no compilation path issues)
CMD ["ts-node", "src/index.ts"]
