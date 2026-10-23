import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function globalSetup() {
  // Benchmark/probe tidak butuh DB bersih dan tidak boleh menghapus data
  // selfhost hanya untuk mengukur performa. Opt-in eksplisit.
  if (process.env.NYX_E2E_SKIP_RESET === '1') {
    console.log('⏭️  Global Setup: reset DB/Redis dilewati (NYX_E2E_SKIP_RESET=1).');
    return;
  }

  console.log('🛠️ Running Global Setup for Playwright: Resetting Environment...');
  
  const serverDir = path.resolve(__dirname, '../../server');
  try {
    // Execute the reset script in the server directory. `NYX_E2E_DATABASE_URL`
    // mengarahkan reset (dan server E2E lewat playwright.config) ke DB uji
    // terpisah — tanpa itu, selfhost yang API-nya memakai .env yang sama akan
    // kehilangan data aplikasi setiap kali suite berjalan.
    execSync('pnpm exec tsx scripts/reset-test-env.ts', {
      cwd: serverDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(process.env.NYX_E2E_DATABASE_URL
          ? { DATABASE_URL: process.env.NYX_E2E_DATABASE_URL }
          : {}),
      },
    });
  } catch (error) {
    console.error('❌ Global setup failed to reset the environment.');
    throw error;
  }
}

export default globalSetup;
