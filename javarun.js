import express from 'express';
import OpenAI from "openai";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(cors());

// Get API key from environment variables
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set in the environment');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

// Use your existing assistant ID
const ASSISTANT_ID = "asst_GZR3yTrT76O0DVIhrIT7wIzT"; // Replace with your actual assistant ID
let thread; // Thread will still be created per server start

app.get('/chat', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  try {
    // Create a new thread if one doesn't exist
    if (!thread) {
      thread = await openai.beta.threads.create();
      console.log(`New thread created with ID: ${thread.id}`);
    }

    // Get the user's message from query parameter
    const userMessage = req.query.message;
    if (!userMessage) {
      res.write(`data: Please provide a message\n\n`);
      res.end();
      return;
    }

    // Add user's message to the thread
    await openai.beta.threads.messages.create(
      thread.id,
      {
        role: "user",
        content: userMessage
      }
    );

    // Create a run with the existing assistant
    const run = await openai.beta.threads.runs.create(
      thread.id,
      { assistant_id: ASSISTANT_ID }
    );

    // Poll for completion and stream response
    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        // Get the latest assistant message
        const response = messages.data
          .filter(msg => msg.role === 'assistant')
          .sort((a, b) => b.created_at - a.created_at)[0]
          .content[0].text.value;
        
        // Stream the response word by word
        const words = response.split(' ');
        for (let word of words) {
          res.write(`data: ${word}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        res.write(`data: [END]\n\n`);
        break;
      }
      // Check for error states
      if (runStatus.status === 'failed' || runStatus.status === 'cancelled') {
        res.write(`data: Error processing request\n\n`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    res.end();
  } catch (error) {
    console.error("An error occurred:", error);
    res.write(`data: An error occurred while processing your request: ${error.message}\n\n`);
    res.end();
  }
});

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', assistant_id: ASSISTANT_ID });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Using assistant ID: ${ASSISTANT_ID}`);
});
