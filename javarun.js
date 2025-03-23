import express from 'express';
import OpenAI from "openai";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(cors());

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
let thread;

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

// Chat endpoint
app.post('/chat', upload, async (req, res) => {
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    // Create a thread if it doesn’t exist
    if (!thread) {
      thread = await openai.beta.threads.create();
      console.log(`New thread created with ID: ${thread.id}`);
    }

    const userMessage = req.body.message || '';
    const files = req.files;

    // Check for valid input
    if (!userMessage && (!files || files.length === 0)) {
      res.write(`data: Please provide a message or files\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    let assistantResponse = '';

    // Handle file uploads or text input
    if (files && files.length > 0) {
      const hasImage = files.some(file => file.mimetype.startsWith('image/'));
      if (hasImage) {
        // Handle image input with GPT-4o Mini for vision
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

        const visionResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 300,
        });
        assistantResponse = visionResponse.choices[0].message.content;

        // Add to thread for context
        await openai.beta.threads.messages.create(thread.id, {
          role: 'user',
          content: userMessage || 'Image uploaded',
        });
        await openai.beta.threads.messages.create(thread.id, {
          role: 'assistant',
          content: assistantResponse,
        });
      } else {
        // Handle other file types with main assistant (ASSISTANT_ID)
        let messageOptions = { role: 'user', content: userMessage || 'File uploaded' };
        const uploadedFile = await openai.files.create({
          file: files[0].buffer,
          purpose: 'assistants',
        });
        messageOptions.file_ids = [uploadedFile.id];

        await openai.beta.threads.messages.create(thread.id, messageOptions);
        const run = await openai.beta.threads.runs.create(thread.id, { assistant_id: ASSISTANT_ID });

        let timeout = 30;
        const startTime = Date.now();
        while (true) {
          const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
          if (runStatus.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(thread.id);
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
      }
    } else {
      // Handle regular text input with main assistant (ASSISTANT_ID)
      await openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: userMessage,
      });
      const run = await openai.beta.threads.runs.create(thread.id, { assistant_id: ASSISTANT_ID });

      let timeout = 30;
      const startTime = Date.now();
      while (true) {
        const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        if (runStatus.status === 'completed') {
          const messages = await openai.beta.threads.messages.list(thread.id);
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
    }

    // Stream the main response word by word
    const words = assistantResponse.split(' ');
    for (let word of words) {
      res.write(`data: ${word}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 100)); // Simulate streaming delay
    }
    res.write(`data: [END]\n\n`);
    res.end();
  } catch (error) {
    console.error(`Error in /chat: ${error.message}`);
    res.write(`data: Error: ${error.message}\n\n`);
    res.write(`data: [END]\n\n`);
    res.end();
  }
});

// Source extraction endpoint (using assistant instead of GPT-4o-mini)
app.post('/extract-sources', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    const message = req.body.message || '';
    if (!message) {
      res.write(`data: Error: No message provided for source extraction\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    // Use the assistant for source extraction
    if (!thread) {
      thread = await openai.beta.threads.create();
    }

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: `Extract all Quran verses and Hadith references from the following text. Return ONLY the complete references in the format: "Quran X:Y" for Quran references (where X is the Surah number and Y is the verse number or range, e.g., "Quran 1:1" or "Quran 2:255-256"), and "Hadith [Collection] X:Y" for Hadith references (e.g., "Hadith Bukhari 1:100"). For named Surahs (e.g., "Surah Al-Fatihah"), convert them to their numerical form (e.g., "Quran 1"). Output each reference on a new line. If no references are found, return an empty response with no text. Examples of references to extract: "Surah Al-Fatihah (The Opening)", "Surah 2", "Quran 67:1", "Hadith Bukhari 1:100". Text: ${message}`,
    });

    const run = await openai.beta.threads.runs.create(thread.id, { assistant_id: ASSISTANT_ID });

    let timeout = 30;
    const startTime = Date.now();
    let assistantResponse = '';

    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
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

    // Parse and filter sources
    const sources = assistantResponse.trim().split('\n').filter(line =>
      line.match(/^Quran \d+:\d+(?:-\d+)?$/) || 
      line.match(/^Hadith [A-Za-z]+ \d+:\d+$/)
    );

    // Stream the sources
    for (let source of sources) {
      res.write(`data: ${source.trim()}\n\n`);
    }
    res.write(`data: [END]\n\n`);
    res.end();
  } catch (error) {
    console.error(`Error in /extract-sources: ${error.message}`);
    res.write(`data: Error: ${error.message}\n\n`);
    res.write(`data: [END]\n\n`);
    res.end();
  }
});

// Health check endpoint
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
        file_upload: true
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
