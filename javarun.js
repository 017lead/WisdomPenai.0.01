import express from 'express';
import OpenAI from "openai";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import multer from 'multer';
import { YoutubeTranscript } from 'youtube-transcript'; // New dependency

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(cors());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).array('files', 5);

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY in environment');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });
const ASSISTANT_ID = "asst_GZR3yTrT76O0DVIhrIT7wIzT";
let thread;

async function verifyAssistant() {
  try {
    const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    console.log(`Assistant Verified:
      ID: ${assistant.id}
      Name: ${assistant.name}
      Model: ${assistant.model}
      Tools: ${JSON.stringify(assistant.tools)}
      Instructions Preview: ${assistant.instructions.substring(0, 100)}...`);
    return true;
  } catch (error) {
    console.error(`Failed to verify assistant ${ASSISTANT_ID}: ${error.message}`);
    process.exit(1);
  }
}

verifyAssistant().then(() => {
  console.log('Assistant verification completed successfully');
});

// Function to normalize YouTube URLs
function normalizeYouTubeUrl(url) {
  const youtuBeRegex = /youtu\.be\/([\w-]{11})/;
  const youtubeRegex = /youtube\.com\/watch\?v=([\w-]{11})/;
  let videoId;

  if (youtuBeRegex.test(url)) {
    videoId = url.match(youtuBeRegex)[1];
    return `https://www.youtube.com/watch?v=${videoId}`;
  } else if (youtubeRegex.test(url)) {
    videoId = url.match(youtubeRegex)[1];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return url;
}

app.post('/transcribe', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    console.error('No URL provided in /transcribe request');
    return res.status(400).json({ error: 'URL is required' });
  }

  const normalizedUrl = normalizeYouTubeUrl(url);
  console.log(`Original URL: ${url}`);
  console.log(`Normalized URL for transcription: ${normalizedUrl}`);

  try {
    const transcript = await YoutubeTranscript.fetchTranscript(normalizedUrl);
    if (!transcript || transcript.length === 0) {
      throw new Error('No transcription available for this video');
    }

    // Combine transcript segments into a single string
    const transcriptionText = transcript.map(t => t.text).join(' ');
    console.log(`Transcription retrieved: ${transcriptionText.substring(0, 100)}...`);
    res.json({ transcription: transcriptionText });
  } catch (error) {
    console.error(`Transcription error for URL ${normalizedUrl}: ${error.message}`);
    res.status(500).json({ error: `Failed to transcribe video: ${error.message}` });
  }
});

app.post('/chat', upload, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  try {
    if (!thread) {
      thread = await openai.beta.threads.create();
      console.log(`New thread created with ID: ${thread.id} for Assistant ID: ${ASSISTANT_ID}`);
    }

    const userMessage = req.body.message || '';
    const transcription = req.body.transcription || '';
    const files = req.files;

    if (!userMessage && (!files || files.length === 0) && !transcription) {
      res.write(`data: Please provide a message, files, or transcription\n\n`);
      res.end();
      return;
    }

    console.log(`Processing message: "${userMessage}"`);
    console.log(`Transcription: ${transcription ? transcription.substring(0, 100) + '...' : 'None'}`);

    let assistantResponse = '';
    let messageContent = transcription 
      ? `Here is the transcription of a video: ${transcription}\n\nThe user asks: ${userMessage}` 
      : userMessage;

    if (files && files.length > 0) {
      const hasImage = files.some(file => file.mimetype.startsWith('image/'));
      
      if (hasImage) {
        const threadMessages = await openai.beta.threads.messages.list(thread.id);
        const priorMessages = threadMessages.data.map(msg => ({
          role: msg.role,
          content: msg.content[0].text.value
        })).reverse();

        const imageFile = files.find(file => file.mimetype.startsWith('image/'));
        const base64Image = imageFile.buffer.toString('base64');
        const imageUrl = `data:${imageFile.mimetype};base64,${base64Image}`;

        const messages = [
          ...priorMessages,
          {
            role: 'user',
            content: [
              { type: 'text', text: messageContent || 'Describe this image' },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ];

        const visionResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 300,
        });
        assistantResponse = visionResponse.choices[0].message.content;

        await openai.beta.threads.messages.create(thread.id, { 
          role: 'user', 
          content: messageContent || 'Image uploaded' 
        });
        await openai.beta.threads.messages.create(thread.id, { 
          role: 'assistant', 
          content: assistantResponse 
        });
      } else {
        let messageOptions = { role: 'user', content: messageContent || 'File uploaded' };
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
      await openai.beta.threads.messages.create(thread.id, { 
        role: 'user', 
        content: messageContent 
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

    const words = assistantResponse.split(' ');
    for (let word of words) {
      res.write(`data: ${word}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 100));
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

app.get('/health', async (req, res) => {
  try {
    const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    res.json({
      status: 'healthy',
      assistant_id: ASSISTANT_ID,
      assistant_name: assistant.name,
      assistant_model: assistant.model,
      tools_enabled: assistant.tools.map(tool => tool.type)
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: `Failed to verify assistant: ${error.message}`
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Using assistant ID: ${ASSISTANT_ID}`);
});
