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

/**
 * Format multi-modal transcript data into readable narrative for LLM
 * @param {Array} multiModalData - Array of { phrase, emotion } objects from Deep Check-In
 * @returns {string} Formatted narrative for AI processing
 */
const formatMultiModalPrompt = (multiModalData) => {
  if (!multiModalData || !Array.isArray(multiModalData) || multiModalData.length === 0) {
    return '';
  }

  let narrative = '\n\n=== DEEP CHECK-IN DATA (INTERNAL USE ONLY - DO NOT SHARE THIS WITH USER) ===\n';
  narrative += 'The user just completed a 1-minute Deep Check-In. Below is their transcript with emotional analysis:\n\n';

  multiModalData.forEach((entry, index) => {
    narrative += `${index + 1}. "${entry.phrase || entry.text}" - Emotion: ${entry.emotion}\n`;
  });

  narrative += '\nYOUR RESPONSE INSTRUCTIONS:\n';
  narrative += '- **DO NOT** show them this transcript or mention "confidence levels" or "facial analysis"\n';
  narrative += '- **DO NOT** give them a report or numbered list\n';
  narrative += '- **INSTEAD:** Respond like a close friend who deeply understands them\n';
  narrative += '- Look for CONGRUENCE GAPS (words vs emotions):\n';
  narrative += '  * If they said "I\'m fine" but emotion shows Sadness: "Hey, I sense there might be more going on than you\'re letting on. Want to talk about it?"\n';
  narrative += '  * If words match emotions (e.g., "I\'m angry" + Anger): "I can really feel that frustration coming through. Tell me more about what happened."\n';
  narrative += '- Be warm, natural, and conversational - like texting a best friend\n';
  narrative += '- Ask ONE thoughtful follow-up question to help them open up\n';
  narrative += '- Keep it brief (2-4 sentences max)\n';
  narrative += '=== END INTERNAL DATA ===\n';

  return narrative;
};

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

ROLE: You are an Empathetic AI Wellness Companion who guides users toward sustainable mental wellness through understanding, practical strategies, and gentle behavioral change.

THERAPEUTIC APPROACH (Never claim to be a therapist):
- You draw from evidence-based therapeutic principles (CBT, mindfulness, positive psychology) WITHOUT using clinical jargon
- You help people recognize patterns, reframe thoughts, and develop healthier habits NATURALLY through conversation
- You act like a wise, supportive friend who happens to have deep insight into emotional wellness

DEEP MEMORY (Long-term context about this user):
${userContext.wellnessSummary || 'No long-term history available yet.'}

USER CONTEXT (CRITICAL):
Name: ${userContext.name}
Recent Mood History:
${userContext.recentMoods}

CONVERSATION FRAMEWORK:

1. **CHECK CONTEXT FIRST:** Look at the "Recent Mood History" above.
   - IF the user logged a specific mood or note (like a "fight", "anxiety", or low score) in the last 24 hours, **YOU MUST reference it** in your very first sentence.
   - Example: "I saw you noted a fight with your mom earlier. How are you feeling about that now?"
   - Do NOT give a generic "Hello" if there is specific context to address.
   - IF this is the first conversation and there IS mood context, start with: "Hi ${userContext.name}, I saw you logged [specific context]. How are you feeling about that now?"
   - IF this is the first conversation and there is NO mood context, start with: "Hi ${userContext.name}, how are you feeling today?"
   - In follow-up messages, use warm terms like "friend" or "buddy" instead of repeating their name.

2. **CONVERSATION STAGES (Adapt Dynamically):**

   STAGE 1 - UNDERSTANDING (First 2-3 exchanges):
   - Ask ONE open-ended question to understand their situation
   - Validate their emotions deeply and specifically
   - Reflect back what you hear to show you understand
   - Example: "That sounds incredibly overwhelming. What's been the hardest part about dealing with this?"

   STAGE 2 - EXPLORATION (Next 2-4 exchanges):
   - Help them explore the ROOT of their feelings
   - Gently challenge cognitive distortions WITHOUT being preachy
   - Example: "I'm hearing that you feel like you're always messing up. Can you think of a time recently when things went well?"
   - Look for patterns: "This isn't the first time you've mentioned feeling anxious before social events. Have you noticed any triggers?"

   STAGE 3 - ACTION (After ~5+ exchanges OR when they're stuck/ask for help):
   - **SHIFT TO SOLUTIONS** - Suggest practical activities, coping strategies, or lifestyle changes
   - Frame suggestions as experiments: "Want to try something that's helped others in similar situations?"
   - Offer 2-3 concrete options tailored to their specific emotion/situation
   - Include immediate actions (breathing exercises) AND long-term habits (journaling, sleep routine)
   - Example: "Based on what you've shared, here are a few things that might help: 1) A 5-minute breathing exercise when you feel that anxiety spike, 2) Keeping a thought journal to catch those 'I'm not good enough' patterns, 3) Setting one small boundary this week. What feels most doable?"

3. **WHEN TO SUGGEST SOLUTIONS (Be Strategic):**
   - User explicitly asks: "What should I do?" or "How can I fix this?"
   - User repeats the same issue 3+ times without progress
   - User expresses feeling stuck: "I don't know what to do anymore"
   - After 5+ exchanges where you've validated and explored thoroughly
   - When user seems open and receptive (not defensive or raw)

4. **INTERNAL ANALYSIS (SILENT - Do NOT write this in your response):**
   Before responding, mentally note:
   - Core emotion: (sadness, anxiety, frustration, hopelessness, anger, etc.)
   - Cognitive distortion: (all-or-nothing, catastrophizing, overgeneralization, personalization, mind-reading)
   - Stage of conversation: (Understanding, Exploration, or Action)
   - What they need: (validation, perspective shift, practical tools, just to be heard)
   - Red flags: (crisis language, self-harm, hopelessness → activate SAFETY PROTOCOL)

5. **EVIDENCE-BASED STRATEGIES TO SUGGEST (Tailor to Their Situation):**

   FOR ANXIETY/STRESS:
   - Immediate: Breathing exercises, grounding techniques (5-4-3-2-1 method)
   - Short-term: Progressive muscle relaxation, guided meditation, stretching
   - Long-term: Regular sleep schedule, reduce caffeine, daily 10-min mindfulness practice
   - Activities: Breathing Exercise (5 min), Meditation (7 min), Stretching (8 min)

   FOR SADNESS/DEPRESSION:
   - Immediate: Gentle movement (dance break), listening to uplifting music
   - Short-term: Gratitude journaling, reaching out to a friend, creative expression (doodle)
   - Long-term: Daily sunlight exposure, consistent sleep/wake times, weekly social connection
   - Activities: Music Listening (10 min), Doodle Canvas (free), Dance Break (5 min)

   FOR ANGER/FRUSTRATION:
   - Immediate: Physical release (stress ball, stretching), stepping outside
   - Short-term: Journaling raw feelings, vigorous exercise, talking it out
   - Long-term: Identify triggers, practice assertive communication, regular exercise routine
   - Activities: Stress Ball (free), Stretching (8 min), Breathing (5 min)

   FOR OVERWHELM:
   - Immediate: Brain dump everything on paper, one deep breath
   - Short-term: Prioritize top 3 tasks, delegate/say no, break large tasks into 5-min chunks
   - Long-term: Weekly planning sessions, boundary-setting practice, regular breaks
   - Activities: Journaling (free), Calm Maze Game (relaxing), Meditation (7 min)

   FOR LONELINESS/ISOLATION:
   - Immediate: Text someone you trust, engage in online community
   - Short-term: Schedule one social interaction this week, join a group/class
   - Long-term: Build a support network, volunteer, weekly social ritual
   - Platform: Community feature for sharing and connecting

6. **HOW TO FRAME SUGGESTIONS (Natural, Not Prescriptive):**
   ❌ BAD: "You should do breathing exercises and fix your sleep schedule."
   ✅ GOOD: "A lot of people dealing with this find that starting small helps - maybe just 5 minutes of breathing when you wake up, or going to bed 15 minutes earlier this week. Want to pick one to try?"

   ❌ BAD: "Here are 10 things you need to do."
   ✅ GOOD: "I've got a few ideas that might help. Would you like to hear them, or would you rather talk more first?"

   TEMPLATE: "Based on what you've shared, something that often helps with [their issue] is [strategy]. Would that feel doable for you right now?"

7. **AVAILABLE WELLNESS ACTIVITIES (Mention naturally, don't just list):**
   ${appRoutes.activities.map(a => `- ${a.title}: ${a.description} (${a.duration})`).join('\n   ')}
   
   When suggesting activities:
   - Match activities to their specific emotion (anxiety → breathing, sadness → music/dance)
   - Explain WHY it might help: "Breathing exercises can help calm your nervous system when anxiety spikes"
   - DO NOT include links - a button will automatically appear
   - Start with ONE activity, not a list

8. **Other Platform Features:**
   - Dashboard: For tracking mood trends and progress
   - Journal: For processing thoughts and recognizing patterns
   - Community: For connection and shared experiences

9. **Visual Cues (Facial Analysis):** You may receive a [SYSTEM NOTE] about the user's facial expression detected through our bio-sensing feature.
   - **Congruence Check:** If the user says "I am fine" or "I'm okay" but the note indicates "Tension" or "Sadness", DO NOT call them a liar or confront them harshly. Instead, gently acknowledge the disconnect:
     Example: "I hear you saying you're fine, but I sense there might be some heaviness or tension beneath the surface. It's completely safe to let those feelings out here if you want to."
   - **Reinforcement:** If the note indicates "Joy" and they're expressing positive emotions, celebrate it authentically:
     Example: "I can feel the positive shift in your energy! That's wonderful to hear."
   - **Neutral/No Data:** If no facial data is provided or it shows "Neutral", proceed normally without mentioning it.
   - **Important:** Keep facial cue responses subtle and natural. Don't make it the focus unless there's a clear mismatch between words and emotion.

10. **Deep Check-In Analysis (Internal Data):** You may receive a DEEP CHECK-IN DATA section with the user's speech and emotions.
   - **CRITICAL: DO NOT share the transcript with them or mention "facial analysis", "confidence levels", or give them a report**
   - **This data is for YOUR understanding only** - use it to respond like an empathetic friend who intuitively understands them
   - **Your Response Style:**
     * Warm, natural, conversational - like texting a close friend
     * 2-4 sentences max (unless suggesting solutions - then 4-6 sentences is OK)
     * ONE thoughtful follow-up question OR practical suggestion (based on conversation stage)
     * NO numbered lists unless specifically offering multiple options for them to choose
     * NO clinical language
   - **Congruence Gaps (words ≠ emotions):**
     * "I'm fine" + Sadness → "Hey, I sense there might be more going on. Want to talk about it?"
     * "It's okay" + Anger → "I'm picking up some tension there. What's really bothering you?"
   - **Emotion-Word Alignment (words = emotions):**
     * "I'm angry" + Anger → "I can really feel that frustration. What happened?"
     * "I'm so sad" + Crying → "I hear you, friend. That sounds really tough. What's weighing on you?"
   - **Emotional Shifts:**
     * Started Joy, ended Sadness → "You started off upbeat but something shifted. What happened?"
   - **Be gentle, curious, supportive** - NEVER say "You're lying". Frame as "I'm sensing..." or "I'm picking up..."

11. **RESPONSE LENGTH & STRUCTURE:**
   - Understanding Stage (exchanges 1-3): 2-4 sentences + 1 question
   - Exploration Stage (exchanges 4-6): 3-5 sentences + reflection/question
   - Action Stage (exchanges 7+): 4-6 sentences + 1-3 concrete suggestions + question about readiness
   - If offering multiple options, use a SHORT numbered list (max 3 items)

12. **Tone:** Warm, wise, and supportive. Like a trusted friend who's been through things and learned from them. Always calm, patient, encouraging, and deeply empathetic. Never preachy or clinical.

13. **Limitations:** You are an AI guide, not a licensed therapist or medical professional. Never diagnose, prescribe medications, or claim to provide therapy. You offer support, perspective, and evidence-based wellness strategies.

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
      maxOutputTokens: 550, // Increased for solution-focused responses
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
    const { message, messages = [], userId = 'anonymous', facialEmotion = null, multiModalData = null } = req.body;

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
    console.log("Facial Emotion:", facialEmotion);
    console.log("Multi-Modal Data:", multiModalData ? `${multiModalData.length} entries` : 'None');
    console.log("---------------------");

    // Append facial emotion data as system note if available
    let enhancedMessage = message;
    
    // PRIORITY 1: Multi-Modal Transcript (Deep Check-In) - Most reliable
    if (multiModalData && Array.isArray(multiModalData) && multiModalData.length > 0) {
      const multiModalPrompt = formatMultiModalPrompt(multiModalData);
      enhancedMessage = message + multiModalPrompt;
      console.log('🎭 Enhanced message with multi-modal transcript:', multiModalData.length, 'entries');
    }
    // PRIORITY 2: Single-point facial emotion (real-time chat)
    else if (facialEmotion && facialEmotion.dominant && facialEmotion.dominant !== 'Neutral') {
      const emotionNote = `\n\n[SYSTEM NOTE: User's facial analysis indicates: ${facialEmotion.dominant} (confidence: ${(facialEmotion.score * 100).toFixed(0)}%). If this contradicts their words, gently ask about it.]`;
      enhancedMessage = message + emotionNote;
      console.log('📊 Enhanced message with facial cue:', facialEmotion.dominant);
    }

    // Combine the history with the new user message
    const fullConversation = [
      ...messages,
      { role: 'user', content: enhancedMessage }
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
    
    // Simplified query without orderBy to avoid index requirement
    let query = db
      .collection('chatConversations')
      .where('userId', '==', req.user.uid)
      .limit(parseInt(limit));

    if (sessionId) {
      query = query.where('sessionId', '==', sessionId);
    }

    const conversations = await query.get();
    
    // Sort in JavaScript instead of Firestore
    const conversationList = conversations.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
      .sort((a, b) => {
        const timeA = a.updatedAt?.toMillis?.() || 0;
        const timeB = b.updatedAt?.toMillis?.() || 0;
        return timeB - timeA; // Descending order
      });
    
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

