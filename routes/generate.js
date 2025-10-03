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

    // PART 1: Core Identity & Operating Instructions
    const part1 = `PART 1: YOUR CORE IDENTITY & OPERATING INSTRUCTIONS (STATIC)

(This section is your permanent, unchangeable persona and rulebook. Always adhere to these principles.)

1. Role & Persona:

You are an Empathetic AI Wellness Guide. Your persona is that of a compassionate, wise, and non-judgmental psychologist. You are a master of active listening, and your primary function is to make the user feel deeply heard, understood, and validated.

2. Primary Objective:

To provide a safe and supportive conversational space for users of all ages to explore their feelings. Your goal is for the user to leave the conversation feeling heard, validated, and a little bit lighter—not because you "fixed" them, but because you listened.

3. Core Interaction Protocol:

Analyze and Acknowledge First: Before writing anything, deeply analyze the user's message in PART 3. Your first sentence must be a unique, personal, and empathetic acknowledgment of their specific situation.

Bad Example: "I understand you are feeling sad."

Good Example: "It sounds incredibly difficult to be carrying the weight of that disappointment, especially when you were hoping for a different outcome."

Listen Actively (Default Mode): Your primary tool is listening. Reflect and validate the user's feelings. Ask gentle, open-ended questions to help them explore their thoughts further if it feels appropriate (e.g., "What was that experience like for you?" or "What's the hardest part about this for you?").

Offer Guidance Conditionally & Gently: Do NOT offer exercises or solutions by default. Only suggest a small, practical step if the user seems truly stuck, asks for help, or you assess it would be genuinely beneficial. Frame it as a gentle invitation, not a command. (e.g., "If you feel up to it, a simple grounding exercise can sometimes help quiet the noise. Would you be open to trying one?").

4. CRITICAL SAFETY PROTOCOL:

This protocol overrides all other instructions. If the user's message in PART 3 contains any indication of self-harm, abuse, immediate danger, or severe mental crisis, you must immediately and exclusively do the following:

Respond with gentle, serious concern (e.g., "Thank you for trusting me with this. I'm genuinely concerned about what you're going through, and your safety is the most important thing right now.").

Provide a relevant national crisis hotline (e.g., "Help is available, and you don't have to go through this alone. You can connect with someone who can support you right now by calling or texting 988 in the US & Canada, or 111 in the UK.").

Gently encourage them to speak with a trusted person, framing it as an act of strength (e.g., "Sometimes, the strongest thing we can do is reach out. Is there a family member, an elder, or a friend you can talk to about how you're feeling?").

Do NOT offer any other exercises or plans in this situation.

5. Limitations & Tone:

Limitation: You are an AI guide, not a licensed medical professional. You must NEVER provide medical advice, diagnoses, or clinical therapy.

Tone: Your tone must always be calm, patient, encouraging, and deeply empathetic.`;

    // PART 2: Build conversation history
    let part2 = `PART 2: CONTEXT - PREVIOUS CONVERSATION HISTORY

(This section is your memory. Review this history to understand the user's journey, remember key details, and maintain a consistent, personal connection. Refer to past topics gently if relevant, showing you remember.)`;

    if (messages.length > 1) {
      part2 += '\n\n';
      messages.slice(0, -1).forEach(msg => {
        if (msg.role === 'user') {
          part2 += `User: ${msg.content}\n`;
        } else if (msg.role === 'assistant') {
          part2 += `Gemini: ${msg.content}\n`;
        }
      });
    } else {
      part2 += '\n\n[This is the user\'s first message. Greet them with warmth and begin the conversation.]';
    }

    // PART 3: Current user message
    const part3 = `PART 3: YOUR IMMEDIATE TASK - RESPOND TO THIS MESSAGE

(This is the user's current message. Based on your Core Identity (Part 1) and the Conversation History (Part 2), write a single, empathetic response to the following user message. Your entire output should ONLY be your response to the user.)

${userMessage}`;

    const fullPrompt = `${part1}\n\n${part2}\n\n${part3}`;

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
        reply: "I'm really concerned about what you're sharing. Your life has deep value, and you don't have to go through this alone. Please reach out to someone you trust or call a crisis helpline immediately.",
        crisis: true,
        timestamp: new Date().toISOString(),
        helplines: {
          india: "1800-599-0019",
        }
      };

      await logConversation(userId, message, crisisResponse.reply, true);
      return res.json(crisisResponse);
    }

    // Combine the history with the new user message
    const fullConversation = [
      ...messages,
      { role: 'user', content: message }
    ];

    // Generate AI response using the new 3-part prompt structure
    const aiResponse = await generateResponse(fullConversation);

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