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
const ASSISTANT_ID = "asst_GZR3yTrT76O0DVIhrIT7wIzT"; // Replace with your actual assistant ID

// Map to store sessionId to threadId mappings
const sessionThreads = new Map();

// Verify assistant exists
async function verifyAssistant() {
  try {
    const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    console.log(`Assistant Verified: ID: ${assistant.id}, Name: ${assistant.name}`);
    return true;
  } catch (error) {
    console.error(`Failed to verify assistant ${ASSISTANT_ID}: ${error.message}`);
    process.exit(1);
  }
}

verifyAssistant().then(() => console.log('Assistant verification completed'));

// Endpoint to start a new conversation
app.post('/start-conversation', async (req, res) => {
  try {
    const sessionId = randomUUID(); // Generate a unique session ID
    const thread = await openai.beta.threads.create(); // Create a new thread
    sessionThreads.set(sessionId, thread.id); // Map session ID to thread ID
    res.json({ sessionId }); // Return the session ID to the client
  } catch (error) {
    console.error(`Error in /start-conversation: ${error.message}`);
    res.status(500).json({ error: 'Failed to start conversation' });
  }
});

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
    if (!sessionId || !sessionThreads.has(sessionId)) {
      res.write(`data: Error: Invalid or missing sessionId\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    const threadId = sessionThreads.get(sessionId); // Retrieve thread ID for this session
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

    let responseChunks = [];

    if (files.length > 0) {
      const hasImage = files.some(file => file.mimetype.startsWith('image/'));
      if (hasImage) {
        const imageFile = files.find(file => file.mimetype.startsWith('image/'));
        const base64Image = imageFile.buffer.toString('base64');
        const imageUrl = `data:${imageFile.mimetype};base64,${base64Image}`;

        const messages = [
          {
            role: 'user',
            content: [
              { type: 'text', text: userMessage || 'Describe this image' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ];

        const stream = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 300,
          stream: true,
        });

        let fullResponse = '';
        for await (const chunk of stream) {
          const delta = chunk.choices[0].delta.content;
          if (delta) {
            res.write(`data: ${delta}\n\n`);
            fullResponse += delta;
            responseChunks.push(delta);
          }
        }
        res.write(`data: [END]\n\n`);
        res.end();

        // Add messages to the session’s thread for conversation history
        await openai.beta.threads.messages.create(threadId, {
          role: 'user',
          content: userMessage || 'Image uploaded',
        });
        await openai.beta.threads.messages.create(threadId, {
          role: 'assistant',
          content: fullResponse,
        });

        cache.set(cacheKey, responseChunks);
      } else {
        let messageOptions = { role: 'user', content: userMessage || 'File uploaded' };
        const uploadedFile = await openai.files.create({
          file: files[0].buffer,
          purpose: 'assistants',
        });
        messageOptions.file_ids = [uploadedFile.id];
        await openai.beta.threads.messages.create(threadId, messageOptions);

        const stream = await openai.beta.threads.runs.create(threadId, {
          assistant_id: ASSISTANT_ID,
          stream: true,
        });

        for await (const event of stream) {
          if (event.event === 'thread.message.delta') {
            const delta = event.data.delta.content[0].text.value;
            res.write(`data: ${delta}\n\n`);
            responseChunks.push(delta);
          }
        }
        res.write(`data: [END]\n\n`);
        res.end();

        cache.set(cacheKey, responseChunks);
      }
    } else {
      await openai.beta.threads.messages.create(threadId, {
        role: 'user',
        content: userMessage,
      });

      const stream = await openai.beta.threads.runs.create(threadId, {
        assistant_id: ASSISTANT_ID,
        stream: true,
      });

      for await (const event of stream) {
        if (event.event === 'thread.message.delta') {
          const delta = event.data.delta.content[0].text.value;
          res.write(`data: ${delta}\n\n`);
          responseChunks.push(delta);
        }
      }
      res.write(`data: [END]\n\n`);
      res.end();

      cache.set(cacheKey, responseChunks);
    }
  } catch (error) {
    console.error(`Error in /chat: ${error.message}`);
    res.write(`data: Error: ${error.message}\n\n`);
    res.write(`data: [END]\n\n`);
    res.end();
  }
});

// Source extraction endpoint with temporary threads and caching
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

    // Create a temporary thread for this request
    const tempThread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(tempThread.id, {
      role: 'user',
      content: `Extract all Quran verses and Hadith references from the following text. Return ONLY the complete references in the format: "Quran X:Y" for Quran references (where X is the Surah number and Y is the verse number or range, e.g., "Quran 1:1" or "Quran 2:255-256"), and "Hadith [Collection] X:Y" for Hadith references (e.g., "Hadith Bukhari 1:100"). For named Surahs (e.g., "Surah Al-Fatihah"), convert them to their numerical form (e.g., "Quran 1"). Output each reference on a new line. If no references are found, return an empty response with no text. Examples of references to extract: "Surah Al-Fatihah (The Opening)", "Surah 2", "Quran 67:1", "Hadith Bukhari 1:100". Text: ${message}`,
    });

    const run = await openai.beta.threads.runs.create(tempThread.id, { assistant_id: ASSISTANT_ID });

    let timeout = 30;
    const startTime = Date.now();
    let assistantResponse = '';

    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(tempThread.id, run.id);
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(tempThread.id);
        assistantResponse = messages.data
          .filter(msg => msg.role === 'assistant' && msg.run_id === run.id)
          .sort((a, b) => b.created_at - a.created_at)[0]
          .content[0].text.value;
        break;
      }
      if (runStatus.status === 'failed' || runStatus.status === 'cancelled') {
        throw new Error(`Run ${runStatus.status}`);
      }
      if ((Date.now() - startTime) / 1000 > timeout) {
        throw new Error('Request timed out');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const sources = assistantResponse.trim().split('\n').filter(line =>
      line.match(/^Quran \d+:\d+(?:-\d+)?$/) || 
      line.match(/^Hadith [A-Za-z]+ \d+:\d+$/)
    );

    for (let source of sources) {
      res.write(`data: ${source.trim()}\n\n`);
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

// Health check endpoint (unchanged)
app.get('/health', async (req, res) => {
  try {
    const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    res.json({
      status: 'healthy',
      assistant_id: ASSISTANT_ID,
      assistant_name: assistant.name,
      assistant_model: assistant.model,
      tools_enabled: assistant.tools.map(tool => tool.type),
      features: {
        image_analysis: true,
        file_upload: true,
        cache_enabled: true,
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: `Failed to verify assistant: ${error.message}`
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Using assistant ID: ${ASSISTANT_ID}`);
});
