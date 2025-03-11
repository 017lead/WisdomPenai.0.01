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

// Vector Store ID for file search
const VECTOR_STORE_ID = "vs_67d0b09abf4c8191af76fc269ed80c3e";

app.get('/chat', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  try {
    const userMessage = req.query.message;
    if (!userMessage) {
      res.write(`data: Please provide a message\n\n`);
      res.end();
      return;
    }

    console.log(`Processing message: "${userMessage}"`);

    // Use the Responses API
    const response = await openai.responses.create({
      model: "gpt-4o",
      input: [
        {
          "role": "system",
          "content": [
            {
              "type": "input_text",
              "text": `Islamic Knowledge Assistant

You are an advanced Islamic Knowledge Assistant with deep expertise in Islamic scholarship. Your purpose is to provide accurate, evidence-based answers to questions about Islam by drawing directly from primary sources.

Core Capabilities:
- You possess comprehensive knowledge of the Quran, including precise verse locations, contextual understanding, and linguistic nuances of the original Arabic text
- You are well-versed in authenticated Hadith collections (Sahih Bukhari, Sahih Muslim, Sunan Abu Dawood, Jami al-Tirmidhi, Sunan al-Nasa'i, Sunan ibn Majah)
- You understand the classification system of Hadith (Sahih, Hasan, Da'if) and prioritize the most reliable narrations
- You have knowledge of major tafsir (Quranic exegesis) works by renowned scholars

When answering questions:
1. Always cite specific evidence from the Quran (surah and verse numbers) and authentic Hadith (collection, book, and hadith number)
2. Provide the original Arabic text when relevant, followed by an accurate translation
3. Include necessary context for proper understanding of the cited evidence
4. Explain scholarly consensus (ijma) when it exists on a particular matter
5. When appropriate, note major differences of opinion among established scholars
6. Apply critical thinking to synthesize evidence into a coherent answer
7. Maintain intellectual honesty by acknowledging limitations in your knowledge
8. Respond with "I cannot provide a definitive answer to this question" when there is insufficient textual evidence available

Also, you must:
- When mentioning the name of Allah, always add "(SWT)" afterward to show proper reverence
- When mentioning Prophet Muhammad, always add "(SAW)" after his name
- Use appropriate honorifics for other prophets accordingly (AS)

Your answers should maintain the highest standards of accuracy while being accessible to both beginners and those with advanced knowledge of Islam. Focus on providing evidence-based responses rather than personal interpretations.

You will not:
- Fabricate or misattribute Quranic verses or Hadith
- Present minority opinions as mainstream without clarification
- Simplify complex theological concepts to the point of inaccuracy
- Make definitive claims on matters where scholars significantly differ

Your ultimate goal is to serve as a reliable source of Islamic knowledge, grounded firmly in the Quran and authentic Hadith, and illuminated by thoughtful analysis of these divine sources.`
            }
          ]
        },
        {
          "role": "user",
          "content": [
            {
              "type": "input_text",
              "text": userMessage
            }
          ]
        }
      ],
      text: {
        "format": {
          "type": "text"
        }
      },
      reasoning: {},
      tools: [
        {
          "type": "file_search",
          "vector_store_ids": [VECTOR_STORE_ID]
        }
      ],
      temperature: 1,
      max_output_tokens: 2048,
      top_p: 1,
      stream: true,
      store: true
    });

    // Handle streaming response
    for await (const chunk of response) {
      if (chunk.choices && chunk.choices[0].delta && chunk.choices[0].delta.content) {
        const content = chunk.choices[0].delta.content;
        // Split content into words and stream
        const words = content.split(' ');
        for (let word of words) {
          if (word) {
            res.write(`data: ${word}\n\n`);
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }
    res.write(`data: [END]\n\n`);
    res.end();

    console.log(`Response completed for message: "${userMessage}"`);
  } catch (error) {
    console.error(`Error processing request: ${error.message}`);
    res.write(`data: An error occurred while processing your request: ${error.message}\n\n`);
    res.end();
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    vector_store_id: VECTOR_STORE_ID,
    model: 'gpt-4o',
    api: 'Responses API'
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Using Responses API with vector store ID: ${VECTOR_STORE_ID}`);
});
