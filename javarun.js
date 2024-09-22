import express from 'express';
import OpenAI from "openai";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const app = express();
const port = 3000;

app.use(express.json());
app.use(cors());

const openai = new OpenAI(process.env.OPENAI_API_KEY);

let assistant;
let thread;

app.get('/chat', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  try {
    if (!assistant) {
      assistant = await openai.beta.assistants.create({
        name: "Wisdom Pen Islamic AI",
        instructions: "You are an AI assistant specializing in Islamic teachings, including the Quran, Bible, Torah, and Hadiths. Always greet the user with 'Assalamu alaikum' (Peace be upon you).",
        tools: [{ type: "code_interpreter" }],
        model: "gpt-4o-mini"
      });
    }

    if (!thread) {
      thread = await openai.beta.threads.create();
    }

    const userMessage = req.query.message;
    await openai.beta.threads.messages.create(
      thread.id,
      {
        role: "user",
        content: userMessage
      }
    );

    const run = await openai.beta.threads.runs.create(
      thread.id,
      { assistant_id: assistant.id }
    );

    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        const response = messages.data[0].content[0].text.value;
        
        // Send the response word by word
        const words = response.split(' ');
        for (let word of words) {
          res.write(`data: ${word}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 100)); // Add a small delay between words
        }
        res.write(`data: [END]\n\n`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    res.end();
  } catch (error) {
    console.error("An error occurred:", error);
    res.write(`data: An error occurred while processing your request.\n\n`);
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});