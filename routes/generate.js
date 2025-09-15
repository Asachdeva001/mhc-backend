const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logConversation } = require('../lib/firebase');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Crisis detection keywords
const crisisKeywords = [
  'suicide', 'kill myself', 'end my life', 'not worth living',
  'self harm', 'cut myself', 'hurt myself', 'want to die',
  'better off dead', 'no point living', 'give up', 'hopeless',
  'cant go on', 'end it all', 'take my life', 'self-destruct'
];

// Detect crisis
const detectCrisis = (message) => {
  const lowerMessage = message.toLowerCase();
  return crisisKeywords.some(keyword => lowerMessage.includes(keyword));
};

// Generate empathetic response
const generateResponse = async (messages) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const userMessage = messages[messages.length - 1].content;

    // ✅ Refined system prompt
    const systemPrompt = `
You are a compassionate and practical mental wellness guide.  
When the user shares a message:  

1. Identify the main feeling, thought, or challenge in their message.  
2. Suggest 2 simple, actionable mental wellness exercises they can try.  
   - Examples: breathing techniques, grounding exercises, journaling prompts, short reflections, positive affirmations, gratitude practice, or mindfulness activities.  
   - Keep each exercise short, clear, and easy to follow.  
3. If the user describes a difficult situation (e.g., stress, anxiety, conflict, loneliness, overthinking), provide a gentle, step-by-step plan to help them cope with it.  
   - Break it into small, realistic steps.  
   - Use supportive and encouraging language.  

Always include both sections:  
- **Exercises (2 practical tips)**  
- **Plan (only if a situation is described)**  

Keep responses empathetic, encouraging, and focused on mental health wellness.  
Do not give medical or clinical advice; focus only on self-care strategies, coping techniques, and supportive guidance.`;



    // Build conversation context
    let conversationContext = '';
    if (messages.length > 1) {
      conversationContext = '\n\nConversation so far:\n';
      messages.slice(0, -1).forEach(msg => {
        if (msg.role === 'user') conversationContext += `User: ${msg.content}\n`;
        if (msg.role === 'assistant') conversationContext += `Mental Buddy: ${msg.content}\n`;
      });
    }

    const fullPrompt = `${systemPrompt}${conversationContext}

Current user message: "${userMessage}"`;

    const generationConfig = {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 250,
    };

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig,
    });

    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Gemini API error:', error);
    throw new Error('Failed to generate response');
  }
};

// Main endpoint
router.post('/', async (req, res) => {
  try {
    const { message, messages = [], userId = 'anonymous' } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Crisis detection
    if (detectCrisis(message)) {
      const crisisResponse = {
        reply: "I'm really concerned about what you're sharing. Your life has deep value, and you don’t have to go through this alone. Please reach out to someone you trust or call a crisis helpline immediately.",
        crisis: true,
        timestamp: new Date().toISOString(),
        helplines: {
          india: "1800-599-0019",
        }
      };

      await logConversation(userId, message, crisisResponse.reply, true);
      return res.json(crisisResponse);
    }

    // AI response
    const aiResponse = await generateResponse(messages);

    const response = {
      reply: aiResponse,
      crisis: false,
      timestamp: new Date().toISOString()
    };

    await logConversation(userId, message, aiResponse, false);
    res.json(response);
  } catch (error) {
    console.error('Generate route error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
