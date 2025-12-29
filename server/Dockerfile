# --- Stage 1: Build ---
FROM node:20-alpine AS builder

# Install pnpm & dependencies sistem untuk Prisma
RUN corepack enable && apk add --no-cache openssl

WORKDIR /app

# Copy dependency files
COPY package.json pnpm-lock.yaml ./

# Install dependencies (termasuk devDependencies untuk build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript code (hasilnya masuk ke folder dist/)
RUN pnpm build

# --- Stage 2: Production Runner ---
FROM node:20-alpine AS runner

WORKDIR /app

# Install pnpm & dependencies sistem
RUN corepack enable && apk add --no-cache openssl

# Copy hanya file package yang dibutuhkan
COPY package.json pnpm-lock.yaml ./

# Install hanya dependencies production (hemat size)
RUN pnpm install --prod --frozen-lockfile

# Copy hasil build dari Stage 1
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Expose port
EXPOSE 4000

# Command untuk menjalankan server
CMD ["node", "dist/src/index.js"]
