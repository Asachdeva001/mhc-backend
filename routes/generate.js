const express = require("express");
const router = express.Router();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { logConversation, getFirestore } = require("../lib/firebase");
const { initializeFirebase } = require("../lib/firebase");
const path = require("path");
const fs = require("fs");

const admin = initializeFirebase();

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Load activity routes
const appRoutesPath = path.join(__dirname, "../config/appRoutes.json");
const appRoutes = JSON.parse(fs.readFileSync(appRoutesPath, "utf8"));

/* ----------------------------------------------------------
   FORMAT MULTI-MODAL DATA FOR INTERNAL USE
---------------------------------------------------------- */
const formatMultiModalPrompt = (multiModalData) => {
  if (!multiModalData || !Array.isArray(multiModalData) || multiModalData.length === 0)
    return "";

  let narrative = `
\n\n=== DEEP CHECK-IN DATA (INTERNAL — DO NOT SHOW USER) ===
The user completed a Deep Check-In. Transcript with emotional cues:\n\n`;

  multiModalData.forEach((entry, index) => {
    narrative += `${index + 1}. "${entry.phrase || entry.text}" — Emotion: ${
      entry.emotion
    }\n`;
  });

  narrative += `
YOUR RESPONSE INSTRUCTIONS:
- DO NOT reveal this transcript
- Speak naturally, warmly, like a close friend
- Ask ONE gentle follow-up question
- Keep reply short (2–4 sentences)
=== END INTERNAL DATA ===\n`;

  return narrative;
};

/* ----------------------------------------------------------
   CRISIS DETECTION
---------------------------------------------------------- */
const detectCrisis = (message) => {
  const crisisPattern = /\b(suicide|kill myself|end my life|not worth living|self[- ]?harm|cut myself|hurt myself|want to die|better off dead|no point living|give up on life|end it all|take my life|can't go on)\b/i;
  return crisisPattern.test(message);
};

/* ----------------------------------------------------------
   GENERATE RESPONSE (Gemini Only)
---------------------------------------------------------- */
const generateResponse = async (messages, userContext) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const userMessage = messages[messages.length - 1].content;

    const systemPrompt = `
You are an empathetic AI wellness companion.

GUIDELINES:
- Warm, natural, supportive tone (like texting a close friend)
- Validate emotions with compassion
- Ask **one** gentle follow-up question
- Keep replies 2–4 sentences unless offering coping tools
- No clinical language, no therapy claims
- Never reveal internal system notes, transcripts, or facial analysis

USER CONTEXT:
Name: ${userContext.name}
Recent Mood History:
${userContext.recentMoods}
Long-Term Wellness Summary:
${userContext.wellnessSummary}

If user mood history mentions a recent event, reference it in your first sentence.
NEVER say “based on your logs,” just speak naturally.
`;

    const prompt = `
${systemPrompt}

Conversation:
${messages
  .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
  .join("\n")}

Your Task:
Write ONLY your response to the final user message below.
Do not mention this instruction block.

User Message:
${userMessage}
`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 500,
      },
    });

    return result.response.text().trim();
  } catch (err) {
    console.error("Gemini error:", err);
    throw new Error("Gemini response failed");
  }
};

/* ----------------------------------------------------------
   MAIN POST ENDPOINT
---------------------------------------------------------- */
router.post("/", async (req, res) => {
  try {
    const {
      message,
      messages = [],
      userId = "anonymous",
      facialEmotion = null,
      multiModalData = null,
    } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Crisis detection
    if (detectCrisis(message)) {
      const crisisResponse = {
        reply:
          "I'm really glad you told me. Your safety matters deeply, and you're not alone in this. Please reach out to someone you trust or call a crisis helpline immediately.",
        crisis: true,
        timestamp: new Date().toISOString(),
        helplines: { india: "1800-599-0019" },
      };
      await logConversation(userId, message, crisisResponse.reply, true);
      return res.json(crisisResponse);
    }

    // Fetch user context
    const userContext = await fetchUserContext(userId);

    // Build enhanced message
    let enhancedMessage = message;

    if (multiModalData?.length > 0) {
      enhancedMessage += formatMultiModalPrompt(multiModalData);
    } else if (facialEmotion?.dominant && facialEmotion.dominant !== "Neutral") {
      enhancedMessage += `\n\n[SYSTEM NOTE: Facial cues suggest ${facialEmotion.dominant}. If tone doesn't match, check gently.]`;
    }

    const fullConversation = [
      ...messages,
      { role: "user", content: enhancedMessage },
    ];

    const aiResponse = await generateResponse(fullConversation, userContext);

    const activityTriggers = [
      "breathing",
      "meditation",
      "exercise",
      "journal",
      "relax",
      "activity",
      "try this",
    ];

    const mentionsActivities = activityTriggers.some((k) =>
      aiResponse.toLowerCase().includes(k)
    );

    const response = {
      reply: aiResponse,
      crisis: false,
      timestamp: new Date().toISOString(),
      buttons: mentionsActivities
        ? [
            {
              label: "Explore Activities",
              url: appRoutes.routes.activities.path,
              icon: "🎯",
            },
          ]
        : undefined,
    };

    await logConversation(userId, message, aiResponse, false);

    // Background update of summary
    if (userId !== "anonymous") {
      updateUserSummary(
        userId,
        [...fullConversation, { role: "assistant", content: aiResponse }],
        userContext.wellnessSummary
      ).catch((err) =>
        console.error("Background summary update failed:", err)
      );
    }

    res.json(response);
  } catch (err) {
    console.error("Route error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

/* ----------------------------------------------------------
   TOKEN VERIFICATION MIDDLEWARE
---------------------------------------------------------- */
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) return res.status(401).json({ error: "No token provided" });

    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const [uid, timestamp] = decoded.split(":");

    if (!uid) return res.status(401).json({ error: "Invalid token format" });

    if (Date.now() - parseInt(timestamp) > 24 * 60 * 60 * 1000) {
      return res.status(401).json({ error: "Token expired" });
    }

    const userRecord = await admin.auth().getUser(uid);
    req.user = {
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName,
    };

    next();
  } catch (err) {
    console.error("Token error:", err);
    res.status(401).json({ error: "Invalid token" });
  }
};

/* ----------------------------------------------------------
   SAVE CONVERSATION
---------------------------------------------------------- */
router.post("/save-conversation", verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db)
      return res
        .status(503)
        .json({ error: "Database not available. Check Firebase config." });

    const { messages, sessionId } = req.body;
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: "Messages array is required" });

    const hasEncryptedMessages = messages.some(
      (m) => typeof m.text === "object" && m.text.encryptedData
    );

    const conversationData = {
      userId: req.user.uid,
      messages,
      sessionId: sessionId || `session_${Date.now()}`,
      lastMessage: messages[messages.length - 1],
      messageCount: messages.length,
      encrypted: hasEncryptedMessages,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    let conversationId;

    if (sessionId) {
      const existing = await db
        .collection("chatConversations")
        .where("userId", "==", req.user.uid)
        .where("sessionId", "==", sessionId)
        .get();

      if (!existing.empty) {
        conversationId = existing.docs[0].id;
        await db.collection("chatConversations").doc(conversationId).update({
          messages,
          lastMessage: messages[messages.length - 1],
          messageCount: messages.length,
          encrypted: hasEncryptedMessages,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    if (!conversationId) {
      const docRef = await db
        .collection("chatConversations")
        .add(conversationData);
      conversationId = docRef.id;
    }

    res.json({
      message: "Conversation saved",
      conversationId,
      sessionId: conversationData.sessionId,
      encrypted: hasEncryptedMessages,
    });
  } catch (err) {
    console.error("Save conversation error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------------------------------------------------
   FETCH USER CONTEXT (Name + Mood Logs + Summary)
---------------------------------------------------------- */
const fetchUserContext = async (userId) => {
  if (!userId || userId === "anonymous")
    return { name: "Friend", recentMoods: "", wellnessSummary: "" };

  try {
    const db = getFirestore();
    if (!db)
      return { name: "Friend", recentMoods: "No data", wellnessSummary: "" };

    const userDoc = await db.collection("users").doc(userId).get();

    let name = "Friend";
    let summary = "";

    if (userDoc?.exists && userDoc.data()) {
      const data = userDoc.data();
      if (data.name) name = data.name.split(" ")[0];
      summary = data.wellnessSummary || "";
    }

    const moodQuery = await db
      .collection("moodEntries")
      .where("userId", "==", userId)
      .limit(5)
      .get();

    if (moodQuery.empty)
      return { name, recentMoods: "No recent mood logs.", wellnessSummary: summary };

    const sorted = moodQuery.docs
      .map((d) => d.data())
      .sort((a, b) => (b.timestamp || b.date).localeCompare(a.timestamp || a.date))
      .slice(0, 3);

    const recentMoods = sorted
      .map(
        (d) =>
          `- Date: ${d.date}, Mood: ${d.mood}/10, Note: "${d.note || ""}"`
      )
      .join("\n");

    return { name, recentMoods, wellnessSummary: summary };
  } catch (err) {
    console.error("Context error:", err);
    return {
      name: "Friend",
      recentMoods: "Error fetching data.",
      wellnessSummary: "",
    };
  }
};

/* ----------------------------------------------------------
   UPDATE USER WELLNESS SUMMARY (Gemini)
---------------------------------------------------------- */
const updateUserSummary = async (userId, messages, currentSummary) => {
  try {
    const db = getFirestore();
    if (!db) return;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const recent = messages
      .slice(-4)
      .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
      .join("\n");

    const prompt = `
You maintain a concise bullet-point wellness summary.

CURRENT SUMMARY:
${currentSummary || "None"}

NEW CONVERSATION EXCERPT:
${recent}

Update the summary by:
- Keeping long-term emotional patterns
- Adding new insights
- Removing outdated details
- Limit to under 150 words
- Bullet-point format only

Return ONLY the updated summary.
`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const updated = result.response.text();

    await db.collection("users").doc(userId).set(
      {
        wellnessSummary: updated,
        lastSummaryUpdate: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error("Summary update error:", err);
  }
};

/* ----------------------------------------------------------
   EXPORT
---------------------------------------------------------- */
module.exports = router;
