import { createServer } from "http";
import app from "./app.js";
import { registerSocket } from "./socket.js";
import { initStorageCron } from './services/storageCleaner.js';

const httpServer = createServer(app);

registerSocket(httpServer);

initStorageCron();

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
