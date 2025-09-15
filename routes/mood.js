const express = require('express');
const router = express.Router();
const { getFirestore, initializeFirebase } = require('../lib/firebase');

const admin = initializeFirebase();

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

// Log a mood entry
router.post('/log', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    
    const { mood, note, energy, stress, sleep } = req.body;

    if (!mood || mood < 1 || mood > 10) {
      return res.status(400).json({ error: 'Mood must be between 1 and 10' });
    }

    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0];

    // Check if user already has a mood entry for today
    const todayQuery = await db
      .collection('moodEntries')
      .where('userId', '==', req.user.uid)
      .where('date', '==', date)
      .get();

    let moodEntry;
    if (todayQuery.empty) {
      // Create new entry
      moodEntry = {
        userId: req.user.uid,
        mood: parseInt(mood),
        note: note || '',
        energy: energy ? parseInt(energy) : null,
        stress: stress ? parseInt(stress) : null,
        sleep: sleep ? parseInt(sleep) : null,
        date,
        timestamp,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const docRef = await db.collection('moodEntries').add(moodEntry);
      moodEntry.id = docRef.id;
    } else {
      // Update existing entry
      const existingDoc = todayQuery.docs[0];
      moodEntry = {
        id: existingDoc.id,
        ...existingDoc.data(),
        mood: parseInt(mood),
        note: note || '',
        energy: energy ? parseInt(energy) : existingDoc.data().energy,
        stress: stress ? parseInt(stress) : existingDoc.data().stress,
        sleep: sleep ? parseInt(sleep) : existingDoc.data().sleep,
        timestamp,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection('moodEntries').doc(existingDoc.id).update({
        mood: moodEntry.mood,
        note: moodEntry.note,
        energy: moodEntry.energy,
        stress: moodEntry.stress,
        sleep: moodEntry.sleep,
        timestamp: moodEntry.timestamp,
        updatedAt: moodEntry.updatedAt,
      });
    }

    res.json({
      message: 'Mood entry saved successfully',
      moodEntry,
    });
  } catch (error) {
    console.error('Error logging mood entry:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's mood entries
router.get('/entries', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const { limit = 30, startDate, endDate } = req.query;
    
    let query = db
      .collection('moodEntries')
      .where('userId', '==', req.user.uid)
      .orderBy('date', 'desc')
      .limit(parseInt(limit));

    // Add date filters if provided
    if (startDate) {
      query = query.where('date', '>=', startDate);
    }
    if (endDate) {
      query = query.where('date', '<=', endDate);
    }

    const moodEntries = await query.get();
    
    const entries = moodEntries.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    res.json(entries);
  } catch (error) {
    console.error('Error fetching mood entries:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get mood statistics/insights
router.get('/insights', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const { days = 7 } = req.query;
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - parseInt(days));
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    // Get mood entries for the specified period
    const moodEntries = await db
      .collection('moodEntries')
      .where('userId', '==', req.user.uid)
      .where('date', '>=', startDateStr)
      .where('date', '<=', endDateStr)
      .orderBy('date', 'desc')
      .get();
    
    const entries = moodEntries.docs.map(doc => doc.data());
    
    // Calculate insights
    const insights = {
      totalEntries: entries.length,
      averageMood: 0,
      moodTrend: 'stable',
      currentStreak: 0,
      longestStreak: 0,
      averageEnergy: 0,
      averageStress: 0,
      averageSleep: 0,
      moodDistribution: {
        low: 0,    // 1-3
        medium: 0, // 4-6
        high: 0    // 7-10
      }
    };
    
    if (entries.length > 0) {
      // Calculate averages
      const moodSum = entries.reduce((sum, entry) => sum + entry.mood, 0);
      insights.averageMood = Math.round((moodSum / entries.length) * 10) / 10;
      
      const energySum = entries.reduce((sum, entry) => sum + (entry.energy || 0), 0);
      const energyCount = entries.filter(entry => entry.energy).length;
      insights.averageEnergy = energyCount > 0 ? Math.round((energySum / energyCount) * 10) / 10 : 0;
      
      const stressSum = entries.reduce((sum, entry) => sum + (entry.stress || 0), 0);
      const stressCount = entries.filter(entry => entry.stress).length;
      insights.averageStress = stressCount > 0 ? Math.round((stressSum / stressCount) * 10) / 10 : 0;
      
      const sleepSum = entries.reduce((sum, entry) => sum + (entry.sleep || 0), 0);
      const sleepCount = entries.filter(entry => entry.sleep).length;
      insights.averageSleep = sleepCount > 0 ? Math.round((sleepSum / sleepCount) * 10) / 10 : 0;
      
      // Calculate mood distribution
      entries.forEach(entry => {
        if (entry.mood <= 3) insights.moodDistribution.low++;
        else if (entry.mood <= 6) insights.moodDistribution.medium++;
        else insights.moodDistribution.high++;
      });
      
      // Calculate mood trend
      if (entries.length >= 2) {
        const recent = entries.slice(0, Math.min(3, entries.length));
        const older = entries.slice(Math.min(3, entries.length));
        
        const recentAvg = recent.reduce((sum, entry) => sum + entry.mood, 0) / recent.length;
        const olderAvg = older.length > 0 ? older.reduce((sum, entry) => sum + entry.mood, 0) / older.length : recentAvg;
        
        if (recentAvg > olderAvg + 0.5) insights.moodTrend = 'improving';
        else if (recentAvg < olderAvg - 0.5) insights.moodTrend = 'declining';
      }
      
      // Calculate current streak (consecutive days with entries)
      const sortedEntries = entries.sort((a, b) => new Date(b.date) - new Date(a.date));
      let currentStreak = 0;
      let longestStreak = 0;
      let tempStreak = 0;
      
      for (let i = 0; i < sortedEntries.length; i++) {
        const entryDate = new Date(sortedEntries[i].date);
        const expectedDate = new Date();
        expectedDate.setDate(expectedDate.getDate() - i);
        
        if (entryDate.toDateString() === expectedDate.toDateString()) {
          currentStreak = i + 1;
          tempStreak++;
          longestStreak = Math.max(longestStreak, tempStreak);
        } else {
          tempStreak = 0;
        }
      }
      
      insights.currentStreak = currentStreak;
      insights.longestStreak = longestStreak;
    }
    
    res.json(insights);
  } catch (error) {
    console.error('Error calculating mood insights:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get today's mood entry
router.get('/today', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const today = new Date().toISOString().split('T')[0];
    
    const todayQuery = await db
      .collection('moodEntries')
      .where('userId', '==', req.user.uid)
      .where('date', '==', today)
      .get();
    
    if (todayQuery.empty) {
      return res.json({ hasEntry: false, moodEntry: null });
    }
    
    const moodEntry = {
      id: todayQuery.docs[0].id,
      ...todayQuery.docs[0].data()
    };
    
    res.json({ hasEntry: true, moodEntry });
  } catch (error) {
    console.error('Error fetching today\'s mood entry:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
