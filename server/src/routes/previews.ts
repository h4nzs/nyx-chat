import { Router } from 'express'
import { getSecureLinkPreview, resolveDns } from '../utils/secureLinkPreview.js'
import { requireAuth } from '../middleware/auth.js'

const router: Router = Router()

router.post('/', requireAuth, async (req, res, next) => {
  const { url } = req.body
  if (!url) {
    return res.status(400).json({ error: 'URL is required' })
  }

  try {
    const preview = await getSecureLinkPreview(url)
    if ('title' in preview) {
      res.json(preview)
    } else {
      res.status(404).json({ error: 'Could not generate a preview for this link.' })
    }
  } catch (error) {
    console.error('Link preview error:', error)
    next(error)
  }
})

router.get('/image', requireAuth, async (req, res, next) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) return res.status(400).json({ error: 'URL is required' });

  try {
    // 1. SSRF Protection: Ensure the target is a public, safe IP
    await resolveDns(targetUrl);

    // 2. Fetch the image safely with an AbortController (5-second timeout)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const imageRes = await fetch(targetUrl, { 
      signal: controller.signal,
      headers: { 'User-Agent': 'NYX-Preview-Bot/1.0', 'Accept': 'image/*' }
    });
    clearTimeout(timeoutId);

    if (!imageRes.ok) throw new Error(`Target responded with ${imageRes.status}`);

    const contentType = imageRes.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
        throw new Error('Target is not an image');
    }

    // 3. Prevent memory exhaustion: Limit to 5MB
    const arrayBuffer = await imageRes.arrayBuffer();
    if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
        throw new Error('Image exceeds 5MB limit');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 1 day
    res.send(Buffer.from(arrayBuffer));

  } catch (error) {
     console.error('Image proxy error:', error);
     res.status(400).json({ error: 'Could not proxy image' });
  }
});

export default router
