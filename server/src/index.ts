import { createServer } from "http";
import app from "./app.js";
import { registerSocket } from "./socket.js";
import { startMessageSweeper } from "./jobs/messageSweeper.js";
import { startSystemSweeper } from "./jobs/systemSweeper.js";
import { connectRedis } from "./lib/redis.js";

async function main() {
  await connectRedis();

  const httpServer = createServer(app);

  registerSocket(httpServer);
  startMessageSweeper();
  startSystemSweeper();

  const PORT = process.env.PORT || 4000;
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
