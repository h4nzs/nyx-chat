import { execSync } from 'child_process';
import path from 'path';

async function globalSetup() {
  console.log('🛠️ Running Global Setup for Playwright: Resetting Environment...');
  
  const serverDir = path.resolve(__dirname, '../../server');
  try {
    // Execute the reset script in the server directory
    execSync('npx ts-node scripts/reset-test-env.ts', {
      cwd: serverDir,
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('❌ Global setup failed to reset the environment.');
    throw error;
  }
}

export default globalSetup;
