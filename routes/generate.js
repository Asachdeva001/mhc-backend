const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logConversation, getFirestore } = require('../lib/firebase');
const { initializeFirebase } = require('../lib/firebase');

const admin = initializeFirebase();

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
