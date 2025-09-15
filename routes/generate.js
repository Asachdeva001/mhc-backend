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
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const userMessage = messages[messages.length - 1].content;

    // ✅ Refined system prompt
    const systemPrompt = `
You are **Mental Buddy**, an AI mental health companion.

ROLE:
- Your only focus is to help users manage stress, anxiety, and emotions.
- Speak warmly, but provide **practical coping strategies** instead of repeating questions.
- Avoid long reflections — instead, offer **1–2 clear steps the user can try immediately**.

GUIDELINES:
- Always validate their feeling first.
- Immediately suggest a short, doable technique (e.g. "try this 2-minute breathing exercise", "write down 3 thoughts", "take a mindful pause").
- Keep answers **2–3 sentences max**.
- Avoid therapy/medical claims. Stay in safe self-care techniques.

EXAMPLES:
- User: "I feel anxious" → "It’s okay to feel anxious. Let’s try a quick breathing exercise: inhale slowly for 4 seconds, hold for 4, exhale for 6. Notice how your body feels."
- User: "I need help with stress" → "Stress can feel heavy. A simple way to ease it now is to unclench your shoulders, take 3 slow breaths, and name one small thing you can control today."
- User: "I’m overwhelmed" → "That’s tough, and you’re not alone. Try writing down the top 3 things on your mind — often it feels lighter when it’s on paper." 
`;


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
