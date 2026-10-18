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
  // [docs/10 §10.13] Unggah harian arsip snapshot log KT dari dir milik
  // `nyx-kt-query` ke R2 (kredensial objek hanya hidup di proses ini).
  const { startKtSnapshotUploader } = await import('./jobs/ktSnapshot.js')
  // [docs/30 WS-G] Metrik event-only, diekspos hanya di loopback.
  const { startMetricsServer, stopMetricsServer } = await import('./utils/metricsEndpoint.js')

  startMetricsServer()

  // [R11 2026-10-15] Keadaan konfigurasi anti-abuse dibuat EKSPLISIT: gauge
  // (alert `NyxAbuseGuardDisabled`) + peringatan boot untuk hal yang diam-diam
  // berbahaya bila lupa diset (guard registrasi, attestation, rahasia admin
  // cleanup). Semuanya murni dihitung di `utils/startupSignals.ts`.
  const {
    ABUSE_GUARD_ENABLED,
    ATTESTATION_ROOTS_EXPIRED_CERTS,
    ATTESTATION_ROOTS_NEXT_UPDATE,
    setGauge,
  } = await import('./utils/metrics.js')
  const { abuseGuardStates, startupWarnings } = await import('./utils/startupSignals.js')
  for (const state of abuseGuardStates(process.env)) {
    setGauge(ABUSE_GUARD_ENABLED, state.enabled, { guard: state.guard })
  }
  for (const warning of startupWarnings(process.env)) {
    console.warn(`⚠️  [startup] ${warning}`)
  }

  // [docs/30 §30.12 WS-H] Bundle root attestation juga bisa basi TANPA error:
  // root kedaluwarsa dan `nextUpdate` MDS yang lewat hanya terlihat saat ada
  // perangkat baru yang ditolak. Gauge-nya yang membuat alert mungkin, log-nya
  // yang membuat penyebabnya langsung terbaca. Tanpa ROOTS_FILE, keduanya diam.
  const { attestationRootsWarnings, readAttestationRootsHealth } = await import(
    './utils/attestationRootsHealth.js'
  )
  const rootsHealth = readAttestationRootsHealth(process.env)
  if (rootsHealth) {
    setGauge(ATTESTATION_ROOTS_EXPIRED_CERTS, rootsHealth.expired.length)
    if (rootsHealth.nextUpdateEpochSeconds !== null) {
      setGauge(ATTESTATION_ROOTS_NEXT_UPDATE, rootsHealth.nextUpdateEpochSeconds)
    }
    for (const warning of attestationRootsWarnings(rootsHealth)) {
      console.warn(`⚠️  [startup] ${warning}`)
    }
  }

  const httpServer = createServer(app)

  await initializeRedisBridge()
  attachWssGateway(httpServer)
  startMessageSweeper()
  startSystemSweeper()
  startKtSnapshotUploader()

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
    stopMetricsServer()
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
