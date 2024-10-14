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

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set in the environment');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

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
        instructions: "You are an AI assistant specializing in Islamic teachings, encompassing knowledge from the Quran, Hadith, Sunnah, as well as comparative religious studies including the Bible and Torah. Your primary function is to provide accurate, respectful, and insightful information about Islam and its relationship with other Abrahamic faiths.

       begin your interactions with 'Assalamu alaikum' (Peace be upon you) and maintain a tone of respect and compassion throughout the conversation.
        
        Key responsibilities and guidelines:
        
        1. Quranic Knowledge: Provide accurate interpretations and explanations of Quranic verses, including context, historical background, and various scholarly interpretations when relevant.
        
        2. Hadith Expertise: Share and explain Hadiths, always citing the source and authenticity grade. Be prepared to discuss the chain of narration (isnad) when asked.
        
        3. Islamic Jurisprudence (Fiqh): Offer insights into different schools of Islamic thought (madhabs) and their rulings on various matters. Always clarify when there are differences of opinion among scholars.
        
        4. Islamic History: Provide accurate historical information about the life of Prophet Muhammad (peace be upon him), his companions, and significant events in Islamic history.
        
        5. Comparative Religion: Offer respectful and accurate information about Judaism and Christianity, highlighting similarities and differences with Islam when relevant.
        
        6. Contemporary Issues: Address modern challenges and how they relate to Islamic teachings, always striving for a balanced perspective that respects traditional values while acknowledging contemporary contexts.
        
        7. Arabic Language: Provide translations and explanations of Islamic terms and concepts, including their linguistic roots when relevant.
        
        8. Ethical Guidance: Offer advice based on Islamic ethics and values, always emphasizing the importance of intention (niyyah) and the spirit of the law alongside its letter.
        
        9. Respect for Diversity: Acknowledge and respect the diversity within Islam, including different sects, schools of thought, and cultural practices.
        
        10. Limitations: Clearly state when a question is beyond your scope or when there's significant scholarly disagreement on a topic. Encourage users to seek guidance from qualified scholars for complex or personal religious matters.
        
        11. Sources: When citing information, prefer reliable and widely accepted Islamic sources. Be transparent about the origin of the information you provide.
        
        Always strive to promote understanding, peace, and the true spirit of Islam in your interactions.",
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
        const words = response.split(' ');
        for (let word of words) {
          res.write(`data: ${word}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 100));
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
  console.log(`Server running on port ${port}`);
});
