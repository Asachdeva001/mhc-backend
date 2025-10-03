const admin = require("firebase-admin");

let app;

function initializeFirebase() {
  if (!app) {
    // Check if Firebase credentials are available
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
      console.warn('⚠️ Firebase credentials not found. Some features may not work properly.');
      return null;
    }

    try {
      app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
      console.log('✅ Firebase initialized successfully');
    } catch (error) {
      console.error('❌ Firebase initialization failed:', error);
      return null;
    }
  }
  return admin;
}

function getFirestore() {
  if (!admin.apps.length) {
    console.error("Firebase not initialized. Call initializeFirebase first.");
    return null;
  }
  return admin.firestore();
}

// Log conversation to Firestore (handles encrypted messages)
const logConversation = async (userId, inputMessage, outputResponse, crisis = false) => {
  try {
    const db = getFirestore();
    if (!db) {
      console.warn('Firestore not available. Skipping conversation log.');
      return;
    }

    const timestamp = new Date().toISOString();
    
    // Check if messages are encrypted (they will be objects with encryptedData property)
    const isInputEncrypted = typeof inputMessage === 'object' && inputMessage.encryptedData;
    const isOutputEncrypted = typeof outputResponse === 'object' && outputResponse.encryptedData;
    
    await db.collection('conversations').add({
      userId,
      inputMessage: isInputEncrypted ? inputMessage : { text: inputMessage, encrypted: false },
      outputResponse: isOutputEncrypted ? outputResponse : { text: outputResponse, encrypted: false },
      crisis,
      timestamp,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    console.log('Conversation logged successfully (encrypted:', isInputEncrypted || isOutputEncrypted, ')');
  } catch (error) {
    console.error('Error logging conversation:', error);
  }
};

module.exports = { initializeFirebase, getFirestore, logConversation };
