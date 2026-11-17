import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { redisClient } from '../lib/redis.js'
import { resolvePushLinkToken, type PushLinkStore } from '../utils/pushLink.js'

const router: Router = Router()

// [docs/43 §43.16.2 T3] Token opaque dari notifikasi ditukar menjadi id
// percakapan HANYA untuk pemiliknya. Token ada di hash URL dan hanya known ke
// perangkat penerima; respons tidak di-cache.
router.post('/link', requireAuth, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : ''
  const conversationId = token
    ? await resolvePushLinkToken(redisClient as unknown as PushLinkStore, {
        token,
        userId: req.user!.id,
      })
    : null

  if (!conversationId) {
    return res.status(404).json({ error: 'PUSH_LINK_INVALID' })
  }

  res.setHeader('Cache-Control', 'no-store')
  res.json({ conversationId })
})

export default router
