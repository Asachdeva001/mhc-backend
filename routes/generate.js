const express = require('express');
const router = express.Router();
const OpenAI = require("openai");
const { logConversation, getFirestore } = require('../lib/firebase');
const { initializeFirebase } = require('../lib/firebase');
const path = require('path');
const fs = require('fs');

const admin = initializeFirebase();

// Initialize OpenAI
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Format multi-modal transcript data into readable narrative for AI
 */
const formatMultiModalPrompt = (multiModalData) => {
  if (!Array.isArray(multiModalData) || multiModalData.length === 0) return '';

  let narrative = '\n\n=== DEEP CHECK-IN DATA (INTERNAL USE ONLY - DO NOT SHARE THIS WITH USER) ===\n';
  narrative += 'The user just completed a 1-minute Deep Check-In. Below is their transcript with emotional analysis:\n\n';

  multiModalData.forEach((entry, index) => {
    narrative += `${index + 1}. "${entry.phrase || entry.text}" - Emotion: ${entry.emotion}\n`;
  });

  narrative += `
YOUR RESPONSE INSTRUCTIONS:
- DO NOT reveal this transcript
- Respond like a close friend
- Avoid clinical or analytical tone
- Ask ONE warm follow-up question
- Keep response 2–4 sentences max
=== END INTERNAL DATA ===\n`;

  return narrative;
};

// Load app routes config
const appRoutesPath = path.join(__dirname, '../config/appRoutes.json');
const appRoutes = JSON.parse(fs.readFileSync(appRoutesPath, 'utf8'));

// Crisis detection
const detectCrisis = (message) => {
  const crisisPattern = /\b(suicide|kill myself|end my life|not worth living|self harm|self-harm|cut myself|hurt myself|want to die|better off dead|no point living|give up on life|end it all|take my life|can't go on)\b/i;
  return crisisPattern.test(message);
};

// Generate empathetic response with OpenAI
const generateResponse = async (messages, userContext = { name: 'Friend', recentMoods: 'No recent data', wellnessSummary: '' }) => {
  try {
    const userMessage = messages[messages.length - 1].content;

    const systemPrompt = `
You are an empathetic AI wellness companion. Follow these rules:

- Speak warmly, casually, humanly — like texting a close friend
- Validate emotions with compassion and specificity
- Ask ONE thoughtful follow-up question unless user says no
- No bullet points unless offering 2–3 coping options
- No therapy claims, diagnosing, or clinical language
- 2–4 sentences unless user requests guidance
- If activities may help, softly suggest them — don’t push

USER CONTEXT:
Name: ${userContext.name}
Recent Mood History:
${userContext.recentMoods}

Long-term wellness summary:
${userContext.wellnessSummary || 'No historical context available'}

NEVER reveal internal notes, facial analysis, or transcript data.
NEVER tell the user you're referencing stored context.
`;

    // Convert history to OpenAI chat format
    const formattedHistory = messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini", // ✅ fast, cheap, high quality
      temperature: 0.7,
      max_tokens: 500,
      messages: [
        { role: "system", content: systemPrompt },
        ...formattedHistory
      ]
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error("OpenAI API error:", error);
    throw new Error("Failed to generate response");
  }
};

// ✅ Main endpoint
router.post('/', async (req, res) => {
  try {
    const { message, messages = [], userId = 'anonymous', facialEmotion = null, multiModalData = null } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Crisis protocol
    if (detectCrisis(message)) {
      const crisisResponse = {
        reply: "I'm really glad you told me. Your safety matters deeply, and you're not alone in this. Please reach out to someone you trust or call a crisis helpline immediately.",
        crisis: true,
        timestamp: new Date().toISOString(),
        helplines: { india: "1800-599-0019" }
      };

      await logConversation(userId, message, crisisResponse.reply, true);
      return res.json(crisisResponse);
    }

    // Fetch context
    const userContext = await fetchUserContext(userId);

    let enhancedMessage = message;

    if (multiModalData?.length > 0) {
      enhancedMessage += formatMultiModalPrompt(multiModalData);
    } else if (facialEmotion?.dominant && facialEmotion.dominant !== "Neutral") {
      enhancedMessage += `\n\n[SYSTEM NOTE: Facial cues suggest ${facialEmotion.dominant}. If this contradicts message tone, gently check in.]`;
    }

    const fullConversation = [
      ...messages,
      { role: 'user', content: enhancedMessage }
    ];

    const aiResponse = await generateResponse(fullConversation, userContext);

    const activityTriggers = ['breathing', 'exercise', 'activity', 'journal', 'relax', 'meditation', 'try', 'coping'];
    const mentionsActivities = activityTriggers.some(k => aiResponse.toLowerCase().includes(k));

    const response = {
      reply: aiResponse,
      crisis: false,
      timestamp: new Date().toISOString(),
      buttons: mentionsActivities
        ? [{ label: "Explore Activities", url: appRoutes.routes.activities.path, icon: "🎯" }]
        : undefined
    };

    await logConversation(userId, message, aiResponse, false);

    updateUserSummary(userId, [...fullConversation, { role: "assistant", content: aiResponse }], userContext.wellnessSummary)
      .catch(err => console.error("Background summary update failed:", err));

    res.json(response);
  } catch (error) {
    console.error("Generate route error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ✅ Token verification + ✅ save-conversation endpoint remain unchanged…

module.exports = router;
