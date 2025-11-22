const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logConversation, getFirestore } = require('../lib/firebase');
const { initializeFirebase } = require('../lib/firebase');
const path = require('path');
const fs = require('fs');

const admin = initializeFirebase();

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Load app routes configuration
const appRoutesPath = path.join(__dirname, '../config/appRoutes.json');
const appRoutes = JSON.parse(fs.readFileSync(appRoutesPath, 'utf8'));

// Crisis detection with word boundaries to avoid false positives
const detectCrisis = (message) => {
  // Use word boundaries (\b) to match complete words/phrases only
  const crisisPattern = /\b(suicide|kill myself|end my life|not worth living|self harm|self-harm|cut myself|hurt myself|want to die|better off dead|no point living|give up on life|end it all|take my life|self-destruct|can'?t go on|no reason to live|hopeless about life)\b/i;
  
  return crisisPattern.test(message);
};

// Generate empathetic response
const generateResponse = async (messages, userContext = { name: 'Friend', recentMoods: 'No recent data', wellnessSummary: '' }) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const userMessage = messages[messages.length - 1].content;

    // PART 1: Core Identity & Operating Instructions
    const part1 = `PART 1: YOUR CORE IDENTITY & OPERATING INSTRUCTIONS

ROLE: You are an Empathetic AI Wellness Companion.

DEEP MEMORY (Long-term context about this user):
${userContext.wellnessSummary || 'No long-term history available yet.'}

USER CONTEXT (CRITICAL):
Name: ${userContext.name}
Recent Mood History:
${userContext.recentMoods}

INSTRUCTIONS:

1. **CHECK CONTEXT FIRST:** Look at the "Recent Mood History" above.
   - IF the user logged a specific mood or note (like a "fight", "anxiety", or low score) in the last 24 hours, **YOU MUST reference it** in your very first sentence.
   - Example: "I saw you noted a fight with your mom earlier. How are you feeling about that now?"
   - Do NOT give a generic "Hello" if there is specific context to address.
   - IF this is the first conversation and there IS mood context, start with: "Hi ${userContext.name}, I saw you logged [specific context]. How are you feeling about that now?"
   - IF this is the first conversation and there is NO mood context, start with: "Hi ${userContext.name}, how are you feeling today?"
   - In follow-up messages, use warm terms like "friend" or "buddy" instead of repeating their name.

2. **Internal Analysis (SILENT):** Before responding, internally analyze:
   - What core emotion(s) are they expressing? (e.g., sadness, anxiety, frustration, hopelessness)
   - Are there cognitive distortions? (all-or-nothing thinking, catastrophizing, overgeneralization, personalization)
   - What do they truly need? (validation, perspective, action, just to be heard)
   (This analysis is internal only - do NOT include it in your response)

3. **Validation First:** Validate their feelings before offering help. Your first sentence must be a unique, personal, and empathetic acknowledgment of their specific situation.

4. **Listen Actively (Default Mode):** Reflect and validate feelings. Ask gentle, open-ended questions to help them explore their thoughts (e.g., "What was that experience like for you?" or "What's the hardest part about this for you?").

5. **Guidance - Conditional Only:** Do NOT offer exercises or solutions by default. Only suggest wellness activities if the user seems truly stuck, asks for help, or you assess it would be genuinely beneficial. Frame it as a gentle invitation, not a command.

6. **Available Wellness Activities on Our Platform** (Suggest when user asks for activities, relaxation techniques, or something to do):
   
   Activities available on our platform:
   ${appRoutes.activities.map(a => `- ${a.title}: ${a.description} (${a.duration})`).join('\n   ')}
   
   **IMPORTANT - When suggesting activities:**
   - Frame suggestions warmly and invitingly
   - DO NOT include links in your response - a button will automatically appear for users to explore activities
   - Simply mention the activities naturally in conversation
   
   Example responses:
   - "If you feel up to it, a simple breathing exercise can sometimes help quiet the noise. We have a 5-minute guided breathing exercise on our platform that might help."
   - "It sounds like you could use some relaxation. We have several activities that might help - guided meditation, gentle stretching, or gratitude journaling."
   - "When you're ready, exploring some wellness activities could be helpful. We have breathing exercises, meditation, and creative activities designed to support you."

7. **Other Platform Features** (Mention only if relevant to user's needs):
   - Dashboard: "You can view your mood trends and insights on your [Dashboard](${appRoutes.routes.dashboard.path})"
   - Use these links when user asks about tracking their progress or viewing their mood history

8. **Tone:** Warm, professional, and supportive. Your tone must always be calm, patient, encouraging, and deeply empathetic.

9. **Limitations:** You are an AI guide, not a licensed medical professional. You must NEVER provide medical advice, diagnoses, or clinical therapy.

SAFETY PROTOCOL (OVERRIDES ALL):
If the user expresses self-harm, suicide ideation, abuse, immediate danger, or severe mental crisis, ignore style guidelines and:
- Respond with gentle, serious concern: "Thank you for trusting me with this. I'm genuinely concerned about what you're going through, and your safety is the most important thing right now."
- Provide crisis resources immediately: "Help is available, and you don't have to go through this alone. You can connect with someone who can support you right now by calling or texting 988 in the US & Canada, or 111 in the UK."
- Gently encourage them to speak with a trusted person: "Sometimes, the strongest thing we can do is reach out. Is there a family member, an elder, or a friend you can talk to about how you're feeling?"
- Do NOT offer any other exercises or plans in this situation.`;

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

    // Fetch user context (name + recent mood data)
    const userContext = await fetchUserContext(userId);

    // DEBUG LOGS - Check what context the AI is seeing
    console.log("--- DEBUG CONTEXT ---");
    console.log("User ID:", userId);
    console.log("Context Data:", JSON.stringify(userContext, null, 2));
    console.log("---------------------");

    // Combine the history with the new user message
    const fullConversation = [
      ...messages,
      { role: 'user', content: message }
    ];

    // Generate AI response with user context
    const aiResponse = await generateResponse(fullConversation, userContext);

    // Check if response mentions activities/suggestions to add button
    const activityKeywords = ['activit', 'exercise', 'breathing', 'meditation', 'relaxation', 'practice', 'try', 'suggest', 'help you'];
    const mentionsActivities = activityKeywords.some(keyword => 
      aiResponse.toLowerCase().includes(keyword)
    );

    const response = {
      reply: aiResponse,
      crisis: false,
      timestamp: new Date().toISOString(),
      // Add button if activities are mentioned
      buttons: mentionsActivities ? [{
        label: 'Explore Activities',
        url: appRoutes.routes.activities.path,
        icon: '🎯'
      }] : undefined
    };

    await logConversation(userId, message, aiResponse, false);
    
    // Update long-term wellness summary in the background (non-blocking)
    // This keeps the summary fresh without slowing down the chat response
    if (userId && userId !== 'anonymous') {
      const conversationWithResponse = [
        ...fullConversation,
        { role: 'assistant', content: aiResponse }
      ];
      
      // Fire and forget - don't await
      updateUserSummary(userId, conversationWithResponse, userContext.wellnessSummary)
        .catch(err => console.error('Background summary update failed:', err));
    }
    
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

// Fetch user context (name + recent mood summaries + long-term memory) - WITH DEEP MEMORY
const fetchUserContext = async (userId) => {
  if (!userId || userId === 'anonymous') return { name: 'Friend', recentMoods: '', wellnessSummary: '' };
  
  try {
    const db = getFirestore();
    if (!db) {
      return { name: 'Friend', recentMoods: 'No recent data', wellnessSummary: '' };
    }

    // 1. Get Name (first name only) and Wellness Summary
    const userDoc = await db.collection('users').doc(userId).get();
    let name = 'Friend';
    let wellnessSummary = '';
    
    if (userDoc && userDoc.exists && userDoc.data()) {
      const userData = userDoc.data();
      
      if (userData.name) {
        const fullName = userData.name;
        name = fullName.split(' ')[0];
      }
      
      // Retrieve long-term wellness summary
      wellnessSummary = userData.wellnessSummary || '';
    }

    // 2. Get Moods (Simplified query to avoid Index issues)
    const moodQuery = await db.collection('moodEntries')
      .where('userId', '==', userId)
      .limit(5)
      .get();
    
    if (moodQuery.empty) {
      return { name, recentMoods: 'No recent mood logs.', wellnessSummary };
    }

    // 3. Sort in JS to be safe (prevents Firestore index errors)
    const sortedDocs = moodQuery.docs
      .map(d => d.data())
      .sort((a, b) => {
        const timeA = a.timestamp || a.date || '';
        const timeB = b.timestamp || b.date || '';
        return timeB.localeCompare(timeA); // Descending
      })
      .slice(0, 3); // Take top 3

    // 4. Format string (preserve note content with quotes for clarity)
    const recentMoods = sortedDocs.map(data => {
      return `- Date: ${data.date}, Mood: ${data.mood}/10, Note: "${data.note || ''}"`;
    }).join('\n');

    return { name, recentMoods, wellnessSummary };
  } catch (error) {
    console.error('Context fetch error:', error);
    return { name: 'Friend', recentMoods: 'Error fetching data.', wellnessSummary: '' };
  }
};

// Update user's long-term wellness summary using Gemini
const updateUserSummary = async (userId, newMessages, currentSummary) => {
  if (!userId || userId === 'anonymous') return;
  
  try {
    const db = getFirestore();
    if (!db) return;

    // Extract recent conversation for summarization (last 4 messages)
    const recentConvo = newMessages.slice(-4).map(msg => {
      const role = msg.role === 'user' ? 'User' : 'AI';
      return `${role}: ${msg.content}`;
    }).join('\n');

    // Use Gemini to condense into a concise summary
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const summaryPrompt = `You are a mental health summary assistant. Your job is to maintain a concise, bullet-point summary of a user's mental state and history.

CURRENT SUMMARY:
${currentSummary || 'No previous summary.'}

NEW CONVERSATION EXCERPT:
${recentConvo}

TASK:
Update the summary by:
1. Keeping important long-term patterns (recurring themes, progress, setbacks)
2. Adding significant new insights from the conversation above
3. Removing outdated or less important details
4. Keeping it under 150 words, formatted as bullet points

Focus on:
- Recurring emotional patterns or triggers
- Progress or changes in mental state
- Important life context (relationships, work, family)
- Coping strategies that work/don't work
- Any red flags or concerns

Return ONLY the updated bullet-point summary, nothing else.`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
      generationConfig: {
        temperature: 0.5,
        topK: 20,
        topP: 0.9,
        maxOutputTokens: 300,
      },
    });

    const updatedSummary = result.response.text();

    // Save to Firestore
    await db.collection('users').doc(userId).set({
      wellnessSummary: updatedSummary,
      lastSummaryUpdate: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`✅ Updated wellness summary for user: ${userId}`);
  } catch (error) {
    console.error('Error updating user summary:', error);
  }
};

module.exports = router;

