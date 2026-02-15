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
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    
    // Strict Prompt Engineering for JSON Array output
    const prompt = `You are an AI that generates short chat replies.
Based on this incoming message: "${message}"

Create 3 short reply options (max 3 words per reply) in the language detected from the message (casual/professional as appropriate).
STRICT RULE: The output MUST be a pure JSON Array without markdown formatting (no backticks/code blocks).
Example output: ["Gas", "idk", "Let's go"]`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let replies: string[] = [];
    
    try {
      // Clean up markdown json if present
      const cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
      replies = JSON.parse(cleanText);
    } catch (parseError) {
      console.error('Failed to parse Gemini JSON:', responseText);
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
