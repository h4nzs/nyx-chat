# NYX - Project Context

## Project Overview

NYX is a secure, modern, and customizable real-time messaging application built with a focus on user experience and end-to-end encryption. It's a full-stack application designed for users who prioritize privacy and a clean, modern user interface. At its core, it provides a robust end-to-end encryption (E2EE) system, ensuring that conversations remain private and secure.

### Key Features
- **End-to-End Encryption**: All messages and files are secured using the audited `libsodium` cryptographic library
- **Modern UI**: Beautiful Neumorphic UI with light and dark modes
- **Real-time Communication**: Powered by WebSockets with typing indicators, read receipts, and online presence
- **Responsive Design**: Adapts to desktop, tablet, and mobile devices
- **Rich Media Support**: Secure file sharing with previews for various media types
- **Account Recovery**: Via 24-word recovery phrase
- **Device Linking**: Securely link new devices using QR codes

### Technology Stack
- **Frontend**: React, Vite, TypeScript, Zustand, Tailwind CSS, Framer Motion
- **Backend**: Node.js, Express, Prisma, PostgreSQL, Socket.IO
- **Encryption**: `libsodium-wrappers`
- **Additional**: Redis for caching, JWT for authentication

## Project Structure

```
nyx/
├── server/           # Backend (Node.js, Express, Prisma)
│   ├── src/          # Source code
│   ├── prisma/       # Database schema and migrations
│   ├── tests/        # Test files
│   └── package.json
├── web/              # Frontend (React, Vite)
│   ├── src/          # Source code
│   ├── public/       # Static assets
│   └── package.json
├── docker-compose.yml # Docker orchestration
├── start-dev.sh      # Development startup script
└── README.md
```

## Building and Running

### Prerequisites
- Node.js (v18+)
- pnpm (or npm/yarn)
- PostgreSQL
- Redis

### Quick Start (Development)
To run both frontend and backend servers concurrently:
```bash
./start-dev.sh
```

### Manual Setup

#### Backend (Server)
```bash
cd server
pnpm install

# Create .env file with:
# DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"
# JWT_SECRET="your-super-secret-jwt-key"
# PORT=4000
# CORS_ORIGIN="http://localhost:5173"

npx prisma migrate dev
pnpm run dev
```

#### Frontend (Web)
```bash
cd web
pnpm install
pnpm run dev
```

The application will be available at `http://localhost:5173`.

### Key Commands
- `pnpm run dev`: Starts the development server
- `pnpm run build`: Builds the application for production
- `pnpm run test`: Runs the tests
- `npx prisma migrate dev`: Applies database migrations
- `pnpm run seed`: Seeds the database with initial data (in server directory)

## Architecture

### Backend Architecture
- **Express.js** server with middleware for security (Helmet, CORS, rate limiting)
- **Prisma** ORM for PostgreSQL database interactions
- **Socket.IO** for real-time WebSocket communication
- **Redis** for caching and session management
- **libsodium** for end-to-end encryption
- Modular routing with separate modules for auth, users, conversations, messages, etc.

### Frontend Architecture
- **React** with TypeScript for type safety
- **Zustand** for state management
- **Tailwind CSS** for styling with custom Neumorphic design
- **Socket.IO Client** for real-time communication
- Component-based architecture with organized folder structure

## Security Features
- End-to-end encryption using libsodium
- Account recovery via 24-word recovery phrase
- Device linking with QR codes
- Session management
- CSRF protection
- JWT-based authentication with refresh tokens
- Input validation and sanitization

## Deployment
The application supports both traditional deployment and Docker-based deployment. The `docker-compose.yml` file orchestrates PostgreSQL, Redis, backend, and frontend services.

For production deployment, refer to `DEPLOYMENT.md` which includes:
- Environment configuration
- Nginx reverse proxy setup
- SSL certificate configuration
- Process management with PM2

## Development Conventions
- TypeScript is used throughout for type safety
- ESLint and Prettier for code formatting and linting
- Component organization follows feature-based grouping
- State management is centralized with Zustand stores
- API calls are abstracted through custom hooks and service layers
- Security best practices are implemented at both frontend and backend

## Testing
- Frontend: vitest with jsdom environment
- Backend: supertest for API testing
- Both use Jest-style testing frameworks
- Unit and integration tests are supported

## Key Files and Directories
- `start-dev.sh`: Script to run both frontend and backend simultaneously
- `docker-compose.yml`: Container orchestration configuration
- `server/src/index.ts`: Main backend entry point
- `web/src/main.tsx`: Main frontend entry point
- `server/src/app.ts`: Express application configuration
- `web/src/App.tsx`: Main React application component
- `server/prisma/schema.prisma`: Database schema definition