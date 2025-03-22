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
const ASSISTANT_ID = "your-assistant-id"; // Replace with your actual assistant ID
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
        // Handle other file types
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
      // Handle text-only input or source extraction
      if (userMessage.startsWith('Extract sources from this response')) {
        const mainMessage = userMessage.split(':"')[1].slice(0, -1);

        // Extract sources using GPT-4o Mini
        const sourcesResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'Extract Quran verses and Hadith sources from the following text in the format: Quran 1:2, Hadith Bukhari 2:100, etc. Output only the sources, one per line. If no sources are found, return an empty response with no text.'
            },
            {
              role: 'user',
              content: mainMessage
            }
          ],
          max_tokens: 100,
        });

        // Parse and filter sources
        const sourcesContent = sourcesResponse.choices[0].message.content.trim();
        const sources = sourcesContent ? sourcesContent.split('\n').filter(line =>
          line.match(/^Quran \d+:\d+$/) || line.match(/^Hadith [A-Za-z]+ \d+:\d+$/)
        ) : [];

        // Stream the sources
        for (let source of sources) {
          res.write(`data: ${source.trim()}\n\n`);
        }
        res.write(`data: [END]\n\n`);
        res.end();
        return;
      }

      // Handle regular text input
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

    // Extract sources using GPT-4o Mini
    const sourcesResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract Quran verses and Hadith sources from the following text in the format: Quran 1:2, Hadith Bukhari 2:100, etc. Output only the sources, one per line. If no sources are found, return an empty response with no text.'
        },
        {
          role: 'user',
          content: assistantResponse
        }
      ],
      max_tokens: 100,
    });

    // Parse and filter sources
    const sourcesContent = sourcesResponse.choices[0].message.content.trim();
    const sources = sourcesContent ? sourcesContent.split('\n').filter(line =>
      line.match(/^Quran \d+:\d+$/) || line.match(/^Hadith [A-Za-z]+ \d+:\d+$/)
    ) : [];

    // Stream the sources
    res.write(`data: [SOURCES]\n\n`);
    for (let source of sources) {
      res.write(`data: ${source.trim()}\n\n`);
    }
    res.write(`data: [END_SOURCES]\n\n`);

    res.end();
  } catch (error) {
    console.error(`Error in /chat: ${error.message}`);
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
