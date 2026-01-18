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

# Generate Prisma Client (Membuat folder node_modules/.prisma)
RUN npx prisma generate

# Build TypeScript code
RUN pnpm build

# --- Stage 2: Production Runner ---
FROM node:20-alpine AS runner

WORKDIR /app

# Install pnpm & dependencies sistem
RUN corepack enable && apk add --no-cache openssl

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install hanya dependencies production
RUN pnpm install --prod --frozen-lockfile

# --- FIX 1: Copy Generated Prisma Client ---
# Kita wajib mengambil hasil generate dari stage builder
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Copy hasil build kode & schema
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# --- FIX 2: Set Port ke 8000 ---
# Memaksa aplikasi berjalan di port 8000 agar cocok dengan default Koyeb
ENV PORT=8000
EXPOSE 8000

# Command start
CMD ["node", "dist/index.js"]