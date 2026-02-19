# GEMINI.md

## Project Overview

This project is a full-stack, real-time messaging application called NYX. It prioritizes security with end-to-end encryption (E2EE) and features a modern, responsive user interface.

*   **Frontend:** The frontend is a single-page application built with **React** and **Vite**. It uses **TypeScript** for static typing, **Zustand** for state management, and **Tailwind CSS** for styling. The UI is a custom Neumorphic design with light and dark modes.
*   **Backend:** The backend is a **Node.js** server using the **Express.js** framework. It uses **Prisma** as a database ORM to interact with a **PostgreSQL** database. Real-time communication is handled with **Socket.IO**.
*   **Security:** End-to-end encryption is implemented using the `libsodium-wrappers` library. The authentication system is based on the Signal Protocol (X3DH) for secure key exchange.

## Building and Running

### Prerequisites

*   Node.js (v18+)
*   pnpm (or npm/yarn)
*   PostgreSQL

### All-in-One Development

To run both the frontend and backend servers concurrently, use the provided shell script from the project root:

```bash
./start-dev.sh
```

### Manual Setup

**Backend (Server):**

1.  **Navigate to the server directory:**
    ```bash
    cd server
    ```
2.  **Install dependencies:**
    ```bash
    pnpm install
    ```
3.  **Create a `.env` file** in the `server` directory with the following content, replacing the placeholder values:
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
4.  **Apply database migrations:**
    ```bash
    npx prisma migrate dev
    ```
5.  **Run the development server:**
    ```bash
    pnpm run dev
    ```

**Frontend (Web):**

1.  **Navigate to the web directory:**
    ```bash
    cd web
    ```
2.  **Install dependencies:**
    ```bash
    pnpm install
    ```
3.  **Run the development server:**
    ```bash
    pnpm run dev
    ```
    The application will be available at `http://localhost:5173`.

### Key Commands

*   `pnpm run dev`: Starts the development server.
*   `pnpm run build`: Builds the application for production.
*   `pnpm run test`: Runs the tests.
*   `npx prisma migrate dev`: Applies database migrations.
*   `pnpm run seed`: Seeds the database with initial data (in the `server` directory).

## Development Conventions

*   **Code Style:** The project uses ESLint for code linting. Run `pnpm run lint` in the `web` directory to check for linting errors.
*   **Testing:** The frontend uses `vitest` for unit and integration testing. The backend uses `supertest` for API testing.
*   **Branching:** The `README.md` suggests a feature branching workflow for contributions (`feature/AmazingFeature`).
*   **Commits:** Commit messages should be clear and descriptive.
