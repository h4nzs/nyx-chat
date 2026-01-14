# --- Stage 1: Build React ---
FROM node:20-alpine AS builder

RUN corepack enable
WORKDIR /app

# Copy dependency files
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build React untuk production
# Pastikan env variable VITE_API_URL mengarah ke relative path untuk proxy
ENV VITE_API_URL=/api 
RUN pnpm build

# --- Stage 2: Serve with Nginx ---
FROM nginx:alpine

# Copy hasil build React ke folder Nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy konfigurasi Nginx custom kita
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
