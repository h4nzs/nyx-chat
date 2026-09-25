// index.ts
import { connectRedis } from './lib/redis.js'
import { createServer } from 'http'

async function main() {
  // 1. Konek Redis DULU, tungguin sampai beneran sukses
  await connectRedis()

  // 2. BARU kita load app dan kawan-kawannya (mereka aman sekarang karena Redis udah nyala)
  const { default: app } = await import('./app.js')
  const { initializeRedisBridge } = await import('./network/redisBridge.js')
  const { attachWssGateway } = await import('./realtime/gateway.js')
  const { startMessageSweeper } = await import('./jobs/messageSweeper.js')
  const { startSystemSweeper } = await import('./jobs/systemSweeper.js')

  const httpServer = createServer(app)

  await initializeRedisBridge()
  attachWssGateway(httpServer)
  startMessageSweeper()
  startSystemSweeper()

  const PORT = Number(process.env.PORT || 4000)
  // Bind loopback by default: only cloudflared (same host) needs to reach us.
  // Override with HOST=0.0.0.0 ONLY if an external proxy must connect directly.
  const HOST = process.env.HOST || '127.0.0.1'
  httpServer.listen(PORT, HOST, () => {
    console.log(`🚀 Server running at http://${HOST}:${PORT}`)
  })

  // Graceful shutdown (pm2 stop/reload sends SIGINT, rolling deploys SIGTERM):
  // drain WSS sockets first so clients reconnect elsewhere instead of timing out.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n${signal} received — draining realtime gateway…`)
    try {
      const { closeWssGateway } = await import('./realtime/gateway.js')
      await closeWssGateway()
    } catch {
      // Gateway may not have been attached — nothing to drain.
    }
    httpServer.close(() => process.exit(0))
    // Hard exit fallback if keep-alive connections refuse to drop.
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('Fatal error during startup:', err)
  process.exit(1)
})
