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

// PUT /profile - Update user profile (name, bio, details)
router.put('/profile', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { name, bio, avatarUrl, preferences } = req.body;

    // Build update object - only include fields that were provided
    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (name !== undefined && name.trim()) {
      updates.name = name.trim();
      // Also update Firebase Auth displayName
      try {
        await admin.auth().updateUser(req.user.uid, {
          displayName: name.trim(),
        });
      } catch (authError) {
        console.error('Error updating Firebase Auth displayName:', authError);
        // Continue with Firestore update even if Auth update fails
      }
    }

    if (bio !== undefined) {
      updates.bio = bio.trim();
    }

    if (avatarUrl !== undefined) {
      updates.avatarUrl = avatarUrl.trim();
    }

    if (preferences !== undefined && typeof preferences === 'object') {
      updates.preferences = preferences;
    }

    // Validation: ensure at least one field is being updated
    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Update user document in Firestore
    const userRef = db.collection('users').doc(req.user.uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      // Create user document if it doesn't exist
      await userRef.set({
        uid: req.user.uid,
        email: req.user.email,
        ...updates,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await userRef.update(updates);
    }

    // Fetch updated user profile
    const updatedDoc = await userRef.get();
    const updatedProfile = {
      ...updatedDoc.data(),
      updatedAt: updatedDoc.data().updatedAt?.toDate().toISOString() || null,
      createdAt: updatedDoc.data().createdAt?.toDate().toISOString() || null,
    };

    res.json({
      message: 'Profile updated successfully',
      profile: updatedProfile,
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /password - Update user password (Firebase Auth)
router.put('/password', verifyToken, async (req, res) => {
  try {
    const { newPassword } = req.body;

    // Validation
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ 
        error: 'Password must be at least 6 characters long' 
      });
    }

    // Additional password strength validation
    if (newPassword.length > 128) {
      return res.status(400).json({ 
        error: 'Password must be less than 128 characters' 
      });
    }

    // Update password in Firebase Auth
    try {
      await admin.auth().updateUser(req.user.uid, {
        password: newPassword,
      });

      res.json({
        message: 'Password updated successfully',
        notice: 'Please sign in again with your new password',
      });
    } catch (authError) {
      console.error('Firebase Auth password update error:', authError);
      
      if (authError.code === 'auth/weak-password') {
        return res.status(400).json({ error: 'Password is too weak' });
      }
      
      return res.status(500).json({ 
        error: 'Failed to update password',
        message: authError.message 
      });
    }
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /conversations - Delete all chat conversations for the user
router.delete('/conversations', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    // Query all conversations for this user (correct collection name: chatConversations)
    const conversationsQuery = await db.collection('chatConversations')
      .where('userId', '==', req.user.uid)
      .get();

    if (conversationsQuery.empty) {
      return res.json({
        message: 'No chat history found',
        deletedCount: 0,
      });
    }

    // Batch delete for efficiency (Firestore batch supports up to 500 operations)
    const batchSize = 500;
    const batches = [];
    let currentBatch = db.batch();
    let operationCount = 0;
    let totalDeleted = 0;

    conversationsQuery.docs.forEach((doc) => {
      currentBatch.delete(doc.ref);
      operationCount++;
      totalDeleted++;

      // If we've reached the batch size limit, save this batch and start a new one
      if (operationCount >= batchSize) {
        batches.push(currentBatch);
        currentBatch = db.batch();
        operationCount = 0;
      }
    });

    // Add the last batch if it has operations
    if (operationCount > 0) {
      batches.push(currentBatch);
    }

    // Commit all batches
    await Promise.all(batches.map(batch => batch.commit()));

    res.json({
      message: 'All chat history deleted successfully',
      deletedCount: totalDeleted,
    });
  } catch (error) {
    console.error('Error deleting conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /journals - Delete all journal entries for the user
router.delete('/journals', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    // Query all journal entries for this user
    const journalsQuery = await db.collection('journalEntries')
      .where('userId', '==', req.user.uid)
      .get();

    if (journalsQuery.empty) {
      return res.json({
        message: 'No journal entries found',
        deletedCount: 0,
      });
    }

    // Batch delete for efficiency (Firestore batch supports up to 500 operations)
    const batchSize = 500;
    const batches = [];
    let currentBatch = db.batch();
    let operationCount = 0;
    let totalDeleted = 0;

    journalsQuery.docs.forEach((doc) => {
      currentBatch.delete(doc.ref);
      operationCount++;
      totalDeleted++;

      // If we've reached the batch size limit, save this batch and start a new one
      if (operationCount >= batchSize) {
        batches.push(currentBatch);
        currentBatch = db.batch();
        operationCount = 0;
      }
    });

    // Add the last batch if it has operations
    if (operationCount > 0) {
      batches.push(currentBatch);
    }

    // Commit all batches
    await Promise.all(batches.map(batch => batch.commit()));

    res.json({
      message: 'All journal entries deleted successfully',
      deletedCount: totalDeleted,
    });
  } catch (error) {
    console.error('Error deleting journals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /account - Delete user account (DANGER: Irreversible)
router.delete('/account', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const { confirmEmail } = req.body;

    // Safety check: require email confirmation
    if (confirmEmail !== req.user.email) {
      return res.status(400).json({ 
        error: 'Email confirmation does not match',
        message: 'Please provide your email address to confirm account deletion'
      });
    }

    // Step 1: Delete all user data from Firestore collections
    const deletionTasks = [];

    // Delete conversations (correct collection name: chatConversations)
    const conversationsQuery = await db.collection('chatConversations')
      .where('userId', '==', req.user.uid)
      .get();
    
    if (!conversationsQuery.empty) {
      const conversationsBatch = db.batch();
      conversationsQuery.docs.forEach(doc => conversationsBatch.delete(doc.ref));
      deletionTasks.push(conversationsBatch.commit());
    }

    // Delete journal entries
    const journalsQuery = await db.collection('journalEntries')
      .where('userId', '==', req.user.uid)
      .get();
    
    if (!journalsQuery.empty) {
      const journalsBatch = db.batch();
      journalsQuery.docs.forEach(doc => journalsBatch.delete(doc.ref));
      deletionTasks.push(journalsBatch.commit());
    }

    // Delete mood entries
    const moodQuery = await db.collection('moodEntries')
      .where('userId', '==', req.user.uid)
      .get();
    
    if (!moodQuery.empty) {
      const moodBatch = db.batch();
      moodQuery.docs.forEach(doc => moodBatch.delete(doc.ref));
      deletionTasks.push(moodBatch.commit());
    }

    // Delete activity logs (if collection exists)
    const activityQuery = await db.collection('activities')
      .where('userId', '==', req.user.uid)
      .get();
    
    if (!activityQuery.empty) {
      const activityBatch = db.batch();
      activityQuery.docs.forEach(doc => activityBatch.delete(doc.ref));
      deletionTasks.push(activityBatch.commit());
    }

    // Delete user document
    deletionTasks.push(db.collection('users').doc(req.user.uid).delete());

    // Wait for all Firestore deletions to complete
    await Promise.all(deletionTasks);

    // Step 2: Delete user from Firebase Auth
    await admin.auth().deleteUser(req.user.uid);

    res.json({
      message: 'Account deleted successfully',
      notice: 'All your data has been permanently removed',
    });
  } catch (error) {
    console.error('Error deleting account:', error);
    
    // If there's an error, provide detailed feedback
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({ 
        error: 'User not found in authentication system' 
      });
    }
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to delete account. Please try again or contact support.'
    });
  }
});

// GET /profile - Get user profile
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    if (!db) {
      return res.status(503).json({ error: 'Database not available. Please check Firebase configuration.' });
    }

    const userDoc = await db.collection('users').doc(req.user.uid).get();
    
    if (!userDoc.exists) {
      // Return basic info from Firebase Auth if Firestore doc doesn't exist
      return res.json({
        uid: req.user.uid,
        email: req.user.email,
        name: req.user.name,
        createdAt: null,
        updatedAt: null,
      });
    }

    const profile = {
      ...userDoc.data(),
      createdAt: userDoc.data().createdAt?.toDate().toISOString() || null,
      updatedAt: userDoc.data().updatedAt?.toDate().toISOString() || null,
    };

    res.json(profile);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
