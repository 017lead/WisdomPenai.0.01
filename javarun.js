import express from 'express';
import OpenAI from "openai";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import multer from 'multer';
import NodeCache from 'node-cache';
import { randomUUID } from 'crypto'; // Import for generating unique session IDs

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(cors());

// Initialize cache with a TTL of 1 hour (3600 seconds)
const cache = new NodeCache({
  stdTTL: 3600, // Cache TTL in seconds
  checkperiod: 120, // Check for expired items every 2 minutes
});

// Configure multer for file uploads (max 5MB, up to 5 files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).array('files', 5);

// Initialize OpenAI client
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing API key in environment (OPENAI_API_KEY)');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });
// Keep constant if you still rely on this value elsewhere; Responses API doesn't require an assistant id.
const ASSISTANT_ID = "asst_GZR3yTrT76O0DVIhrIT7wIzT"; // kept for compatibility, not used by Responses API

// Map to store sessionId to conversationId mappings
const sessionConversations = new Map();

// Create a conversation to use for sessions (store its id)
async function createConversation() {
  // Conversations API — creates an empty conversation. We'll store id and use it in responses.create calls.
  const conv = await openai.conversations.create({
    metadata: { created_by: 'express-server' }
  });
  return conv;
}

// Endpoint to start a new conversation
app.post('/start-conversation', async (req, res) => {
  try {
    const sessionId = randomUUID();
    const conversationId = randomUUID(); // client-side conversation id

    sessionConversations.set(sessionId, conversationId);

    res.json({ sessionId });
  } catch (error) {
    console.error(`Error in /start-conversation: ${error.message}`);
    res.status(500).json({ error: 'Failed to start conversation' });
  }
});


// Helper to stream a Responses API call to the SSE connection
async function streamResponseToSSE({ openaiClient, resSSE, requestPayload, cacheKey }) {
  // requestPayload should include: model, input, conversation (optional), stream:true
  const stream = await openaiClient.responses.create({ ...requestPayload, stream: true });

  let fullResponse = '';
  const responseChunks = [];

  try {
    for await (const event of stream) {
      // Console-log for debugging (can be removed in production)
      // console.log('stream event:', event);

      // Common streaming event types: response.created, response.output_text.delta, response.error, response.completed
      if (event.type === 'response.output_text.delta' || event.type === 'response.delta') {
        // Try to extract delta text forgivingly across possible shapes
        let deltaText = '';

        // Some event shapes put the text in event.delta (string or object), other shapes use event.delta.content arrays
        if (typeof event.delta === 'string') {
          deltaText = event.delta;
        } else if (event.delta) {
          // If content is present it may be an array of items
          if (Array.isArray(event.delta.content)) {
            for (const c of event.delta.content) {
              if (typeof c === 'string') deltaText += c;
              else if (c?.text) deltaText += (c.text.value ?? c.text);
              else if (c?.type === 'output_text' && c?.text) deltaText += c.text;
              else if (c?.type === 'message' && c?.text) deltaText += c.text;
            }
          } else if (event.delta.content && typeof event.delta.content === 'string') {
            deltaText = event.delta.content;
          } else if (event.delta.text) {
            deltaText = (event.delta.text.value ?? event.delta.text);
          } else if (event.delta.output_text) {
            deltaText = (event.delta.output_text.value ?? event.delta.output_text);
          }
        }

        if (deltaText) {
          // send incremental chunk to client
          resSSE.write(`data: ${deltaText}\n\n`);
          fullResponse += deltaText;
          responseChunks.push(deltaText);
        }
      } else if (event.type === 'response.created') {
        // optionally handle response.created (contains response.id etc)
        // const responseId = event.response?.id;
      } else if (event.type === 'response.error') {
        const errMsg = event.error?.message ?? 'Unknown error from streaming response';
        resSSE.write(`data: Error: ${errMsg}\n\n`);
      } else if (event.type === 'response.completed') {
        // finished — we break after loop naturally
      } else {
        // ignore other event types or log if needed
        // console.log('Unhandled event type', event.type);
      }
    }

    // Streaming finished
    resSSE.write(`data: [END]\n\n`);
    resSSE.end();

    // Save to cache if provided
    if (cacheKey) {
      cache.set(cacheKey, responseChunks);
    }

    return fullResponse;
  } catch (err) {
    // On any iteration error, attempt to notify client and rethrow
    try {
      resSSE.write(`data: Error: ${err.message}\n\n`);
      resSSE.write(`data: [END]\n\n`);
      resSSE.end();
    } catch (e) {
      // ignore SSE errors
    }
    throw err;
  }
}

// Chat endpoint with streaming and per-session caching
app.post('/chat', upload, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    // Get session ID from request body
    const sessionId = req.body.sessionId;
    if (!sessionId || !sessionConversations.has(sessionId)) {
      res.write(`data: Error: Invalid or missing sessionId\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    const conversationId = sessionConversations.get(sessionId); // Retrieve conversation ID for this session
    const userMessage = req.body.message || '';
    const files = req.files || [];

    // Include sessionId in cache key to make caching per-session
    const cacheKey = `chat_${sessionId}_${userMessage}_${files.map(f => f.originalname).join('_')}`;

    // Check cache first
    const cachedResponse = cache.get(cacheKey);
    if (cachedResponse) {
      console.log(`Cache hit for key: ${cacheKey}`);
      for (const chunk of cachedResponse) {
        res.write(`data: ${chunk}\n\n`);
      }
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    if (!userMessage && files.length === 0) {
      res.write(`data: Please provide a message or files\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    // If there's an image file, convert to data URL and include as image input in the Responses call
    if (files.length > 0) {
      const hasImage = files.some(file => file.mimetype.startsWith('image/'));
      if (hasImage) {
        const imageFile = files.find(file => file.mimetype.startsWith('image/'));
        const base64Image = imageFile.buffer.toString('base64');
        const imageUrl = `data:${imageFile.mimetype};base64,${base64Image}`;

        const inputMessage = [
          {
            role: 'user',
            content: [
              { type: 'text', text: userMessage || 'Describe this image' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ];

        // Stream the Responses API output to the client
        await streamResponseToSSE({
          openaiClient: openai,
          resSSE: res,
          requestPayload: {
            model: 'gpt-5',
            input: inputMessage,
            conversation: conversationId, // attach to conversation
            // optionally configure reasoning effort for gpt-5 models, e.g. reasoning: { effort: 'medium' }
          },
          cacheKey,
        });

        // After final response, optionally store the user message in the conversation as a conversation item:
        // (Conversations are auto-populated server-side, but storing explicit message objects can help.)
        try {
          await openai.conversations.update({
            id: conversationId,
            items: [
              {
                type: 'message',
                role: 'user',
                content: userMessage || 'Image uploaded',
              },
              {
                type: 'message',
                role: 'assistant',
                content: fullTextOrEmpty()
              }
            ]
          });
        } catch (e) {
          // not critical; ignore if update not allowed
        }

        return;
      } else {
        // Non-image files: upload to files endpoint (kept similar to original)
        const uploadedFile = await openai.files.create({
          file: files[0].buffer,
          purpose: 'assistants', // preserved from original; adapt if necessary for Responses-file workflows
        });

        // create a minimal text prompt describing the file to the model and stream the response
        const inputMessage = [
          {
            role: 'user',
            content: [
              { type: 'text', text: userMessage || 'File uploaded' },
              { type: 'input_file', file: { id: uploadedFile.id, filename: files[0].originalname } }
            ]
          }
        ];

        await streamResponseToSSE({
          openaiClient: openai,
          resSSE: res,
          requestPayload: {
            model: 'gpt-5',
            input: inputMessage,
            conversation: conversationId,
          },
          cacheKey,
        });

        return;
      }
    } else {
      // No files — just a text message
      const inputMessage = [
        {
          role: 'user',
          content: userMessage,
        },
      ];

      await streamResponseToSSE({
        openaiClient: openai,
        resSSE: res,
        requestPayload: {
          model: 'gpt-5',
          input: inputMessage,
          conversation: conversationId,
        },
        cacheKey,
      });

      return;
    }
  } catch (error) {
    console.error(`Error in /chat: ${error.message}`);
    try {
      res.write(`data: Error: ${error.message}\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
    } catch (e) {
      // ignore SSE errors
    }
  }
});

// Source extraction endpoint with temporary conversations and caching
app.post('/extract-sources', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    const message = req.body.message || '';
    const cacheKey = `extract-sources_${message}`;

    // Check cache first
    const cachedResponse = cache.get(cacheKey);
    if (cachedResponse) {
      console.log(`Cache hit for key: ${cacheKey}`);
      for (const source of cachedResponse) {
        res.write(`data: ${source}\n\n`);
      }
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    if (!message) {
      res.write(`data: Error: No message provided for source extraction\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    // Create a temporary conversation
    const tempConv = await openai.conversations.create({
      metadata: { purpose: 'extract-sources', created_at: Date.now().toString() }
    });

    // Build a focused instruction for the model
    const prompt = `Extract all Quran verses and Hadith references from the following text. Return ONLY the complete references in the format: "Quran X:Y" for Quran references (where X is the Surah number and Y is the verse number or range, e.g., "Quran 1:1" or "Quran 2:255-256"), and "Hadith [Collection] X:Y" for Hadith references (e.g., "Hadith Bukhari 1:100"). For named Surahs (e.g., "Surah Al-Fatihah"), convert them to their numerical form (e.g., "Quran 1"). Output each reference on a new line. If no references are found, return an empty response with no text. Text: ${message}`;

    // Use Responses.create (non-streaming) to get final output
    const response = await openai.responses.create({
      model: 'gpt-5',
      input: [
        { role: 'user', content: prompt }
      ],
      conversation: tempConv.id,
      // not streaming here — we want the final output
    });

    const assistantText = response.output_text ?? '';
    const sources = (assistantText || '').trim().split('\n').map(s => s.trim()).filter(line =>
      line.match(/^Quran \d+:\d+(?:-\d+)?$/) ||
      line.match(/^Hadith [A-Za-z]+ \d+:\d+$/)
    );

    for (let source of sources) {
      res.write(`data: ${source}\n\n`);
    }
    res.write(`data: [END]\n\n`);
    res.end();

    cache.set(cacheKey, sources);
  } catch (error) {
    console.error(`Error in /extract-sources: ${error.message}`);
    res.write(`data: Error: ${error.message}\n\n`);
    res.write(`data: [END]\n\n`);
    res.end();
  }
});

// Health check endpoint (uses a simple Responses API call to verify API + model)
app.get('/health', async (req, res) => {
  try {
    // Quick smoke test: ask the model to return "ok" (non-streaming)
    const healthResp = await openai.responses.create({
      model: 'gpt-5.2',
      input: "Say ok"
    });

    res.json({
      status: 'healthy',
      assistant_id: ASSISTANT_ID,
      model_used: 'gpt-5.2',
      api_ok: !!healthResp,
      sample_output: healthResp.output_text?.slice(0, 200) ?? '',
      features: {
        image_analysis: true,
        file_upload: true,
        cache_enabled: true,
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: `Failed to reach Responses API: ${error.message}`
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Using assistant ID (kept): ${ASSISTANT_ID}`);
});

