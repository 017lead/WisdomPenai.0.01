import express from 'express';
import OpenAI from "openai";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@deepgram/sdk';
import ytdl from 'ytdl-core';
import fetch from 'node-fetch';
import { ApifyClient } from 'apify-client';

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
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const apifyApiToken = process.env.APIFY_API_TOKEN; // Add this to your .env file
if (!apiKey || !deepgramApiKey || !apifyApiToken) {
  console.error('Missing API keys in environment (OPENAI_API_KEY, DEEPGRAM_API_KEY, or APIFY_API_TOKEN)');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });
const deepgram = createClient(deepgramApiKey);
const apifyClient = new ApifyClient({ token: apifyApiToken });
const ASSISTANT_ID = "asst_GZR3yTrT76O0DVIhrIT7wIzT";
let thread;

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

function extractVideoId(url) {
  const youtubeRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/;
  const twitterRegex = /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/;
  
  let match = url.match(youtubeRegex);
  if (match) return { platform: 'youtube', id: match[1] };
  
  match = url.match(twitterRegex);
  if (match) return { platform: 'twitter', id: match[1] };
  
  return { platform: 'unknown', id: null };
}

async function transcribeYouTubeVideo(videoId) {
  console.log(`Processing YouTube video ID: ${videoId}`);
  try {
    const videoInfo = await ytdl.getInfo(videoId);
    const audioStream = ytdl(videoId, { quality: 'lowestaudio', filter: 'audioonly' });
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);
    console.log(`Retrieved audio data: ${audioBuffer.length} bytes`);

    try {
      const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
        audioBuffer,
        { model: 'nova-2', language: 'en', smart_format: true, punctuate: true }
      );
      if (error) throw error;
      const transcription = result.results.channels[0].alternatives[0].transcript;
      console.log(`Deepgram transcription complete for: ${videoInfo.videoDetails.title}`);
      return {
        transcription,
        videoTitle: videoInfo.videoDetails.title,
        videoAuthor: videoInfo.videoDetails.author.name
      };
    } catch (deepgramError) {
      console.log(`Deepgram failed: ${deepgramError.message}, falling back to Whisper`);
      const transcriptionResponse = await openai.audio.transcriptions.create({
        file: audioBuffer,
        model: 'whisper-1'
      });
      console.log(`Whisper transcription complete for: ${videoInfo.videoDetails.title}`);
      return {
        transcription: transcriptionResponse.text,
        videoTitle: videoInfo.videoDetails.title,
        videoAuthor: videoInfo.videoDetails.author.name
      };
    }
  } catch (error) {
    console.error(`YouTube transcription error: ${error.message}`);
    throw error;
  }
}

async function transcribeTwitterVideo(tweetUrl) {
  console.log(`Processing Twitter/X video URL: ${tweetUrl}`);
  try {
    const run = await apifyClient.actor("yeahjjyy/twitter-x-video-transcript-scraper-free-2025").call({
      url: tweetUrl // Assuming the Actor accepts a URL input; check Apify docs for exact input schema
    });

    const dataset = await apifyClient.dataset(run.defaultDatasetId).listItems();
    const items = dataset.items;

    if (!items || items.length === 0) {
      throw new Error('No transcription data returned from Apify Actor');
    }

    const result = items[0]; // Assuming first item contains the transcription
    console.log(`Apify transcription complete for Twitter/X video`);
    return {
      transcription: result.transcript || result.transcription || 'No transcript available',
      videoTitle: result.title || `Twitter Video ${extractVideoId(tweetUrl).id}`
    };
  } catch (error) {
    console.error(`Twitter transcription error: ${error.message}`);
    throw error;
  }
}

async function getTranscriptionFromUrl(url) {
  const { platform, id } = extractVideoId(url);
  console.log(`Detected platform: ${platform}, ID: ${id}`);
  try {
    if (platform === 'youtube' && id) return await transcribeYouTubeVideo(id);
    if (platform === 'twitter' && id) return await transcribeTwitterVideo(url);
    throw new Error('Unsupported platform or invalid URL');
  } catch (error) {
    throw error;
  }
}

app.post('/transcribe', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  console.log(`Processing transcription request for URL: ${url}`);
  try {
    const result = await getTranscriptionFromUrl(url);
    res.json({
      transcription: result.transcription,
      videoTitle: result.videoTitle,
      videoAuthor: result.videoAuthor || ''
    });
  } catch (error) {
    res.status(500).json({ error: `Failed to transcribe video: ${error.message}` });
  }
});

app.post('/video-chat', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  try {
    const { url, message } = req.body;
    if (!url) {
      res.write(`data: Please provide a video URL\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    console.log(`Processing video chat request for URL: ${url}`);
    res.write(`data: Transcribing video...\n\n`);
    let transcriptionResult;
    try {
      transcriptionResult = await getTranscriptionFromUrl(url);
      res.write(`data: Transcription complete. Processing with AI...\n\n`);
    } catch (error) {
      res.write(`data: Failed to transcribe video: ${error.message}\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    if (!thread) {
      thread = await openai.beta.threads.create();
      console.log(`New thread created with ID: ${thread.id}`);
    }

    const userQuery = message || 'Summarize this video';
    const fullMessage = `VIDEO TITLE: ${transcriptionResult.videoTitle}\n${transcriptionResult.videoAuthor ? `VIDEO AUTHOR: ${transcriptionResult.videoAuthor}\n` : ''}VIDEO URL: ${url}\n\nVIDEO TRANSCRIPTION:\n${transcriptionResult.transcription}\n\nUSER QUERY: ${userQuery}`;

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: fullMessage
    });

    const run = await openai.beta.threads.runs.create(thread.id, { assistant_id: ASSISTANT_ID });
    let timeout = 60;
    const startTime = Date.now();

    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        const assistantResponse = messages.data
          .filter(msg => msg.role === 'assistant' && msg.run_id === run.id)
          .sort((a, b) => b.created_at - a.created_at)[0]
          .content[0].text.value;

        const words = assistantResponse.split(' ');
        for (let word of words) {
          res.write(`data: ${word}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        res.write(`data: [END]\n\n`);
        res.end();
        break;
      }
      if (runStatus.status === 'failed' || runStatus.status === 'cancelled') {
        throw new Error(`Run ${runStatus.status}: ${runStatus.last_error?.message || 'Unknown error'}`);
      }
      if ((Date.now() - startTime) / 1000 > timeout) {
        throw new Error('Request timed out');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error(`Error in /video-chat: ${error.message}`);
    res.write(`data: Error: ${error.message}\n\n`);
    res.write(`data: [END]\n\n`);
    res.end();
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
      console.log(`New thread created with ID: ${thread.id}`);
    }

    const userMessage = req.body.message || '';
    const transcription = req.body.transcription || '';
    const videoTitle = req.body.videoTitle || '';
    const videoAuthor = req.body.videoAuthor || '';
    const videoUrl = req.body.videoUrl || '';
    const files = req.files;

    if (!userMessage && (!files || files.length === 0) && !transcription) {
      res.write(`data: Please provide a message, files, or transcription\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }

    let messageContent = transcription
      ? `VIDEO TITLE: ${videoTitle}\n${videoAuthor ? `VIDEO AUTHOR: ${videoAuthor}\n` : ''}${videoUrl ? `VIDEO URL: ${videoUrl}\n\n` : ''}VIDEO TRANSCRIPTION:\n${transcription}\n\nUSER QUERY: ${userMessage}`
      : userMessage;

    let assistantResponse = '';
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
      tools_enabled: assistant.tools.map(tool => tool.type),
      features: {
        transcription: true,
        youtube_transcription: true,
        twitter_transcription: true,
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Using assistant ID: ${ASSISTANT_ID}`);
});
