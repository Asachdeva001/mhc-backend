const express = require('express');
const router = express.Router();
const { initializeFirebase, getFirestore } = require('../lib/firebase');

// Initialize Firebase Admin SDK
const admin = initializeFirebase();
const db = getFirestore();

// Middleware: Verify session token
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) return res.status(401).json({ error: "No token provided" });

    // Decode token
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const [uid, timestamp] = decoded.split(":");

    if (!uid) throw new Error("Invalid token format");

    // Check expiry (24h)
    const tokenAge = Date.now() - parseInt(timestamp);
    if (tokenAge > 24 * 60 * 60 * 1000) {
      throw new Error("Token expired");
    }

    const userRecord = await admin.auth().getUser(uid);

    req.user = {
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName,
    };

    next();
  } catch (err) {
    console.error("Token verification error:", err);
    res.status(401).json({ error: "Invalid token" });
  }
};

// Get today's wellness activities
router.get('/today', verifyToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get user's recent mood data to personalize activities
    const recentMoodQuery = await db
      .collection('moodEntries')
      .where('userId', '==', req.user.uid)
      .orderBy('date', 'desc')
      .limit(3)
      .get();
    
    const recentMoods = recentMoodQuery.docs.map(doc => doc.data());
    const avgMood = recentMoods.length > 0 
      ? recentMoods.reduce((sum, entry) => sum + entry.mood, 0) / recentMoods.length 
      : 5;
    
    // Get user's activity history to avoid repetition
    const activityHistoryQuery = await db
      .collection('activities')
      .where('userId', '==', req.user.uid)
      .where('date', '>=', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .get();
    
    const recentActivityIds = activityHistoryQuery.docs.map(doc => doc.data().activityId);
    
    // Base activities pool
    const allActivities = [
      // Mindfulness activities
      {
        id: 'breathing-exercise',
        title: '5-Minute Breathing Exercise',
        description: 'Practice deep breathing to reduce stress and anxiety',
        duration: '5 minutes',
        category: 'Mindfulness',
        difficulty: 'Easy',
        moodRange: [1, 10] // Suitable for all moods
      },
      {
        id: 'meditation',
        title: 'Guided Meditation',
        description: 'Listen to a calming meditation session',
        duration: '10 minutes',
        category: 'Mindfulness',
        difficulty: 'Medium',
        moodRange: [1, 8] // Better for lower moods
      },
      {
        id: 'body-scan',
        title: 'Body Scan Meditation',
        description: 'Progressive relaxation from head to toe',
        duration: '15 minutes',
        category: 'Mindfulness',
        difficulty: 'Medium',
        moodRange: [1, 7]
      },
      
      // Physical activities
      {
        id: 'walk-outside',
        title: 'Take a Walk Outside',
        description: 'Get some fresh air and gentle movement',
        duration: '15 minutes',
        category: 'Physical',
        difficulty: 'Easy',
        moodRange: [3, 10]
      },
      {
        id: 'stretching',
        title: 'Gentle Stretching',
        description: 'Release tension with simple stretches',
        duration: '10 minutes',
        category: 'Physical',
        difficulty: 'Easy',
        moodRange: [1, 10]
      },
      {
        id: 'dance-break',
        title: 'Dance Break',
        description: 'Put on your favorite song and move your body',
        duration: '5 minutes',
        category: 'Physical',
        difficulty: 'Easy',
        moodRange: [4, 10]
      },
      
      // Reflection activities
      {
        id: 'gratitude-journal',
        title: 'Gratitude Journaling',
        description: 'Write down three things you\'re grateful for today',
        duration: '10 minutes',
        category: 'Reflection',
        difficulty: 'Easy',
        moodRange: [1, 10]
      },
      {
        id: 'mood-reflection',
        title: 'Mood Reflection',
        description: 'Reflect on what influenced your mood today',
        duration: '8 minutes',
        category: 'Reflection',
        difficulty: 'Easy',
        moodRange: [1, 8]
      },
      {
        id: 'future-self',
        title: 'Future Self Visualization',
        description: 'Imagine your best self and what they would do',
        duration: '12 minutes',
        category: 'Reflection',
        difficulty: 'Medium',
        moodRange: [3, 10]
      },
      
      // Creative activities
      {
        id: 'doodle',
        title: 'Free-form Doodling',
        description: 'Let your creativity flow with simple drawing',
        duration: '10 minutes',
        category: 'Creative',
        difficulty: 'Easy',
        moodRange: [2, 10]
      },
      {
        id: 'music-listening',
        title: 'Music Therapy',
        description: 'Listen to music that matches or improves your mood',
        duration: '15 minutes',
        category: 'Creative',
        difficulty: 'Easy',
        moodRange: [1, 10]
      },
      
      // Social activities
      {
        id: 'reach-out',
        title: 'Reach Out to Someone',
        description: 'Send a message to a friend or family member',
        duration: '5 minutes',
        category: 'Social',
        difficulty: 'Easy',
        moodRange: [1, 10]
      },
      {
        id: 'compliment-self',
        title: 'Self-Compassion Practice',
        description: 'Write yourself a kind and encouraging message',
        duration: '8 minutes',
        category: 'Social',
        difficulty: 'Easy',
        moodRange: [1, 8]
      }
    ];
    
    // Filter activities based on mood and recent activity
    const suitableActivities = allActivities.filter(activity => {
      const isMoodSuitable = avgMood >= activity.moodRange[0] && avgMood <= activity.moodRange[1];
      const notRecentlyDone = !recentActivityIds.includes(activity.id);
      return isMoodSuitable && notRecentlyDone;
    });
    
    // If no suitable activities, fall back to basic ones
    const activities = suitableActivities.length > 0 
      ? suitableActivities.slice(0, 4) // Select up to 4 activities
      : allActivities.filter(activity => activity.difficulty === 'Easy').slice(0, 4);

    // Check which activities were completed today
    const todayActivities = await db
      .collection('activities')
      .where('userId', '==', req.user.uid)
      .where('date', '==', today)
      .get();

    const completedActivityIds = todayActivities.docs.map(doc => doc.data().activityId);
    
    // Mark completed activities and remove moodRange from response
    const activitiesWithStatus = activities.map(activity => {
      const { moodRange, ...activityData } = activity;
      return {
        ...activityData,
        completed: completedActivityIds.includes(activity.id)
      };
    });

    res.json(activitiesWithStatus);
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

// Mark activity as completed
router.post('/complete', verifyToken, async (req, res) => {
  try {
    const { activityId, notes } = req.body;
    
    if (!activityId) {
      return res.status(400).json({ error: 'Activity ID is required' });
    }

    const today = new Date().toISOString().split('T')[0];
    
    await db.collection('activities').add({
      userId: req.user.uid,
      activityId,
      date: today,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      notes: notes || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Activity marked as completed' });
  } catch (error) {
    console.error('Error completing activity:', error);
    res.status(500).json({ error: 'Failed to complete activity' });
  }
});

// Get activity history
router.get('/history', verifyToken, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const activities = await db
      .collection('activities')
      .where('userId', '==', req.user.uid)
      .where('completedAt', '>=', startDate)
      .orderBy('completedAt', 'desc')
      .get();

    const activityHistory = activities.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(activityHistory);
  } catch (error) {
    console.error('Error fetching activity history:', error);
    res.status(500).json({ error: 'Failed to fetch activity history' });
  }
});

module.exports = router;
