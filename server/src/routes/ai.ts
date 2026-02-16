import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { requireAuth } from '../middleware/auth.js';
import { generalLimiter } from '../middleware/rateLimiter.js';

const router = Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Rate limit to prevent abuse
router.post('/smart-reply', requireAuth, generalLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Use Flash model for speed
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });
    
    // Strict Prompt Engineering for JSON Array output
    const prompt = `You are a chat AI. Based on this message: "${message}"
Create 3 short casual reply options (max 3 words per reply) in the same language.
Output must be a JSON array of strings.`;

    const result = await model.generateContent(prompt);
    
    let replies: string[] = [];
    
    try {
      replies = JSON.parse(result.response.text());
    } catch (parseError) {
      console.error('Failed to parse Gemini JSON:', parseError);
      // Manual fallback
      replies = ["Ok", "Got it", "Thanks"]; 
    }

    // Return to frontend
    res.json({ replies });
    
  } catch (error) {
    console.error('AI Error:', error);
    res.status(500).json({ error: 'Failed to generate smart replies' });
  }
});

export default router;
