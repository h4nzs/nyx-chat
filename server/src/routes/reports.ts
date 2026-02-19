import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { env } from '../config.js'
import { generalLimiter } from '../middleware/rateLimiter.js'
import { prisma } from '../lib/prisma.js'

const router: Router = Router()

router.post('/user', generalLimiter, requireAuth, async (req, res) => {
  try {
    const { reportedUserId, reason } = req.body
    const reporter = req.user!

    const reportedUser = await prisma.user.findUnique({ where: { id: reportedUserId } })

    if (!env.discordReportWebhookUrl) {
        console.warn('⚠️ DISCORD_REPORT_WEBHOOK_URL is not set.')
        return res.json({ success: true })
    }

    const discordPayload = {
      username: 'NYX Watchdog',
      embeds: [{
        title: "🚨 USER REPORT",
        color: 16711680, // Merah Darah
        fields: [
          { name: "Reporter", value: `${reporter.username} (\`${reporter.id}\`)`, inline: true },
          { name: "Reported User", value: `${reportedUser?.username || 'Unknown'} (\`${reportedUserId}\`)`, inline: true },
          { name: "Reason", value: reason || 'No reason provided' },
        ],
        timestamp: new Date().toISOString(),
      }]
    }

    await fetch(env.discordReportWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload)
    })

    res.json({ success: true })
  } catch (error) {
    console.error('Failed to report user:', error)
    res.status(500).json({ error: 'Failed to send report' })
  }
})

router.post('/', generalLimiter, requireAuth, async (req, res, _next) => {
  try {
    const { title, description, deviceInfo } = req.body
    const user = req.user! // Dari middleware requireAuth

    // Jika URL Webhook belum diset, log error di server tapi jangan bikin user error
    if (!env.discordReportWebhookUrl) {
      console.warn('⚠️ DISCORD_REPORT_WEBHOOK_URL is not set. Report not sent.')
      return res.json({ success: true, message: 'Report received (simulation)' })
    }

    // Format Payload untuk Discord Webhook
    const discordPayload = {
      username: 'NYX Reporter',
      avatar_url: 'https://cdn-icons-png.flaticon.com/512/4961/4961759.png', // Ikon Bug
      embeds: [
        {
          title: `🐛 New Bug Report: ${title}`,
          description,
          color: 15158332, // Warna Merah (Decimal)
          fields: [
            {
              name: '👤 User',
              value: `${user.username} (ID: \`${user.id}\`)`,
              inline: true
            },
            {
              name: '📱 Device Info',
              value: `\`${deviceInfo || 'Unknown'}\``,
              inline: false
            },
            {
              name: '🕒 Time',
              value: new Date().toLocaleString(),
              inline: true
            }
          ],
          footer: {
            text: 'NYX System • Report Module'
          }
        }
      ]
    }

    // Kirim ke Discord
    const response = await fetch(env.discordReportWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload)
    })

    if (!response.ok) {
      throw new Error(`Discord API Error: ${response.statusText}`)
    }

    res.json({ success: true, message: 'Report sent successfully' })
  } catch (error) {
    console.error('Failed to send report:', error)
    // Tetap return 200 ke user biar UX bagus, tapi kita log errornya di server
    res.json({ success: true, message: 'Report logged locally' })
  }
})

export { router as reportRoutes }
