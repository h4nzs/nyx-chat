import { createServer } from "http";
import app from "./app.js";
import { registerSocket } from "./socket.js";
import { startMessageSweeper } from "./jobs/messageSweeper.js";

const httpServer = createServer(app);

registerSocket(httpServer);
startMessageSweeper();

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
