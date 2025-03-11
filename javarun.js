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

// Your existing assistant ID
const ASSISTANT_ID = "asst_GZR3yTrT76O0DVIhrIT7wIzT"; // Replace with your actual assistant ID
let thread;

// Verify assistant exists and log details on startup
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

// Run verification on startup
verifyAssistant().then(() => {
  console.log('Assistant verification completed successfully');
});

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
      console.log(`New thread created with ID: ${thread.id} for Assistant ID: ${ASSISTANT_ID}`);
    }

    const userMessage = req.query.message;
    if (!userMessage) {
      res.write(`data: Please provide a message\n\n`);
      res.end();
      return;
    }

    console.log(`Processing message "${userMessage}" with Assistant ID: ${ASSISTANT_ID}`);

    // Add user's message to the thread
    await openai.beta.threads.messages.create(
      thread.id,
      {
        role: "user",
        content: userMessage
      }
    );

    // Create a run with the specified assistant
    const run = await openai.beta.threads.runs.create(
      thread.id,
      { assistant_id: ASSISTANT_ID }
    );

    // Poll for completion and stream response
    let timeout = 30; // 30 seconds timeout
    const startTime = Date.now();
    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        const response = messages.data
          .filter(msg => msg.role === 'assistant')
          .sort((a, b) => b.created_at - a.created_at)[0]
          .content[0].text.value;
        
        console.log(`Response generated for Assistant ID: ${ASSISTANT_ID}`);
        
        const words = response.split(' ');
        for (let word of words) {
          res.write(`data: ${word}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        res.write(`data: [END]\n\n`);
        break;
      }
      if (runStatus.status === 'failed' || runStatus.status === 'cancelled') {
        res.write(`data: Error processing request: Run ${runStatus.status}\n\n`);
        break;
      }
      if ((Date.now() - startTime) / 1000 > timeout) {
        res.write(`data: Request timed out\n\n`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    res.end();
  } catch (error) {
    console.error(`Error in chat endpoint for Assistant ID ${ASSISTANT_ID}: ${error.message}`);
    res.write(`data: An error occurred while processing your request: ${error.message}\n\n`);
    res.end();
  }
});

// Enhanced health check endpoint
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
