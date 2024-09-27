import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set in the environment');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

let assistant;
let thread;

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    if (!assistant) {
      assistant = await openai.beta.assistants.create({
        name: "Wisdom Pen Islamic AI",
        instructions: "You are an AI assistant specializing in Islamic teachings, including the Quran, Bible, Torah, and Hadiths. Always greet the user with 'Assalamu alaikum' (Peace be upon you).",
        tools: [{ type: "code_interpreter" }],
        model: "gpt-4-turbo-preview"
      });
    }

    if (!thread) {
      thread = await openai.beta.threads.create();
    }

    const { message } = JSON.parse(event.body);

    await openai.beta.threads.messages.create(
      thread.id,
      {
        role: "user",
        content: message
      }
    );

    const run = await openai.beta.threads.runs.create(
      thread.id,
      { assistant_id: assistant.id }
    );

    let response = '';
    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        response = messages.data[0].content[0].text.value;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: response }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'An error occurred while processing your request.' }),
    };
  }
};
