const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { initializeFirebase } = require('./lib/firebase');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Firebase
initializeFirebase();

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
const authRoutes = require('./routes/auth');
const generateRoutes = require('./routes/generate');
const moodRoutes = require('./routes/mood');
const activityRoutes = require('./routes/activities');
const journalRoutes = require('./routes/journal');

app.use('/api/auth', authRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/mood', moodRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/journal', journalRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Mental Buddy Backend API'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Mental Buddy Backend API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🤖 Generate endpoint: http://localhost:${PORT}/api/generate`);
  console.log(`🔐 Auth endpoints: http://localhost:${PORT}/api/auth/*`);
  console.log(`😊 Mood endpoints: http://localhost:${PORT}/api/mood/*`);
  console.log(`📝 Journal endpoints: http://localhost:${PORT}/api/journal/*`);
});

module.exports = app;
