const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getFirestore, initializeFirebase } = require('../lib/firebase');

const admin = initializeFirebase();

// Initialize Gemini AI (only if API key is available)
let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}
  
// Middleware to verify session token (copied from mood.js pattern)
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
      
      if (!uid) {
        console.error('Invalid token format: missing UID');
        return res.status(401).json({ error: 'Invalid token format' });
      }

      // Token age check (24 hours)
      const tokenAge = Date.now() - parseInt(timestamp);
      if (tokenAge > 24 * 60 * 60 * 1000) {
        console.error('Token expired. Age:', tokenAge / (1000 * 60 * 60), 'hours');
        return res.status(401).json({ error: 'Token expired' });
      }

      // Verify user exists in Firebase Auth
      const userRecord = await admin.auth().getUser(uid);

      req.user = {
        uid: userRecord.uid,
        email: userRecord.email,
        name: userRecord.displayName,
      };

      next();
    } catch (decodeError) {
      // Handle specific Firebase Auth errors
      if (decodeError.code === 'auth/user-not-found') {
        console.error('User not found in Firebase Auth. UID:', decodeError.message);
        return res.status(401).json({ 
          error: 'User not found',
          message: 'Please sign in again to create a new session'
        });
      }
      
      console.error('Token decode error:', decodeError.code || decodeError.message);
      return res.status(401).json({ error: 'Invalid token' });
    }
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// POST / - Create a new journal entry
router.post('/', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { title, content, moodScore, tags, isFavorite } = req.body;

    // Validation
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    if (moodScore && (moodScore < 1 || moodScore > 10)) {
      return res.status(400).json({ error: 'Mood score must be between 1 and 10' });
    }

    // Create journal entry
    const journalEntry = {
      userId: req.user.uid,
      title: title.trim(),
      content: content, // Frontend handles encryption if needed
      moodScore: moodScore ? parseInt(moodScore) : null,
      tags: Array.isArray(tags) ? tags.filter(tag => tag && tag.trim()) : [],
      isFavorite: isFavorite === true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection('journalEntries').add(journalEntry);

    res.status(201).json({
      message: 'Journal entry created successfully',
      entryId: docRef.id,
      entry: {
        id: docRef.id,
        ...journalEntry,
      },
    });
  } catch (error) {
    console.error('Error creating journal entry:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET / - Fetch journal entries for current user with filtering
router.get('/', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { limit = 10, tag, mood } = req.query;

    // Start with base query
    let query = db.collection('journalEntries')
      .where('userId', '==', req.user.uid);

    // Apply tag filter if provided
    if (tag) {
      query = query.where('tags', 'array-contains', tag);
    }

    // Apply mood filter if provided
    if (mood) {
      const moodMap = {
        'low': [1, 2, 3, 4],
        'medium': [5, 6, 7],
        'high': [8, 9, 10]
      };

      if (moodMap[mood.toLowerCase()]) {
        query = query.where('moodScore', 'in', moodMap[mood.toLowerCase()]);
      }
    }

    // Sort by creation date (descending) and limit
    query = query.orderBy('createdAt', 'desc').limit(parseInt(limit));

    const snapshot = await query.get();

    const entries = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      // Convert Firestore timestamps to ISO strings for JSON response
      createdAt: doc.data().createdAt?.toDate().toISOString() || null,
      updatedAt: doc.data().updatedAt?.toDate().toISOString() || null,
    }));

    res.json({
      entries,
      count: entries.length,
      filters: {
        limit: parseInt(limit),
        tag: tag || null,
        mood: mood || null,
      },
    });
  } catch (error) {
    console.error('Error fetching journal entries:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id - Update a journal entry (with ownership check)
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { id } = req.params;
    const { title, content, moodScore, tags, isFavorite } = req.body;

    // Fetch the entry to verify ownership
    const entryRef = db.collection('journalEntries').doc(id);
    const entryDoc = await entryRef.get();

    if (!entryDoc.exists) {
      return res.status(404).json({ error: 'Journal entry not found' });
    }

    const entryData = entryDoc.data();

    // CRITICAL: Check ownership
    if (entryData.userId !== req.user.uid) {
      return res.status(403).json({ error: 'You do not have permission to update this entry' });
    }

    // Build update object (only include fields that were provided)
    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (title !== undefined) updates.title = title.trim();
    if (content !== undefined) updates.content = content;
    if (moodScore !== undefined) {
      if (moodScore === null) {
        updates.moodScore = null;
      } else if (moodScore >= 1 && moodScore <= 10) {
        updates.moodScore = parseInt(moodScore);
      } else {
        return res.status(400).json({ error: 'Mood score must be between 1 and 10 or null' });
      }
    }
    if (tags !== undefined) {
      updates.tags = Array.isArray(tags) ? tags.filter(tag => tag && tag.trim()) : [];
    }
    if (isFavorite !== undefined) updates.isFavorite = isFavorite === true;

    // Update the entry
    await entryRef.update(updates);

    // Fetch updated entry
    const updatedDoc = await entryRef.get();
    const updatedEntry = {
      id: updatedDoc.id,
      ...updatedDoc.data(),
      createdAt: updatedDoc.data().createdAt?.toDate().toISOString() || null,
      updatedAt: updatedDoc.data().updatedAt?.toDate().toISOString() || null,
    };

    res.json({
      message: 'Journal entry updated successfully',
      entry: updatedEntry,
    });
  } catch (error) {
    console.error('Error updating journal entry:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id - Delete a journal entry (with ownership check)
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { id } = req.params;

    // Fetch the entry to verify ownership
    const entryRef = db.collection('journalEntries').doc(id);
    const entryDoc = await entryRef.get();

    if (!entryDoc.exists) {
      return res.status(404).json({ error: 'Journal entry not found' });
    }

    const entryData = entryDoc.data();

    // CRITICAL: Check ownership
    if (entryData.userId !== req.user.uid) {
      return res.status(403).json({ error: 'You do not have permission to delete this entry' });
    }

    // Delete the entry
    await entryRef.delete();

    res.json({
      message: 'Journal entry deleted successfully',
      entryId: id,
    });
  } catch (error) {
    console.error('Error deleting journal entry:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /test-auth - Test authentication without database queries
router.get('/test-auth', verifyToken, async (req, res) => {
  res.json({
    message: 'Authentication successful',
    user: req.user,
    timestamp: new Date().toISOString()
  });
});

// GET /prompts - AI Integration: Generate personalized reflection questions using Gemini
// This endpoint queries the moodEntries collection (cross-collection query) to get context
router.get('/prompts', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    // CROSS-COLLECTION QUERY: Fetch user's latest mood entry from moodEntries collection
    // This integrates with the existing mood tracking feature
    const moodQuery = await db.collection('moodEntries')
      .where('userId', '==', req.user.uid)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    let moodContext = 'No recent mood data available.';
    let moodScore = null;

    if (!moodQuery.empty) {
      const latestMood = moodQuery.docs[0].data();
      moodScore = latestMood.mood;
      const note = latestMood.note || 'No additional notes';
      moodContext = `Latest Mood: ${moodScore}/10\nDate: ${latestMood.date}\nNotes: ${note}\nEnergy: ${latestMood.energy || 'N/A'}\nStress: ${latestMood.stress || 'N/A'}\nSleep: ${latestMood.sleep || 'N/A'} hours`;
    }

    // Check if Gemini AI is available
    if (!genAI) {
      console.warn('Gemini API not configured. Returning generic prompts.');
      return res.json({
        prompts: [
          "What emotions are you feeling most strongly right now?",
          "What's one thing that brought you peace or comfort recently?",
          "If you could tell your future self something about today, what would it be?"
        ],
        moodScore: moodScore,
        moodContext: moodContext,
        generated: false,
        error: 'AI not configured',
      });
    }

    // Use Gemini to generate personalized reflection prompts based on mood data
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `You are a compassionate mental wellness journal assistant. Based on the user's recent mood data, generate 3 thoughtful, personalized reflection questions that would help them explore their feelings deeper.

USER'S RECENT MOOD DATA:
${moodContext}

REQUIREMENTS:
1. Generate exactly 3 reflection questions
2. Make them personal and relevant to their mood score and notes
3. Questions should be open-ended and thought-provoking
4. Use a warm, supportive tone
5. If mood is low (1-4), focus on self-compassion and gentle exploration
6. If mood is medium (5-7), focus on understanding patterns and context
7. If mood is high (8-10), focus on gratitude and maintaining positive practices

Return ONLY a JSON array of 3 strings (the questions), nothing else.
Example format: ["Question 1?", "Question 2?", "Question 3?"]`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 300,
      },
    });

    let responseText = result.response.text().trim();

    // Clean up response (remove markdown code blocks if present)
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    let questions;
    try {
      questions = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON:', responseText);
      // Fallback to generic questions
      questions = [
        "What emotions are you feeling most strongly right now?",
        "What's one thing that brought you peace or comfort recently?",
        "If you could tell your future self something about today, what would it be?"
      ];
    }

    // Ensure we have exactly 3 questions
    if (!Array.isArray(questions) || questions.length !== 3) {
      questions = [
        "What emotions are you feeling most strongly right now?",
        "What's one thing that brought you peace or comfort recently?",
        "If you could tell your future self something about today, what would it be?"
      ];
    }

    res.json({
      prompts: questions,
      moodScore: moodScore,
      moodContext: moodContext,
      generated: true,
    });
  } catch (error) {
    console.error('Error generating journal prompts:', error);
    
    // Fallback to generic prompts if AI fails
    res.json({
      prompts: [
        "What emotions are you feeling most strongly right now?",
        "What's one thing that brought you peace or comfort recently?",
        "If you could tell your future self something about today, what would it be?"
      ],
      moodScore: null,
      moodContext: 'Unable to fetch mood data',
      generated: false,
      error: 'AI generation failed, using fallback prompts',
    });
  }
});

module.exports = router;
