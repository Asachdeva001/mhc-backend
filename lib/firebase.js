const admin = require("firebase-admin");

let app;

function initializeFirebase() {
  if (!app) {
    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }
  return admin;
}

function getFirestore() {
  if (!admin.apps.length) {
    throw new Error("Firebase not initialized. Call initializeFirebase first.");
  }
  return admin.firestore();
}

// Log conversation to Firestore
const logConversation = async (userId, inputMessage, outputResponse, crisis = false) => {
  try {
    const db = getFirestore();
    const timestamp = new Date().toISOString();
    
    await db.collection('conversations').add({
      userId,
      inputMessage,
      outputResponse,
      crisis,
      timestamp,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    console.log('Conversation logged successfully');
  } catch (error) {
    console.error('Error logging conversation:', error);
  }
};

module.exports = { initializeFirebase, getFirestore, logConversation };
