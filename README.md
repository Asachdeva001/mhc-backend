# Mental Buddy Backend API

A secure backend API for the Mental Buddy wellness application, providing OpenAI integration, Firebase authentication, and conversation logging.

## Features

- 🤖 **OpenAI Integration**: GPT-4o model with multimodal support (text + images)
- 🔐 **Firebase Authentication**: Secure user authentication and profile management
- 🚨 **Crisis Detection**: Automatic detection of high-risk messages with helpline resources
- 📝 **Conversation Logging**: All conversations logged to Firestore for analysis
- 🛡️ **Security**: Token-based authentication and CORS protection

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Environment Configuration**:
   - Copy `env.example` to `.env`
   - Fill in your API keys and configuration:
     - Gemini API key
     - Firebase service account credentials

3. **Start the server**:
   ```bash
   # Development mode with auto-reload
   npm run dev
   
   # Production mode
   npm start
   ```

## API Endpoints

### Generate Response
- **POST** `/api/generate`
- Generates empathetic AI responses using OpenAI GPT-4o
- Supports both text and image inputs
- Automatic crisis detection

**Request Body**:
```json
{
  "message": "I feel stressed today",
  "messages": [
    {"role": "user", "content": "Previous message"},
    {"role": "assistant", "content": "Previous response"}
  ],
  "imageUrl": "https://example.com/image.jpg", // optional
  "userId": "user123" // optional, defaults to 'anonymous'
}
```

**Response**:
```json
{
  "reply": "I understand you're feeling stressed. Would you like to try a breathing exercise?",
  "crisis": false,
  "timestamp": "2025-09-13T09:34:00Z"
}
```

### Authentication Routes
- **GET** `/api/auth/profile` - Get user profile
- **PUT** `/api/auth/profile` - Update user profile  
- **GET** `/api/auth/conversations` - Get conversation history

### Health Check
- **GET** `/health` - Server health status

## Crisis Detection

The API automatically detects crisis situations and responds with:
- Supportive message
- India helpline: `1800-599-0019`
- International helpline: `https://findahelpline.com/`
- Crisis flag set to `true`

## Environment Variables

See `env.example` for all required environment variables.

## Security

- Firebase token verification for authenticated routes
- CORS protection
- Input validation and sanitization
- Error handling without sensitive data exposure
# mhc-backend
