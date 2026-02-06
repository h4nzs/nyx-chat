# 💬 Chat Lite

A secure, modern, and customizable real-time messaging application built with a focus on user experience and end-to-end encryption.

![App Screenshot](./screenshots/hero-dark.png)

## 📸 Screenshots

| Desktop | Tablet | Mobile |
| :---: | :---: | :---: |
| <img src="./web/public/normal-desktop-dark.png" alt="Desktop View" width="400"/> | <img src="./web/public/tablet-dark.png" alt="Tablet View" width="300"/> | <img src="./web/public/mobile-light.png" alt="Mobile View" width="200"/> |

## About The Project

Chat Lite is a full-stack messaging application designed for users who prioritize privacy and a clean, modern user interface. At its core, it provides a robust end-to-end encryption (E2EE) system, ensuring that your conversations remain private and secure. No one outside of your conversation—not even the server—can read your messages.

Built with a modern tech stack, Chat Lite offers a seamless real-time experience across devices, wrapped in a beautiful, tactile Neumorphic UI that is both visually appealing and highly functional.

## ✨ Core Features

### 🛡️ Security & Privacy First

- **End-to-End Encryption**: All messages and files are secured using the audited `libsodium` cryptographic library. Communications are encrypted on your device and can only be decrypted by the recipient.
- **Account Restore via Recovery Phrase**: A 24-word recovery phrase, generated from your unique master key, is the only way to access your account on a new device, ensuring you—and only you—have control.
- **Device Linking**: Securely link a new device using a QR code without needing to re-enter your recovery phrase.
- **Session Management**: View and manage all your active sessions from the settings page.

### 🎨 Modern User Experience

- **Neumorphic UI**: A beautiful, tactile user interface with meticulously crafted light and dark modes.
- **Theme Customization**: Personalize your experience by choosing your own accent color from a predefined palette.
- **Command Palette (`Ctrl+K`)**: A power-user feature to quickly navigate the app and execute commands like "New Group" or "Settings".
- **Advanced Keyboard Navigation**: Navigate your chat list with arrow keys, open chats with Enter, and close any modal with the Escape key.
- **Responsive & Adaptive Layout**: Features a unique three-column "Command Center" layout for ultrawide screens and a hybrid experience for tablets that adapts to orientation.

### 💬 Rich Messaging Features

- **Real-Time Communication**: Instant messaging, typing indicators, read receipts, and online presence status powered by WebSockets.
- **Group Chats**: Easily create and manage group conversations.
- **Rich Media & File Sharing**: Securely send images, videos, audio, and documents, all end-to-end encrypted.
- **In-Chat Previews**: Get rich link previews for URLs and in-app previews for PDFs, videos, and audio files.
- **And More**: Message replies, emoji reactions, and a gallery to view all media shared in a conversation.

## 🔐 How It Works: The Security Model

Chat Lite's E2EE is built on established cryptographic principles to ensure no one can intercept your messages.

1.  **Key Generation**: When you register, your device generates a **Master Seed**. From this seed, three distinct key pairs are deterministically created: an **Identity Key** (for encryption), a **Signing Key** (for verifying authenticity), and a **Signed Pre-Key** (for initiating secure chats).
2.  **Secure Storage**: Your private keys never leave your device. They are encrypted with a key derived from your password and stored securely in your browser's local storage.
3.  **Recovery Phrase**: Your 24-word recovery phrase is a representation of your Master Seed. It is the only way to regenerate your keys on a new device. **If you lose your password AND your recovery phrase, your account is irrecoverable.**
4.  **Secure Session Handshake**: When you start a conversation with someone for the first time, your app fetches their "pre-key bundle" from the server. Using an approach inspired by the **Signal Protocol (X3DH)**, your devices perform a cryptographic handshake to establish a shared session key. This process happens securely even if the recipient is offline.

## 🚀 Getting Started

<details>
<summary>Click to expand setup instructions</summary>

### Prerequisites

- Node.js (v18+)
- pnpm (or npm/yarn)
- PostgreSQL

### 1. Setup the Backend

```bash
# Navigate to the server directory
cd server

# Install dependencies
pnpm install
```

Create a `.env` file in the `server` directory with the following content, replacing the placeholder values:

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
pnpm run dev
```

### 2. Setup the Frontend

```bash
# Navigate to the web directory from the root
cd web

# Install dependencies
pnpm install

# Run the development server
pnpm run dev
```

The application will be available at `http://localhost:5173`.

### All-in-One Development

To run both frontend and backend servers concurrently, use the provided shell script from the project root:

```bash
./start-dev.sh
```

</details>

## 🛠️ Tech Stack

- **Frontend**: React, Vite, TypeScript, Zustand, Tailwind CSS, Framer Motion
- **Backend**: Node.js, Express, Prisma, PostgreSQL, Socket.IO
- **Encryption**: `libsodium-wrappers`

## 🤝 Contributing

Contributions are what make the open-source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.

## 📁 Project Structure

```
chat-lite/
├── server/       # Backend (Node.js, Express, Prisma)
└── web/          # Frontend (React, Vite)
```
