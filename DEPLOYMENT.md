# NYX Deployment Guide (Updated)

Panduan ini berisi instruksi untuk men-deploy aplikasi NYX ke lingkungan produksi.

## 📋 Prerequisites

- Node.js (v18 atau lebih baru)
- pnpm (atau npm/yarn)
- PostgreSQL (v12 atau lebih baru)
- **Redis** (v6 atau lebih baru)
- Git

## 🗄️ Initial Setup

### 1. PostgreSQL & Redis Installation

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install postgresql postgresql-contrib redis-server

# macOS (with Homebrew)
brew install postgresql redis

# Start services (jika belum berjalan otomatis)
sudo systemctl start postgresql redis-server
```

### 2. Database Creation

```bash
# Buka shell psql
sudo -u postgres psql

# Buat database dan user
CREATE DATABASE nyxdb;
CREATE USER nyx_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE nyxdb TO nyx_user;

# Keluar dari psql
\q
```

### 3. Environment Configuration

Buat file `.env` di direktori `server/`.

**`server/.env`:**
```env
# Pastikan ini diatur ke 'production'
NODE_ENV=production

# URL untuk koneksi ke database PostgreSQL Anda
DATABASE_URL="postgresql://nyx_user:your_secure_password@localhost:5432/nyxdb?schema=public"

# URL untuk koneksi ke server Redis Anda
REDIS_URL="redis://localhost:6379"

# Secret untuk menandatangani token JWT (gunakan string acak yang kuat)
JWT_SECRET="ganti_dengan_jwt_secret_yang_sangat_aman"
JWT_REFRESH_SECRET="ganti_dengan_jwt_refresh_secret_yang_sangat_aman"

# Port untuk server backend
PORT=4000

# Domain frontend Anda (tanpa trailing slash)
CORS_ORIGIN="https://yourdomain.com"

# Direktori untuk file upload
UPLOAD_DIR="uploads"

# Kunci VAPID untuk Notifikasi Push (generate sekali, misal dengan `npx web-push generate-vapid-keys`)
VAPID_SUBJECT="mailto:admin@yourdomain.com"
VAPID_PUBLIC_KEY="your_vapid_public_key"
VAPID_PRIVATE_KEY="your_vapid_private_key"
```

Buat file `.env.production` di direktori `web/`.

**`web/.env.production`:**
```env
# URL ini harus menunjuk ke domain publik Anda, Nginx akan menangani proxy
VITE_API_URL="https://yourdomain.com"
VITE_WS_URL="https://yourdomain.com"
```

## 🚀 Backend Deployment

```bash
# Masuk ke direktori server
cd server

# Install dependencies
pnpm install --production

# Jalankan migrasi database untuk produksi
pnpm prisma migrate deploy

# Generate Prisma client
pnpm prisma generate

# Build aplikasi TypeScript
pnpm build

# Mulai server menggunakan process manager seperti PM2
pm2 start dist/index.js --name nyx-backend
```

## 🌐 Frontend Deployment

```bash
# Masuk ke direktori web
cd web

# Install dependencies
pnpm install

# Build aplikasi untuk produksi
pnpm build
```
Output build akan ada di direktori `web/dist/`. Direktori ini yang akan di-serve oleh Nginx.

## ⚙️ Nginx Configuration (Reverse Proxy)

Contoh konfigurasi Nginx untuk produksi. Simpan di `/etc/nginx/sites-available/yourdomain.com`.

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    
    # Redirect semua HTTP ke HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;
    
    # Konfigurasi SSL (misal dengan Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    # Security Headers (beberapa sekarang ditangani oleh aplikasi)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    # CATATAN: Content-Security-Policy (CSP) sekarang diatur oleh backend (via Helmet)
    # untuk kebijakan yang lebih dinamis. Jangan atur di sini untuk menghindari konflik.
    
    # Lokasi root untuk file frontend
    location / {
        root /path/to/nyx/web/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
    
    # Proxy untuk semua rute API
    location /api/ {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # Proxy untuk koneksi WebSocket
    location /socket.io/ {
        proxy_pass http://localhost:4000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
    
    # Proxy untuk file upload
    location /uploads/ {
        proxy_pass http://localhost:4000/uploads/;
        proxy_set_header Host $host;
    }
}
```

## 🔧 Penyesuaian Kode untuk Produksi

Satu perubahan manual diperlukan di kode sebelum build backend untuk produksi.

- **Lokasi:** `server/src/app.ts`
- **Tugas:** Di dalam konfigurasi `helmet`, temukan baris `connectSrc` dan ganti URL WebSocket.

  ```typescript
  // Ganti baris ini:
  connectSrc: ["'self'", "ws://localhost:4000"],

  // Menjadi (sesuaikan dengan domain Anda):
  connectSrc: ["'self'", "wss://yourdomain.com"],
  ```

## 🐳 Docker Deployment (Optional & Updated)

### `server/Dockerfile`
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

COPY package*.json ./
COPY prisma ./prisma/

RUN pnpm install --production

COPY . .

RUN pnpm prisma generate
RUN pnpm build

EXPOSE 4000

CMD ["node", "dist/index.js"]
```

### `web/Dockerfile`
```dockerfile
FROM node:18-alpine as build

WORKDIR /app

RUN npm install -g pnpm

COPY package*.json ./

RUN pnpm install

COPY . .

RUN pnpm build

# Production stage
FROM nginx:alpine

# Copy Nginx config
# Pastikan Anda memiliki file nginx.conf yang sesuai untuk Docker
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

### `docker-compose.yml`
```yaml
version: '3.8'

services:
  db:
    image: postgres:14
    environment:
      POSTGRES_DB: nyxdb
      POSTGRES_USER: nyx_user
      POSTGRES_PASSWORD: your_secure_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped

  backend:
    build: ./server
    environment:
      NODE_ENV: production
      DATABASE_URL: "postgresql://nyx_user:your_secure_password@db:5432/nyxdb?schema=public"
      REDIS_URL: "redis://redis:6379"
      JWT_SECRET: "your_jwt_secret_here"
      JWT_REFRESH_SECRET: "your_jwt_refresh_secret_here"
      PORT: 4000
      CORS_ORIGIN: "https://yourdomain.com"
      VAPID_SUBJECT: "mailto:admin@yourdomain.com"
      VAPID_PUBLIC_KEY: "your_vapid_public_key"
      VAPID_PRIVATE_KEY: "your_vapid_private_key"
    ports:
      - "4000:4000"
    depends_on:
      - db
      - redis
    restart: unless-stopped

  frontend:
    build: ./web
    ports:
      - "80:80"
      - "443:443"
    # Anda perlu menangani SSL di dalam container Nginx ini atau di proxy terluar
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  postgres_data:
```
