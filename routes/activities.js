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

// Get all wellness activities (simplified: no mood/history filtering)
router.get('/today', verifyToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // All available activities (6 remaining after removing 5)
    
    const allActivities = [
      { id: 'breathing-exercise', title: '5-Minute Breathing Exercise', description: 'Practice deep breathing to reduce stress and anxiety', category: 'Mindfulness', difficulty: 'Easy' },
      { id: 'meditation', title: 'Guided Meditation', description: 'Listen to a calming meditation session', category: 'Mindfulness', difficulty: 'Medium' },
      { id: 'doodle', title: 'Free-form Doodling', description: 'Let your creativity flow with simple drawing', category: 'Creative', difficulty: 'Easy' },
      { id: 'music-listening', title: 'Music Therapy', description: 'Listen to music that matches or improves your mood', category: 'Creative', difficulty: 'Easy' },
      { id: 'stretching', title: 'Gentle Stretching', description: 'Release tension with simple stretches', category: 'Physical', difficulty: 'Easy' },
      { id: 'dance-break', title: 'Dance Break', description: 'Put on your favorite song and move your body', category: 'Physical', difficulty: 'Easy' }
    ];
    
    // Check which activities were completed today
    const todayActivities = await db
      .collection('activities')
      .where('userId', '==', req.user.uid)
      .where('date', '==', today)
      .get();

    const completedActivityIds = todayActivities.docs.map(doc => doc.data().activityId);
    
    // Mark completed activities
    const activitiesWithStatus = allActivities.map(activity => ({
      ...activity,
      completed: completedActivityIds.includes(activity.id)
    }));

    res.json(activitiesWithStatus);
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

// Save activity session state (auto-save when activity is paused or ongoing)
router.post('/session/save', verifyToken, async (req, res) => {
  try {
    const { activityId, sessionId, timeRemaining, totalTime, isPaused, timestamp } = req.body;
    
    if (!activityId || !sessionId) {
      return res.status(400).json({ error: 'Activity ID and Session ID are required' });
    }

    const today = new Date().toISOString().split('T')[0];
    
    // Upsert: Try to update existing session, create if doesn't exist
    const sessionKey = `${today}_${activityId}_${sessionId}`;
    
    await db.collection('activitySessions').doc(sessionKey).set({
      userId: req.user.uid,
      activityId,
      sessionId,
      timeRemaining,
      totalTime,
      isPaused,
      date: today,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      savedAtClient: new Date(timestamp),
    }, { merge: true });

    res.json({ success: true, message: 'Activity session saved' });
  } catch (error) {
    console.error('Error saving activity session:', error);
    res.status(500).json({ error: 'Failed to save activity session' });
  }
});

// Retrieve the latest activity session
router.get('/session/:activityId', verifyToken, async (req, res) => {
  try {
    const { activityId } = req.params;
    const today = new Date().toISOString().split('T')[0];

    // Get the most recent session for this activity today
    const sessions = await db.collection('activitySessions')
      .where('userId', '==', req.user.uid)
      .where('activityId', '==', activityId)
      .where('date', '==', today)
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();

    if (sessions.empty) {
      return res.json({ exists: false });
    }

    const sessionData = sessions.docs[0].data();
    res.json({
      exists: true,
      sessionId: sessionData.sessionId,
      timeRemaining: sessionData.timeRemaining,
      totalTime: sessionData.totalTime,
      isPaused: sessionData.isPaused,
      savedAt: sessionData.updatedAt,
    });
  } catch (error) {
    console.error('Error retrieving activity session:', error);
    res.status(500).json({ error: 'Failed to retrieve activity session' });
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

    // Clean up the session record for this activity
    const sessionsSnapshot = await db.collection('activitySessions')
      .where('userId', '==', req.user.uid)
      .where('activityId', '==', activityId)
      .where('date', '==', today)
      .get();

    const batch = db.batch();
    sessionsSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

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
