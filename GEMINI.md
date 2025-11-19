# GEMINI.md

## Project Overview

This is a full-stack, real-time messaging application called "Chat Lite." It features a modern, neumorphic user interface with end-to-end encryption. The application is built with a focus on user experience, security, and customization.

**Key Technologies:**

*   **Frontend:** React, Vite, TypeScript, Zustand, Tailwind CSS
*   **Backend:** Node.js, Express, Prisma, PostgreSQL, Socket.IO
*   **Encryption:** `libsodium`

**Architecture:**

The project is structured as a monorepo with two main components:

*   `server/`: The backend application, which handles user authentication, message storage, and real-time communication.
*   `web/`: The frontend application, which provides the user interface for the chat application.

## Building and Running

### Prerequisites

*   Node.js (v18+)
*   pnpm (or npm/yarn)
*   PostgreSQL

### 1. Setup the Backend

1.  Navigate to the `server` directory:
    ```bash
    cd server
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Create a `.env` file in the `server` directory with the following content:
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
4.  Apply database migrations:
    ```bash
    npx prisma migrate dev
    ```
5.  Run the development server:
    ```bash
    npm run dev
    ```

### 2. Setup the Frontend

1.  Navigate to the `web` directory:
    ```bash
    cd web
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Run the development server:
    ```bash
    npm run dev
    ```
    The application will be available at `http://localhost:5173`.

### All-in-One Development

To run both the frontend and backend servers concurrently, use the provided shell script from the project root:

```bash
./start-dev.sh
```

## Development Conventions

*   **Code Style:** The project uses ESLint to enforce a consistent code style. You can run the linter with `npm run lint` in the `web` directory.
*   **Testing:** The project uses `vitest` for frontend testing and Node.js's built-in test runner for backend testing. You can run the tests with `npm test` in the respective `web` and `server` directories.
*   **Commits:** While not explicitly defined, it is recommended to follow conventional commit standards.

---
## Gemini Added Memories
- Always read a file's content using `read_file` to get the full context before attempting to modify it with `replace` or `write_file`. This is a strict standard operating procedure to prevent accidental code deletion.
- Prosedur Operasi Standar untuk Modifikasi Kode: Saat menggunakan tool `replace`, saya harus selalu menyediakan kode yang utuh dan lengkap untuk parameter `old_string` dan `new_string`. Saya TIDAK AKAN PERNAH menggunakan komentar placeholder seperti `// ... (unchanged)` karena praktik ini merusak file dengan menghapus kode. Ini adalah instruksi kritis untuk mencegah pengulangan kesalahan.