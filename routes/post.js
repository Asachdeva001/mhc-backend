const express = require('express');
const router = express.Router();
const { getFirestore, initializeFirebase } = require('../lib/firebase');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const admin = initializeFirebase();

// Initialize Gemini AI for content moderation
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * AI Content Moderation Function
 * Checks for sexual, offensive, harmful, or inappropriate content
 * @param {string} content - The text to moderate
 * @returns {Promise<Object>} - { safe: boolean, reason: string, flaggedContent: string }
 */
const moderateContent = async (content) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const moderationPrompt = `You are a content moderation AI for a mental health support community. Analyze the following text and determine if it contains:

1. Sexual content or explicit material
2. Offensive language (hate speech, slurs, discrimination)
3. Harassment or bullying
4. Spam or promotional content
5. Graphic violence or gore descriptions
6. Content that violates community safety guidelines

IMPORTANT NOTES:
- Mental health discussions about trauma, abuse, depression, anxiety, etc. are ALLOWED and should NOT be flagged
- Mentions of suicide/self-harm in the context of seeking help are ALLOWED (this is a support community)
- Medical terminology related to mental health is ALLOWED
- Expressing negative emotions (anger, sadness, frustration) is ALLOWED
- Only flag content that is clearly inappropriate, offensive, or harmful to others

TEXT TO MODERATE:
"${content}"

RESPOND IN THIS EXACT JSON FORMAT (no other text):
{
  "safe": true/false,
  "reason": "brief explanation if not safe, or empty string if safe",
  "flaggedContent": "the specific problematic phrase/word, or empty string if safe"
}`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: moderationPrompt }] }],
      generationConfig: {
        temperature: 0.1, // Low temperature for consistent moderation
        maxOutputTokens: 200,
      },
    });

    const response = await result.response;
    let responseText = response.text().trim();

    // Remove markdown code blocks if present
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    console.log('🔍 AI Moderation raw response:', responseText);

    // Parse JSON response with error handling
    let moderationResult;
    try {
      moderationResult = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ Failed to parse moderation response:', parseError.message);
      console.error('Raw response was:', responseText);
      // Default to safe if we can't parse
      return {
        safe: true,
        reason: '',
        flaggedContent: '',
        error: 'Moderation response parsing failed'
      };
    }

    console.log('🛡️ Content moderation result:', moderationResult);

    return {
      safe: moderationResult.safe === true,
      reason: moderationResult.reason || '',
      flaggedContent: moderationResult.flaggedContent || ''
    };
  } catch (error) {
    console.error('❌ Content moderation error:', error.message);
    console.error('Full error:', error);
    // Default to safe if moderation fails (don't block users due to technical errors)
    return {
      safe: true,
      reason: '',
      flaggedContent: '',
      error: 'Moderation service temporarily unavailable'
    };
  }
};

/* -------------------------------
   TOKEN VERIFICATION (same as mood.js)
-------------------------------- */
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    try {
      const decoded = Buffer.from(token, 'base64').toString('utf-8');
      const [uid, timestamp] = decoded.split(':');
      if (!uid) throw new Error('Invalid token format');

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

/* -------------------------------
      GET ALL POSTS
-------------------------------- */
router.get('/', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Max 50 per page
    const offset = parseInt(req.query.offset) || 0;

    let query = db.collection('posts').orderBy('timestamp', 'desc');
    
    // Get total count for reference
    const countSnapshot = await query.get();
    const totalCount = countSnapshot.size;

    // Apply pagination
    const snapshot = await query.limit(limit + 1).offset(offset).get();

    const posts = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Only return `limit` posts; if we got more, there are more available
    const hasMore = posts.length > limit;
    if (hasMore) {
      posts.pop(); // Remove the extra post we fetched to check for more
    }

    res.json(posts);
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ error: 'Failed to fetch posts.' });
  }
});

/* -------------------------------
      GET SINGLE POST
-------------------------------- */
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const postRef = db.collection('posts').doc(req.params.id);
    const snap = await postRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Post not found' });
    }

    res.json({ id: snap.id, ...snap.data() });
  } catch (error) {
    console.error('Error getting post:', error);
    res.status(500).json({ error: 'Failed to fetch post.' });
  }
});

/* -------------------------------
        CREATE POST
-------------------------------- */
router.post('/', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const { content, isAnonymous, avatar, tag } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'Post content required.' });
    }

    const contentToCheck = content.trim();

    // AI Content Moderation
    let moderationResult;
    try {
      moderationResult = await moderateContent(contentToCheck);
      
      if (!moderationResult.safe) {
        return res.status(400).json({
          error: 'Content not allowed',
          reason: moderationResult.reason,
          flaggedContent: moderationResult.flaggedContent,
          message: `Your post contains content that violates our community guidelines${moderationResult.flaggedContent ? `: "${moderationResult.flaggedContent}"` : ''}. ${moderationResult.reason}`
        });
      }
    } catch (moderationError) {
      console.error('⚠️ Moderation failed, allowing post:', moderationError.message);
      // Allow post to proceed if moderation fails (don't block users due to technical issues)
    }

    const timestamp = new Date().toISOString();

    const postData = {
      author: isAnonymous ? 'Anonymous' : req.user.name || 'User',
      isAnonymous: !!isAnonymous,
      avatar: isAnonymous ? null : (avatar || (req.user.name ? req.user.name.split(" ").map(n => n[0]).join("") : "")),
      content: contentToCheck,
      timestamp,
      tag: tag || 'General',
      likes: [], // Changed: array of user IDs who liked the post
      comments: [],
      userId: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('posts').add(postData);

    res.json({
      message: 'Post created successfully',
      post: { id: docRef.id, ...postData }
    });
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ error: 'Failed to create post.' });
  }
});

/* -------------------------------
          LIKE POST
-------------------------------- */
router.post('/:id/like', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const postRef = db.collection('posts').doc(req.params.id);
    const userId = req.user.uid;

    await db.runTransaction(async (tx) => {
      const post = await tx.get(postRef);
      if (!post.exists) throw new Error('Post not found');

      const likes = post.data().likes || [];
      // Prevent duplicate likes: only add if user hasn't already liked
      if (!likes.includes(userId)) {
        likes.push(userId);
        tx.update(postRef, { likes });
      }
    });

    res.json({ message: 'Post liked' });
  } catch (error) {
    console.error('Error liking post:', error);
    res.status(500).json({ error: 'Failed to like post.' });
  }
});

/* -------------------------------
        ADD COMMENT / REPLY
-------------------------------- */
router.post('/:id/comment', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const { parentCommentId, replyText, anonymous } = req.body;

    if (!replyText || replyText.trim().length === 0) {
      return res.status(400).json({ error: 'Comment cannot be empty.' });
    }

    // AI Content Moderation for comments (with error handling)
    let moderationResult;
    try {
      moderationResult = await moderateContent(replyText.trim());
      
      if (!moderationResult.safe) {
        return res.status(400).json({
          error: 'Content not allowed',
          reason: moderationResult.reason,
          flaggedContent: moderationResult.flaggedContent,
          message: `Your comment contains content that violates our community guidelines${moderationResult.flaggedContent ? `: "${moderationResult.flaggedContent}"` : ''}. ${moderationResult.reason}`
        });
      }
    } catch (moderationError) {
      console.error('⚠️ Comment moderation failed, allowing comment:', moderationError.message);
      // Allow comment to proceed if moderation fails
    }

    const postRef = db.collection('posts').doc(req.params.id);
    const snap = await postRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const postData = snap.data();
    const comments = postData.comments || [];

    const replyObj = {
      id: Date.now().toString(),
      author: anonymous ? 'Anonymous' : req.user.name || 'User',
      isAnonymous: !!anonymous,
      content: replyText.trim(),
      timestamp: new Date().toISOString(),
      userId: req.user.uid,
      replies: []
    };

    let updatedComments;

    if (!parentCommentId) {
      updatedComments = [...comments, replyObj];
    } else {
      updatedComments = comments.map(c =>
        c.id === parentCommentId
          ? { ...c, replies: [...(c.replies || []), replyObj] }
          : c
      );
    }

    await postRef.update({ comments: updatedComments });

    res.json({
      message: 'Comment added',
      updatedPost: { id: snap.id, ...postData, comments: updatedComments }
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Failed to add comment.' });
  }
});

/* -------------------------------
       DELETE COMMENT / REPLY
-------------------------------- */
router.delete('/:postId/comment/:commentId', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const { postId, commentId } = req.params;
    const postRef = db.collection('posts').doc(postId);

    const snap = await postRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Post not found' });

    const postData = snap.data();
    const comments = postData.comments || [];

    // Check if user owns the comment
    const comment = comments.find(c => c.id === commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.userId !== req.user.uid) return res.status(403).json({ error: 'Not your comment.' });

    // Remove the comment
    const updatedComments = comments.filter(c => c.id !== commentId);
    await postRef.update({ comments: updatedComments });

    res.json({ message: 'Comment deleted', updatedPost: { id: snap.id, ...postData, comments: updatedComments } });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ error: 'Failed to delete comment.' });
  }
});

/* -------------------------------
       DELETE REPLY (nested comment)
-------------------------------- */
router.delete('/:postId/comment/:commentId/reply/:replyId', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const { postId, commentId, replyId } = req.params;
    const postRef = db.collection('posts').doc(postId);

    const snap = await postRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Post not found' });

    const postData = snap.data();
    const comments = postData.comments || [];

    // Find the parent comment and the reply
    let replyFound = false;
    const updatedComments = comments.map(c => {
      if (c.id === commentId) {
        const reply = c.replies?.find(r => r.id === replyId);
        if (reply && reply.userId !== req.user.uid) {
          throw new Error('Not your reply.');
        }
        if (reply) replyFound = true;
        return {
          ...c,
          replies: (c.replies || []).filter(r => r.id !== replyId)
        };
      }
      return c;
    });

    if (!replyFound) return res.status(404).json({ error: 'Reply not found' });

    await postRef.update({ comments: updatedComments });
    res.json({ message: 'Reply deleted', updatedPost: { id: snap.id, ...postData, comments: updatedComments } });
  } catch (error) {
    console.error('Error deleting reply:', error);
    const message = error.message === 'Not your reply.' ? 'Not your reply.' : 'Failed to delete reply.';
    res.status(error.message === 'Not your reply.' ? 403 : 500).json({ error: message });
  }
});

/* -------------------------------
       OPTIONAL: DELETE POST
-------------------------------- */
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const db = getFirestore();
    const postRef = db.collection('posts').doc(req.params.id);

    const snap = await postRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Post not found' });

    // Only allow owner to delete
    if (snap.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Not your post.' });
    }

    await postRef.delete();
    res.json({ message: 'Post deleted' });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ error: 'Failed to delete post.' });
  }
});

module.exports = router;
