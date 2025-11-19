# Chat Lite - Project Context

## Project Overview

Chat Lite is a secure, modern, and customizable real-time messaging application built with a focus on user experience and end-to-end encryption. The application features a neumorphic UI design with both light and dark modes, and provides rich communication capabilities including secure messaging, media sharing, and real-time presence indicators.

### Key Features
- Secure communication with end-to-end encryption using `libsodium`
- Modern neumorphic UI with light/dark mode and theme customization
- Real-time experience with WebSockets for instant messaging
- Rich media sharing with in-app previews for various file types
- Advanced UX features like command palette (Ctrl+K) and keyboard navigation
- User onboarding with security concept explanations

### Tech Stack
- **Frontend**: React, Vite, TypeScript, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, Prisma, PostgreSQL, Socket.IO
- **Other**: Redis for caching, WebSockets for real-time communication, libsodium for encryption

## Project Structure
```
chat-lite/
├── server/       # Backend (Node.js, Express, Prisma)
├── web/          # Frontend (React, Vite)
├── README.md     # Main project documentation
├── DEPLOYMENT.md # Deployment guide
├── start-dev.sh  # Development startup script
└── ... (other documentation files)
```

### Server Directory
The backend is built with Node.js and Express, using Prisma ORM for PostgreSQL database interactions. It includes WebSocket support for real-time communication and implements end-to-end encryption.

Key technologies:
- TypeScript
- Express.js
- Prisma ORM
- PostgreSQL
- Socket.IO
- libsodium (encryption)

### Web Directory
The frontend is a React application built with Vite, featuring a modern UI with neumorphic design principles. It uses Zustand for state management and Tailwind CSS for styling.

Key technologies:
- React 19+
- TypeScript
- Zustand (state management)
- Tailwind CSS
- Socket.IO client
- libsodium (encryption)

## Building and Running

### Prerequisites
- Node.js (v18+)
- pnpm (or npm/yarn)
- PostgreSQL
- Redis (for production)

### Development Setup

#### Backend
```bash
cd server
npm install
# Create .env file with proper configuration
npx prisma migrate dev
npm run dev
```

#### Frontend
```bash
cd web
npm install
npm run dev
```

#### All-in-One Development
To run both frontend and backend concurrently:
```bash
./start-dev.sh
```

### Environment Configuration

#### Server Environment Variables (.env)
```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"
JWT_SECRET="your-super-secret-jwt-key"
JWT_REFRESH_SECRET="your-refresh-jwt-key"
PORT=4000
CORS_ORIGIN="http://localhost:5173" (or your frontend URL)
REDIS_URL="redis://localhost:6379"
VAPID_SUBJECT="mailto:admin@yourdomain.com"
VAPID_PUBLIC_KEY="your_vapid_public_key"
VAPID_PRIVATE_KEY="your_vapid_private_key"
```

#### Frontend Environment Variables (.env.production)
```env
VITE_API_URL="https://yourdomain.com"
VITE_WS_URL="https://yourdomain.com"
```

## Development Conventions

### Architecture Patterns
- **State Management**: Zustand is used for global state management in the frontend
- **Real-time Communication**: Socket.IO is used for WebSockets
- **Security**: End-to-end encryption using libsodium
- **API Design**: RESTful API with JWT authentication

### Code Organization
- **Frontend**: Components, pages, store (Zustand), hooks, utils, lib
- **Backend**: Routes, controllers, models (Prisma), middleware, utils, socket handlers

### Testing
- Backend tests are located in the `server/tests` directory
- Frontend tests can be run with Vitest
- The project includes test configuration files (jest.config.js for backend)

## Deployment

### Production Prerequisites
- PostgreSQL (v12+)
- Redis (v6+)
- Nginx (as reverse proxy)
- SSL certificate (e.g., Let's Encrypt)

### Production Setup
1. Set up PostgreSQL and Redis services
2. Configure environment files for production
3. Build both frontend and backend
4. Set up Nginx reverse proxy configuration
5. Use a process manager like PM2 for the backend

The project includes detailed deployment instructions in `DEPLOYMENT.md` with Nginx configuration examples and Docker setup options.

## Key Files and Documentation
- `README.md`: Main project overview and getting started guide
- `DEPLOYMENT.md`: Complete production deployment instructions
- `src.md`: Development recommendations and future feature suggestions
- `start-dev.sh`: Script for running both frontend and backend during development
- Package.json files in both server and web directories for dependency management