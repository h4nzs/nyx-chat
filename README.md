# 💬 Chat Lite

A secure, modern, and customizable real-time messaging application built with a focus on user experience and end-to-end encryption.

![App Screenshot](./web/public/hero-dark.png)

## ✨ Core Features

- **Secure Communication**: End-to-end encryption for all messages using `libsodium`.
- **Modern Neumorphic UI**: A beautiful, tactile user interface with both light and dark modes.
- **Theme Customization**: Personalize your experience by choosing your own accent color.
- **Real-Time Experience**: Instant messaging, typing indicators, and online presence status powered by WebSockets.
- **Rich Media Sharing**: 
  - Send images, videos, audio, and documents.
  - **Rich Previews**: In-app previews for PDFs, video, and audio files.
  - **Media Gallery**: Easily browse all media shared in a conversation.
- **Advanced UX**:
  - **Command Palette (`Ctrl+K`)**: Quickly navigate and execute commands like "New Group" or "Settings".
  - **Keyboard Navigation**: Navigate your chat list and close modals using only your keyboard.
- **User Onboarding**: A guided tour for new users explaining key security concepts like Recovery Phrases and Safety Numbers.
- **And More**: Message replies, emoji reactions, link previews, and robust user profiles.

## 📸 Screenshots

| Desktop | Tablet | Mobile |
| :---: | :---: | :---: |
| <img src="./web/public/normal-desktop-dark.png" alt="Desktop View" width="400"/> | <img src="./web/public/tablet-dark.png" alt="Tablet View" width="300"/> | <img src="./web/public/mobile-light.png" alt="Mobile View" width="200"/> |


## 🛠️ Tech Stack

- **Frontend**: React, Vite, TypeScript, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, Prisma, PostgreSQL, Socket.IO
- **Encryption**: `libsodium`

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+)
- pnpm (or npm/yarn)
- PostgreSQL

### 1. Setup the Backend

```bash
# Navigate to the server directory
cd server

# Install dependencies
npm install

# Create the .env file from the example
# (No example file, create it manually)
```

Create a `.env` file in the `server` directory with the following content:

```env
# PostgreSQL connection URL
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"

# JWT secret for signing tokens
JWT_SECRET="your-super-secret-jwt-key"

# Port for the server to run on
PORT=4000

# The origin URL of your frontend application
CORS_ORIGIN="http://localhost:5173"
```

Now, set up the database and run the server:

```bash
# Apply database migrations
npx prisma migrate dev

# Run the development server
npm run dev
```

### 2. Setup the Frontend

```bash
# Navigate to the web directory from the root
cd web

# Install dependencies
npm install

# Run the development server
npm run dev
```

The application will be available at `http://localhost:5173`.

### All-in-One Development

To run both frontend and backend servers concurrently, use the provided shell script from the project root:

```bash
./start-dev.sh
```

## 📁 Project Structure

```
chat-lite/
├── server/       # Backend (Node.js, Express, Prisma)
└── web/          # Frontend (React, Vite)
```

