import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function globalSetup() {
  console.log('🛠️ Running Global Setup for Playwright: Resetting Environment...');
  
  const serverDir = path.resolve(__dirname, '../../server');
  try {
    // Execute the reset script in the server directory
    execSync('pnpm exec tsx scripts/reset-test-env.ts', {
      cwd: serverDir,
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('❌ Global setup failed to reset the environment.');
    throw error;
  }
}

export default globalSetup;
