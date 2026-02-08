# Chat Lite - Comprehensive Application Summary

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Technology Stack](#technology-stack)
4. [Security Features](#security-features)
5. [Project Structure](#project-structure)
6. [Development Workflow](#development-workflow)
7. [Deployment Process](#deployment-process)
8. [Key Components](#key-components)
9. [Database Schema](#database-schema)
10. [API Endpoints](#api-endpoints)
11. [Real-time Communication](#real-time-communication)
12 [Configuration](#configuration)

## Overview

Chat Lite is a full-stack, real-time messaging application built with a strong focus on privacy and security. The application implements end-to-end encryption (E2EE) using the audited `libsodium` cryptographic library, ensuring that only the communicating parties can read messages. It features a modern, responsive Neumorphic UI with light and dark modes, and supports rich messaging capabilities including group chats, file sharing, and real-time presence indicators.

### Core Features
- **End-to-End Encryption**: All messages and files are secured using libsodium
- **Account Recovery**: 24-word recovery phrase system for account restoration
- **Device Linking**: Secure QR-based device linking without re-entering recovery phrase
- **Modern UI/UX**: Neumorphic design with theme customization and responsive layouts
- **Real-time Communication**: WebSocket-based messaging with typing indicators and read receipts
- **Rich Media Support**: Secure sharing of images, videos, documents, and rich link previews
- **Session Management**: View and manage all active sessions from settings

## Architecture

Chat Lite follows a microservice-like architecture with a clear separation between frontend and backend:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Backend       │    │   Infrastructure│
│   (React/Vite)  │◄──►│   (Node/Express)│◄──►│   (PostgreSQL,  │
│                 │    │                 │    │    Redis, S3)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Frontend Architecture
- **Framework**: React 19 with TypeScript
- **State Management**: Zustand stores for authentication, themes, conversations, and messages
- **Styling**: Tailwind CSS with custom Neumorphic design system
- **Animations**: Framer Motion for smooth transitions
- **Routing**: React Router DOM for navigation
- **WebSocket Client**: Socket.IO client for real-time communication
- **Crypto Workers**: Dedicated web workers for encryption/decryption operations

### Backend Architecture
- **Framework**: Express.js with TypeScript
- **ORM**: Prisma for database operations
- **Database**: PostgreSQL for persistent data storage
- **Cache**: Redis for online user tracking and temporary data
- **File Storage**: Local filesystem with S3 compatibility
- **WebSocket Server**: Socket.IO for real-time communication
- **Authentication**: JWT-based with refresh token rotation
- **Security**: Helmet, CORS, rate limiting, CSRF protection

## Technology Stack

### Frontend Technologies
- **Core**: React 19, TypeScript, Vite
- **State Management**: Zustand
- **Styling**: Tailwind CSS, Framer Motion
- **UI Components**: Radix UI primitives, React Icons
- **Networking**: Axios for HTTP requests, Socket.IO client
- **Crypto**: libsodium-wrappers, crypto-js
- **Utilities**: react-pdf, html5-qrcode, bip39, uuid
- **Testing**: Vitest, React Testing Library

### Backend Technologies
- **Runtime**: Node.js v18+
- **Framework**: Express.js
- **Database**: PostgreSQL, Prisma ORM
- **Cache**: Redis
- **Storage**: AWS S3 (with local fallback)
- **Crypto**: libsodium-wrappers
- **Authentication**: JWT, bcrypt, @simplewebauthn
- **Validation**: zod
- **Logging**: Morgan
- **Testing**: Jest, Supertest
- **WebSocket**: Socket.IO

### Infrastructure
- **Containerization**: Docker, Docker Compose
- **Reverse Proxy**: Nginx
- **Monitoring**: Vercel Analytics, Speed Insights
- **CDN**: Vercel Edge Network
- **CI/CD**: GitHub Actions (implied)

## Security Features

### End-to-End Encryption Model
Chat Lite implements a security model inspired by the Signal Protocol (X3DH):

1. **Key Generation**: Each device generates a Master Seed upon registration
2. **Key Derivation**: Three key pairs are deterministically created:
   - Identity Key (for encryption)
   - Signing Key (for authenticity verification)
   - Signed Pre-Key (for secure chat initiation)
3. **Secure Storage**: Private keys are encrypted with a password-derived key and stored locally
4. **Recovery Phrase**: 24-word mnemonic representing the Master Seed
5. **Session Handshake**: Cryptographic handshake establishes shared session keys

### Security Measures
- **Transport Security**: HTTPS/WSS with TLS
- **Authentication**: JWT with refresh token rotation
- **Rate Limiting**: Per-endpoint and global rate limiting
- **Input Validation**: Zod schema validation
- **XSS Protection**: Helmet.js with Content Security Policy
- **CSRF Protection**: CSRF tokens for state-changing operations
- **SQL Injection Prevention**: Prisma parameterized queries
- **File Upload Security**: MIME type validation, size limits, virus scanning

### Data Protection
- **Encryption at Rest**: Database encryption (handled by PostgreSQL)
- **Encryption in Transit**: TLS for all communications
- **Key Management**: Secure key derivation and storage
- **Session Management**: Automatic session cleanup and invalidation

## Project Structure

```
chat-lite/
├── server/                    # Backend application
│   ├── src/
│   │   ├── app.ts            # Main Express app configuration
│   │   ├── index.ts          # Server entry point
│   │   ├── socket.ts         # WebSocket server implementation
│   │   ├── config.ts         # Environment configuration
│   │   ├── types/            # TypeScript type definitions
│   │   ├── middleware/       # Custom middleware
│   │   ├── lib/              # Utility libraries (Prisma, Redis)
│   │   ├── utils/            # Helper functions
│   │   ├── routes/           # API route handlers
│   │   └── controllers/      # Business logic controllers
│   ├── prisma/               # Database schema and migrations
│   ├── uploads/              # File upload directory
│   ├── tests/                # Backend tests
│   └── Dockerfile            # Backend container definition
├── web/                      # Frontend application
│   ├── src/
│   │   ├── App.tsx           # Main application component
│   │   ├── main.tsx          # Application entry point
│   │   ├── components/       # Reusable UI components
│   │   ├── pages/            # Route components
│   │   ├── store/            # Zustand state stores
│   │   ├── hooks/            # Custom React hooks
│   │   ├── lib/              # Utility libraries
│   │   ├── types/            # TypeScript type definitions
│   │   ├── utils/            # Helper functions
│   │   └── assets/           # Static assets
│   ├── public/               # Public assets
│   ├── index.html            # HTML template
│   └── Dockerfile            # Frontend container definition
├── docker-compose.yml        # Multi-container orchestration
├── start-dev.sh              # Development startup script
├── DEPLOYMENT.md             # Deployment documentation
├── README.md                 # Project overview
└── package.json              # Root dependencies
```

## Development Workflow

### Prerequisites
- Node.js v18+
- pnpm package manager
- PostgreSQL database
- Redis server

### Setting Up Development Environment

#### Method 1: All-in-One Script
```bash
# Run both frontend and backend concurrently
./start-dev.sh
```

#### Method 2: Manual Setup
```bash
# Backend setup
cd server
pnpm install
# Create .env file with required variables
npx prisma migrate dev
pnpm run dev

# Frontend setup
cd web
pnpm install
pnpm run dev
```

### Development Commands
- `pnpm run dev`: Start development server
- `pnpm run build`: Build for production
- `pnpm run test`: Run tests
- `pnpm run lint`: Lint code
- `pnpm run format`: Format code

### Environment Variables

#### Backend (.env)
```env
# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/chatlite"

# Redis
REDIS_URL="redis://localhost:6379"

# JWT
JWT_SECRET="your-secret"
JWT_REFRESH_SECRET="your-refresh-secret"

# Server
PORT=4000
CORS_ORIGIN="http://localhost:5433"

# VAPID (for push notifications)
VAPID_SUBJECT="mailto:admin@example.com"
VAPID_PUBLIC_KEY="..."
VAPID_PRIVATE_KEY="..."

# AWS S3 (optional)
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
S3_BUCKET_NAME="..."
S3_REGION="..."
```

#### Frontend (.env)
```env
VITE_API_URL="http://localhost:4000"
VITE_WS_URL="ws://localhost:4000"
VITE_APP_SECRET="your-app-secret"
```

## Deployment Process

### Production Deployment Options

#### Option 1: Manual Deployment
1. Set up PostgreSQL and Redis servers
2. Configure environment variables
3. Build backend: `cd server && pnpm build`
4. Build frontend: `cd web && pnpm build`
5. Deploy with process manager (PM2)

#### Option 2: Docker Deployment
```bash
# Using docker-compose
docker-compose up -d
```

#### Option 3: Cloud Platforms
- Vercel (frontend)
- Render/Koyeb (backend)
- AWS/Azure/GCP (full stack)

### Nginx Configuration
Production deployments typically use Nginx as a reverse proxy:

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    # SSL configuration
    ssl_certificate /path/to/cert;
    ssl_certificate_key /path/to/key;

    # Frontend static files
    location / {
        root /path/to/frontend/build;
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket proxy
    location /socket.io/ {
        proxy_pass http://localhost:4000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## Key Components

### Frontend Components
- **Auth Store**: Manages user authentication state and tokens
- **Theme Store**: Handles theme (light/dark) and accent color preferences
- **Conversation Store**: Manages conversation list and active conversation
- **Message Store**: Handles message history and real-time updates
- **Command Palette**: Power-user feature for quick navigation
- **Crypto Workers**: Background encryption/decryption operations
- **Service Worker**: Offline support and push notifications

### Backend Components
- **Socket Manager**: Real-time communication with clients
- **Crypto Service**: Encryption/decryption operations using libsodium
- **Session Manager**: Handles session creation and key distribution
- **File Upload Handler**: Secure file upload with validation
- **Push Notification Service**: Web push notifications
- **Rate Limiter**: API rate limiting middleware
- **Authentication Middleware**: JWT verification and user context

### Security Components
- **Key Management System**: Secure key generation, storage, and distribution
- **Device Linking**: QR-based secure device authorization
- **Session Recovery**: Mechanism for recovering lost session keys
- **Account Recovery**: 24-word mnemonic-based account restoration

## Database Schema

The application uses PostgreSQL with Prisma ORM. Key entities include:

### Users
- ID, email, username, name, avatar
- Account recovery data (encrypted master key)
- Authentication tokens and sessions

### Conversations
- ID, name, type (direct/group), avatar
- Creation/modification timestamps
- Group metadata (admins, privacy settings)

### Messages
- ID, content (encrypted), sender ID
- Conversation ID, timestamps
- Message type (text, file, etc.)

### Participants
- User ID, conversation ID
- Role, join date, notification settings

### Sessions
- Session ID, user ID, device info
- Creation/expiration dates
- Session keys and encryption data

### Push Subscriptions
- Endpoint, user ID
- Encryption keys for web push

## API Endpoints

### Authentication (/api/auth)
- `POST /register` - Create new account
- `POST /login` - Authenticate user
- `POST /refresh` - Refresh access token
- `POST /logout` - End session
- `POST /verify-recovery-phrase` - Verify recovery phrase
- `POST /restore-account` - Restore account from recovery phrase

### Users (/api/users)
- `GET /me` - Get current user profile
- `PUT /me` - Update user profile
- `GET /search` - Search users by username/email
- `GET /:id` - Get user by ID

### Conversations (/api/conversations)
- `GET /` - List user conversations
- `POST /` - Create new conversation
- `GET /:id` - Get conversation details
- `PUT /:id` - Update conversation
- `DELETE /:id` - Leave/delete conversation
- `POST /:id/participants` - Add participant
- `DELETE /:id/participants/:userId` - Remove participant

### Messages (/api/messages)
- `GET /:conversationId` - Get conversation messages
- `POST /` - Send message
- `PUT /:id/read` - Mark message as read
- `DELETE /:id` - Delete message

### Keys (/api/keys)
- `GET /my-keys` - Get user's public keys
- `POST /upload-keys` - Upload new keys
- `GET /prekey-bundle/:userId` - Get prekey bundle for user

### Sessions (/api/sessions)
- `GET /` - List user sessions
- `DELETE /:id` - Revoke session
- `POST /revoke-all` - Revoke all other sessions

### Uploads (/api/uploads)
- `POST /` - Upload file
- `GET /:filename` - Download file

## Real-time Communication

### Socket.IO Events

#### Authentication Events
- `auth:request_linking_qr` - Request QR token for device linking
- `auth:linking_success` - Successful device linking with auth data

#### Conversation Events
- `conversation:join` - Join conversation room
- `typing:start` - Notify typing started
- `typing:stop` - Notify typing stopped

#### Message Events
- `message:send` - Send message to conversation
- `message:new` - Receive new message
- `message:mark_as_read` - Mark message as read
- `message:status_updated` - Message status changed

#### Key Exchange Events
- `messages:distribute_keys` - Distribute session keys
- `session:new_key` - Receive new session key
- `session:request_missing` - Request missing session key
- `session:key_requested` - Broadcast key request
- `session:request_key` - Request specific session key
- `session:fulfill_request` - Fulfill key request
- `session:fulfill_response` - Respond to key request

#### Presence Events
- `presence:init` - Initialize online users
- `presence:user_joined` - User came online
- `presence:user_left` - User went offline

#### Group Events
- `group:request_key` - Request group key
- `group:fulfill_key_request` - Fulfill group key request
- `group:fulfilled_key` - Group key fulfillment response

## Configuration

### Environment Variables

#### Server Configuration
- `NODE_ENV`: Environment mode (development/production)
- `PORT`: Server port (default: 4000)
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string
- `JWT_SECRET`: Access token signing key
- `JWT_REFRESH_SECRET`: Refresh token signing key
- `CORS_ORIGIN`: Allowed origin for CORS
- `UPLOAD_DIR`: Directory for file uploads
- `VAPID_*`: Web push notification keys

#### Client Configuration
- `VITE_API_URL`: Backend API URL
- `VITE_WS_URL`: WebSocket server URL
- `VITE_APP_SECRET`: Client-side encryption secret
- `VITE_TURNSTILE_SITE_KEY`: Cloudflare Turnstile site key

### Security Configuration
- **Helmet**: Content Security Policy, XSS protection, HSTS
- **Rate Limiting**: Per-endpoint and global limits
- **CSRF Protection**: Token-based form validation
- **Input Validation**: Zod schema validation on all inputs
- **File Upload Limits**: Size and type restrictions

### Performance Configuration
- **Connection Pooling**: Database connection pooling
- **Caching**: Redis for frequently accessed data
- **Compression**: Gzip compression for responses
- **Static Asset Optimization**: Image compression and caching
- **WebSocket Configuration**: Optimized ping/pong intervals

### Monitoring Configuration
- **Logging**: Morgan for HTTP request logging
- **Analytics**: Vercel Analytics integration
- **Performance**: Vercel Speed Insights
- **Error Tracking**: Console logging with structured format