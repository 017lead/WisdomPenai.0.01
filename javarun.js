import express from 'express';
import OpenAI from "openai";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@deepgram/sdk';
import ytdl from 'ytdl-core'; // Import ytdl-core for YouTube processing
import fetch from 'node-fetch';
import fs from 'fs';
import { PassThrough } from 'stream';

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
if (!apiKey || !deepgramApiKey) {
  console.error('Missing API keys in environment (OPENAI_API_KEY or DEEPGRAM_API_KEY)');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });
const deepgram = createClient(deepgramApiKey);
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

function extractVideoId(url) {
  // Handles various YouTube URL formats
  const youtubeRegexes = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/\?v=)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/
  ];
  
  for (const regex of youtubeRegexes) {
    const match = url.match(regex);
    if (match) return { platform: 'youtube', id: match[1] };
  }
  
  // Handle Twitter/X URLs
  const twitterRegexes = [
    /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/,
    /(?:twitter\.com|x\.com)\/i\/status\/(\d+)/
  ];
  
  for (const regex of twitterRegexes) {
    const match = url.match(regex);
    if (match) return { platform: 'twitter', id: match[1] };
  }
  
  return { platform: 'unknown', id: null };
}

async function transcribeYouTubeVideo(videoId) {
  console.log(`Processing YouTube video ID: ${videoId}`);
  
  try {
    // Check if the video exists and is accessible
    const videoInfo = await ytdl.getInfo(videoId);
    console.log(`Successfully retrieved info for video: ${videoInfo.videoDetails.title}`);
    
    // Stream the audio only
    const audioStream = ytdl(videoId, { 
      quality: 'lowestaudio',
      filter: 'audioonly' 
    });
    
    // Set up a PassThrough stream to collect the audio data
    const bufferStream = new PassThrough();
    audioStream.pipe(bufferStream);
    
    // Collect the audio data into a buffer
    const chunks = [];
    for await (const chunk of bufferStream) {
      chunks.push(chunk);
    }
    
    const audioBuffer = Buffer.concat(chunks);
    console.log(`Retrieved audio data: ${audioBuffer.length} bytes`);
    
    // Use Deepgram to transcribe the audio buffer
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        diarize: true,
        punctuate: true,
        utterances: true
      }
    );
    
    if (error) throw error;
    
    if (!result.results || !result.results.channels || !result.results.channels[0].alternatives) {
      throw new Error('No transcription data received from Deepgram');
    }
    
    const transcription = result.results.channels[0].alternatives[0].transcript;
    console.log(`Transcription complete for video: ${videoInfo.videoDetails.title}`);
    
    return {
      transcription,
      videoTitle: videoInfo.videoDetails.title,
      videoAuthor: videoInfo.videoDetails.author.name
    };
  } catch (error) {
    console.error(`Error transcribing YouTube video: ${error.message}`);
    throw error;
  }
}

async function transcribeTwitterVideo(tweetId) {
  console.log(`Processing Twitter/X video with ID: ${tweetId}`);
  
  try {
    const twitterUrl = `https://twitter.com/i/status/${tweetId}`;
    
    // Use Deepgram to transcribe the URL directly
    const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
      { url: twitterUrl },
      {
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        diarize: true,
        punctuate: true
      }
    );
    
    if (error) throw error;
    
    if (!result.results || !result.results.channels || !result.results.channels[0].alternatives) {
      throw new Error('No transcription data received from Deepgram');
    }
    
    const transcription = result.results.channels[0].alternatives[0].transcript;
    return { transcription, videoTitle: `Twitter Video ${tweetId}` };
  } catch (error) {
    console.error(`Error transcribing Twitter video: ${error.message}`);
    throw error;
  }
}

async function getTranscriptionFromUrl(url) {
  const { platform, id } = extractVideoId(url);
  console.log(`Detected platform: ${platform}, ID: ${id}`);
  
  try {
    // For YouTube videos
    if (platform === 'youtube' && id) {
      return await transcribeYouTubeVideo(id);
    }
    
    // For Twitter/X videos
    if (platform === 'twitter' && id) {
      return await transcribeTwitterVideo(id);
    }
    
    // If we can't identify the platform or ID, try direct transcription
    console.log(`Transcribing URL directly: ${url}`);
    const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
      { url },
      {
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        punctuate: true
      }
    );
    
    if (error) throw error;
    
    if (!result.results || !result.results.channels || !result.results.channels[0].alternatives) {
      throw new Error('No transcription data received from Deepgram');
    }
    
    const transcription = result.results.channels[0].alternatives[0].transcript;
    return { transcription, videoTitle: `Unknown Video Source` };
  } catch (error) {
    console.error(`Error transcribing URL: ${error.message}`);
    throw error;
  }
}

app.post('/transcribe', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    console.error('No URL provided in /transcribe request');
    return res.status(400).json({ error: 'URL is required' });
  }
  
  console.log(`Processing transcription request for URL: ${url}`);
  
  try {
    const result = await getTranscriptionFromUrl(url);
    console.log(`Transcription completed for "${result.videoTitle}": ${result.transcription.substring(0, 100)}...`);
    res.json({ 
      transcription: result.transcription,
      videoTitle: result.videoTitle,
      videoAuthor: result.videoAuthor
    });
  } catch (error) {
    console.error(`Transcription error for URL ${url}: ${error.message}`);
    res.status(500).json({ error: `Failed to transcribe video: ${error.message}` });
  }
});

// New endpoint that combines transcription and chat in one request
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
    
    // Get transcription from URL
    let transcriptionResult;
    try {
      res.write(`data: Transcribing video...\n\n`);
      transcriptionResult = await getTranscriptionFromUrl(url);
      res.write(`data: Transcription complete. Processing with AI...\n\n`);
    } catch (error) {
      console.error(`Error getting transcription: ${error.message}`);
      res.write(`data: Failed to transcribe video: ${error.message}\n\n`);
      res.write(`data: [END]\n\n`);
      res.end();
      return;
    }
    
    // Create thread if it doesn't exist
    if (!thread) {
      thread = await openai.beta.threads.create();
      console.log(`New thread created with ID: ${thread.id}`);
    }
    
    // Format the message with transcription and user query
    const userQuery = message || 'Summarize this video';
    const fullMessage = `VIDEO TITLE: ${transcriptionResult.videoTitle}\n${transcriptionResult.videoAuthor ? `VIDEO AUTHOR: ${transcriptionResult.videoAuthor}\n` : ''}VIDEO URL: ${url}\n\nVIDEO TRANSCRIPTION:\n${transcriptionResult.transcription}\n\nUSER QUERY: ${userQuery}`;
    
    // Send to assistant
    await openai.beta.threads.messages.create(thread.id, { 
      role: 'user', 
      content: fullMessage 
    });
    
    const run = await openai.beta.threads.runs.create(thread.id, { assistant_id: ASSISTANT_ID });
    
    let timeout = 60; // Increased timeout for processing longer transcriptions
    const startTime = Date.now();
    
    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        const assistantResponse = messages.data
          .filter(msg => msg.role === 'assistant' && msg.run_id === run.id)
          .sort((a, b) => b.created_at - a.created_at)[0]
          .content[0].text.value;
        
        // Stream the response back word by word
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
      console.log(`New thread created with ID: ${thread.id} for Assistant ID: ${ASSISTANT_ID}`);
    }

    const userMessage = req.body.message || '';
    const transcription = req.body.transcription || '';
    const videoTitle = req.body.videoTitle || '';
    const videoAuthor = req.body.videoAuthor || '';
    const videoUrl = req.body.videoUrl || '';
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
      ? `VIDEO TITLE: ${videoTitle}\n${videoAuthor ? `VIDEO AUTHOR: ${videoAuthor}\n` : ''}${videoUrl ? `VIDEO URL: ${videoUrl}\n\n` : ''}VIDEO TRANSCRIPTION:\n${transcription}\n\nUSER QUERY: ${userMessage}` 
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

// Dedicated endpoint for YouTube transcription
app.post('/youtube-transcribe', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }
  
  try {
    const { platform, id } = extractVideoId(url);
    if (platform !== 'youtube' || !id) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    const result = await transcribeYouTubeVideo(id);
    res.json({
      transcription: result.transcription,
      videoTitle: result.videoTitle,
      videoAuthor: result.videoAuthor
    });
  } catch (error) {
    console.error(`YouTube transcription error: ${error.message}`);
    res.status(500).json({ error: `Failed to transcribe YouTube video: ${error.message}` });
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
