import express from 'express';
import OpenAI from "openai";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import { exec } from 'child_process';
import fs from 'fs';
import util from 'util';

const execPromise = util.promisify(exec);

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
const assemblyAiApiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey || !assemblyAiApiKey) {
  console.error('Missing API keys in environment (OPENAI_API_KEY or ASSEMBLYAI_API_KEY)');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });
const assemblyai = new AssemblyAI({ apiKey: assemblyAiApiKey });
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

function normalizeUrl(url) {
  // Works for both YouTube and X URLs
  const youtuBeRegex = /youtu\.be\/([\w-]{11})/;
  const youtubeRegex = /youtube\.com\/watch\?v=([\w-]{11})/;
  const xRegex = /twitter\.com\/\w+\/status\/(\d+)/;
  let videoId;

  if (youtuBeRegex.test(url)) {
    videoId = url.match(youtuBeRegex)[1];
    return `https://www.youtube.com/watch?v=${videoId}`;
  } else if (youtubeRegex.test(url)) {
    videoId = url.match(youtubeRegex)[1];
    return `https://www.youtube.com/watch?v=${videoId}`;
  } else if (xRegex.test(url)) {
    return url; // Keep X URL as-is for yt-dlp
  }
  return url;
}

app.post('/transcribe', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    console.error('No URL provided in /transcribe request');
    return res.status(400).json({ error: 'URL is required' });
  }

  const normalizedUrl = normalizeUrl(url);
  console.log(`Original URL: ${url}`);
  console.log(`Normalized URL for processing: ${normalizedUrl}`);

  const videoPath = join(__dirname, 'temp_video.mp4');
  const audioPath = join(__dirname, 'temp_audio.mp3');

  try {
    // Step 1: Download video with yt-dlp
    console.log(`Downloading video from ${normalizedUrl}`);
    await execPromise(`yt-dlp -o ${videoPath} ${normalizedUrl}`);
    if (!fs.existsSync(videoPath)) {
      throw new Error('Failed to download video');
    }

    // Step 2: Extract audio with ffmpeg
    console.log('Extracting audio from video');
    await execPromise(`ffmpeg -i ${videoPath} -vn -acodec mp3 -y ${audioPath}`);
    if (!fs.existsSync(audioPath)) {
      throw new Error('Failed to extract audio');
    }

    // Step 3: Transcribe with AssemblyAI
    console.log('Uploading audio to AssemblyAI');
    const audioData = fs.readFileSync(audioPath);
    const transcript = await assemblyai.transcripts.create({
      audio: audioData, // Buffer directly
    });

    console.log(`Transcript requested, ID: ${transcript.id}, Status: ${transcript.status}`);

    const maxWaitTime = 10 * 60 * 1000; // 10 minutes
    const startTime = Date.now();
    let lastStatus = transcript.status;

    while (Date.now() - startTime < maxWaitTime) {
      const status = await assemblyai.transcripts.get(transcript.id);
      if (status.status !== lastStatus) {
        console.log(`Transcription status updated: ${status.status}`);
        lastStatus = status.status;
      }
      if (status.status === 'completed') {
        console.log(`Transcription completed: ${status.text.substring(0, 100)}...`);
        res.json({ transcription: status.text });
        break;
      } else if (status.status === 'failed' || status.status === 'error') {
        console.error(`Transcription failed with status: ${status.status}, Error: ${status.error || 'No error message provided'}`);
        throw new Error(`Transcription failed: ${status.error || status.status}`);
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    if (Date.now() - startTime >= maxWaitTime) {
      throw new Error('Transcription timed out after 10 minutes');
    }
  } catch (error) {
    console.error(`Transcription error for URL ${normalizedUrl}: ${error.message}`);
    res.status(500).json({ error: `Failed to transcribe video: ${error.message}` });
  } finally {
    // Cleanup temporary files
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
});

// Keep /chat endpoint unchanged (included for completeness)
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
