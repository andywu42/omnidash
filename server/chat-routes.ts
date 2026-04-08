import { Router } from 'express';

export const chatRouter = Router();

/**
 * Chat History API
 *
 * Returns empty chat history until a real chat backend is wired.
 * Fabricated demo messages removed in OMN-7730.
 */

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ChatHistoryResponse {
  messages: ChatMessage[];
}

// GET /api/chat/history
// Returns empty chat history (no backend wired yet)
chatRouter.get('/history', (_req, res) => {
  const response: ChatHistoryResponse = { messages: [] };
  res.json(response);
});

// POST /api/chat/send
// Send a new message (placeholder for future implementation)
chatRouter.post('/send', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Message field is required and must be a string',
      });
    }

    // TODO(OMN-6111): Implement message sending to chat service
    // TODO(OMN-6111): Store message in database
    // TODO(OMN-6111): Get AI response
    // TODO(OMN-6111): Store AI response in database

    res.status(501).json({
      error: 'Not implemented',
      message:
        'Message sending functionality is not yet implemented. Integration with LLM backend pending.',
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      error: 'Failed to send message',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
