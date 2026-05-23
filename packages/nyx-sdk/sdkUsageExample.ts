import { NyxClient } from '@nyx-engine/sdk';

// 1. Initialize the engine
const nyx = new NyxClient({
  apiKey: 'YOUR_APP_SECRET_KEY',
  environment: 'production'
});

// 2. Connect to nyx server with your token
await nyx.connectUser(userToken);

// 3. Listening to automatic decrypted incoming messasges
nyx.on('message.decrypted', (message) => {
  console.log("New message received:", message);
});

// 4. Sending Post-Quantum Encryption message
await nyx.sendMessage('room_123', 'Hello world!');
