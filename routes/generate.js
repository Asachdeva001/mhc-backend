const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logConversation, getFirestore } = require('../lib/firebase');
const { initializeFirebase } = require('../lib/firebase');
const admin = initializeFirebase();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const fetch = require('node-fetch'); // v2 style

// Hardcode the Flask URL for now to avoid env issues
const MENTAL_API_URL = 'http://localhost:5001/predictMentalState';

// 🔥 Detect crisis using the Flask /predictMentalState endpoint
const detectCrisis = async (message) => {
  try {
    const resp = await fetch(MENTAL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });

    console.log('MentalState API status:', resp.status);

    const rawBody = await resp.text();
    console.log('MentalState API raw body:', rawBody);

    if (!resp.ok) {
      console.error('MentalState API error status:', resp.status);
      return { isCrisis: false, scores: null };
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (e) {
      console.error('Failed to parse JSON from MentalState API:', e);
      return { isCrisis: false, scores: null };
    }

    console.log('MentalState API parsed JSON:', data);

    return {
      isCrisis: Boolean(data.isCrisis),
      scores: data.scores || null,
    };
  } catch (err) {
    console.error('Error calling MentalState API:', err);
    return { isCrisis: false, scores: null };
  }
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

router.post('/', async (req, res) => {
  try {
    const { message, messages = [], userId = 'anonymous' } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // ✅ 1) Call Flask & check crisis result
    const crisisResult = await detectCrisis(message);
    console.log('Crisis result in route:', crisisResult);

    // Optional: tiny textual backup heuristic
    const heuristicCrisis = /kill myself|suicide|end my life|take my life/i.test(message);
    const isCrisis = crisisResult.isCrisis || heuristicCrisis;

    if (isCrisis) {
      const crisisResponse = {
        reply:
          "I'm really concerned about what you're sharing. Your life has deep value, and you don't have to go through this alone. Please reach out to someone you trust or call a crisis helpline immediately.",
        crisis: true,
        timestamp: new Date().toISOString(),
        helplines: {
          india: '1800-599-0019',
        },
        scores: crisisResult.scores || null,
      };

      await logConversation(userId, message, crisisResponse.reply, true);
      return res.json(crisisResponse);
    }

    // ✅ 2) Non-crisis → use Gemini
    const fullConversation = [
      ...messages,
      { role: 'user', content: message },
    ];

    const aiResponse = await generateResponse(fullConversation);

    const response = {
      reply: aiResponse,
      crisis: false,
      timestamp: new Date().toISOString(),
    };

    await logConversation(userId, message, aiResponse, false);
    return res.json(response);
  } catch (error) {
    console.error('Generate route error:', error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
});


// Middleware to verify session token
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    try {
      // Decode the session token
      const decoded = Buffer.from(token, 'base64').toString('utf-8');
      const [uid, timestamp] = decoded.split(':');
      if (!uid) throw new Error('Invalid token format');

      // Token age check (24 hours)
      const tokenAge = Date.now() - parseInt(timestamp);
      if (tokenAge > 24 * 60 * 60 * 1000) {
        throw new Error('Token expired');
      }

      const userRecord = await admin.auth().getUser(uid);

      req.user = {
        uid: userRecord.uid,
        email: userRecord.email,
        name: userRecord.displayName,
      };

      next();
    } catch (decodeError) {
      console.error('Token decode error:', decodeError);
      res.status(401).json({ error: 'Invalid token' });
    }
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Save chat conversation to database
router.post('/save-conversation', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { messages, sessionId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Check if messages are encrypted
    const hasEncryptedMessages = messages.some(msg => 
      typeof msg.text === 'object' && msg.text.encryptedData
    );

    const conversationData = {
      userId: req.user.uid,
      messages: messages,
      sessionId: sessionId || `session_${Date.now()}`,
      lastMessage: messages[messages.length - 1],
      messageCount: messages.length,
      encrypted: hasEncryptedMessages,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Check if conversation already exists
    let conversationId;
    if (sessionId) {
      const existingQuery = await db
        .collection('chatConversations')
        .where('userId', '==', req.user.uid)
        .where('sessionId', '==', sessionId)
        .get();

      if (!existingQuery.empty) {
        // Update existing conversation
        conversationId = existingQuery.docs[0].id;
        await db.collection('chatConversations').doc(conversationId).update({
          messages: messages,
          lastMessage: messages[messages.length - 1],
          messageCount: messages.length,
          encrypted: hasEncryptedMessages,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    if (!conversationId) {
      // Create new conversation
      const docRef = await db.collection('chatConversations').add(conversationData);
      conversationId = docRef.id;
    }

    res.json({
      message: 'Conversation saved successfully',
      conversationId: conversationId,
      sessionId: conversationData.sessionId,
      encrypted: hasEncryptedMessages
    });
  } catch (error) {
    console.error('Error saving conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's chat conversations
router.get('/conversations', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { limit = 10, sessionId } = req.query;
    
    let query = db
      .collection('chatConversations')
      .where('userId', '==', req.user.uid)
      .orderBy('updatedAt', 'desc')
      .limit(parseInt(limit));

    if (sessionId) {
      query = query.where('sessionId', '==', sessionId);
    }

    const conversations = await query.get();
    
    const conversationList = conversations.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    res.json(conversationList);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific conversation
router.get('/conversation/:sessionId', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { sessionId } = req.params;
    
    const conversationQuery = await db
      .collection('chatConversations')
      .where('userId', '==', req.user.uid)
      .where('sessionId', '==', sessionId)
      .get();
    
    if (conversationQuery.empty) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    const conversation = {
      id: conversationQuery.docs[0].id,
      ...conversationQuery.docs[0].data()
    };
    
    res.json(conversation);
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete conversation
router.delete('/conversation/:sessionId', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { sessionId } = req.params;
    
    const conversationQuery = await db
      .collection('chatConversations')
      .where('userId', '==', req.user.uid)
      .where('sessionId', '==', sessionId)
      .get();
    
    if (conversationQuery.empty) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    await db.collection('chatConversations').doc(conversationQuery.docs[0].id).delete();
    
    res.json({ message: 'Conversation deleted successfully' });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
