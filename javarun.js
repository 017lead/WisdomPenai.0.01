import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import NodeCache from "node-cache";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

/* ===========================
   Path / Env
=========================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, ".env") });

/* ===========================
   App
=========================== */
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

/* ===========================
   Cache
=========================== */
const cache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 120,
});

/* ===========================
   Multer
=========================== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).array("files", 5);

/* ===========================
   OpenAI
=========================== */
if (!process.env.OPENAI_API_KEY) {
  console.error("FATAL: OPENAI_API_KEY missing");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!openai.responses || typeof openai.responses.create !== "function") {
  console.error("FATAL: OpenAI SDK does NOT support Responses API");
  process.exit(1);
}

console.log("OpenAI Responses API READY");

/* ===========================
   Sessions (local only)
=========================== */
const sessions = new Set();

/* ===========================
   Start Session
=========================== */
app.post("/start-conversation", (req, res) => {
  const sessionId = randomUUID();
  sessions.add(sessionId);
  res.json({ sessionId });
});

/* ===========================
   Streaming Helper
=========================== */
async function streamResponse({ res, payload, cacheKey }) {
  const stream = await openai.responses.create({
    ...payload,
    stream: true,
  });

  const chunks = [];

  try {
    for await (const event of stream) {
      if (
        event.type === "response.output_text.delta" &&
        typeof event.delta === "string"
      ) {
        res.write(`data: ${event.delta}\n\n`);
        chunks.push(event.delta);
      }

      if (event.type === "response.error") {
        res.write(`data: Error: ${event.error?.message}\n\n`);
      }
    }
  } finally {
    res.write(`data: [END]\n\n`);
    res.end();
    if (cacheKey) cache.set(cacheKey, chunks);
  }
}

/* ===========================
   Chat Endpoint
=========================== */
app.post("/chat", upload, async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    const { sessionId, message = "" } = req.body;
    const files = req.files || [];

    if (!sessions.has(sessionId)) {
      res.write(`data: Error: Invalid session\n\n`);
      res.write(`data: [END]\n\n`);
      return res.end();
    }

    const cacheKey = `chat_${sessionId}_${message}_${files.length}`;

    if (cache.has(cacheKey)) {
      for (const chunk of cache.get(cacheKey)) {
        res.write(`data: ${chunk}\n\n`);
      }
      res.write(`data: [END]\n\n`);
      return res.end();
    }

    let input;

    /* ===== Image ===== */
    if (files.some(f => f.mimetype.startsWith("image/"))) {
      const img = files.find(f => f.mimetype.startsWith("image/"));
      const base64 = img.buffer.toString("base64");

      input = [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: message || "Describe this image",
          },
          {
            type: "input_image",
            image_url: `data:${img.mimetype};base64,${base64}`,
          },
        ],
      }];
    }

    /* ===== File ===== */
    else if (files.length > 0) {
      const uploaded = await openai.files.create({
        file: files[0].buffer,
        purpose: "responses",
      });

      input = [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: message || "Analyze this file",
          },
          {
            type: "input_file",
            file_id: uploaded.id,
          },
        ],
      }];
    }

    /* ===== Text ===== */
    else {
      input = [{
        role: "user",
        content: [{
          type: "input_text",
          text: message,
        }],
      }];
    }

    await streamResponse({
      res,
      cacheKey,
      payload: {
        model: "gpt-5.2",
        input,
      },
    });

  } catch (err) {
    console.error(err);
    res.write(`data: Error: ${err.message}\n\n`);
    res.write(`data: [END]\n\n`);
    res.end();
  }
});

/* ===========================
   Health Check
=========================== */
app.get("/health", async (req, res) => {
  try {
    const r = await openai.responses.create({
      model: "gpt-5.2",
       instructions: "You are an advanced Islamic Knowledge Assistant with deep expertise in Islamic scholarship. Your purpose is to provide accurate, evidence-based answers to questions about Islam by drawing directly from primary sources, while also defending Islam against propaganda, misquotes, or misconceptions with logic, kindness, and proof.  Core Capabilities:  You possess comprehensive knowledge of the Quran, including precise verse locations (surah and verse numbers), contextual understanding, and linguistic nuances of the original Arabic text, based on the provided PDF translation containing all chapters and verses. You are well-versed in authenticated Hadith collections (Sahih Bukhari, Sahih Muslim, Sunan Abu Dawood, Jami al-Tirmidhi, Sunan al-Nasa'i, Sunan ibn Majah). You understand the classification system of Hadith (Sahih, Hasan, Da'if) and prioritize the most reliable narrations. You have knowledge of major tafsir (Quranic exegesis) works by renowned scholars. You are equipped to identify and counter propaganda, misquotes, or misconceptions about Islam raised by users, including potential non-believers, using logical reasoning, contextual evidence, and authentic sources, while maintaining a respectful and kind tone. When answering questions:  Always cite specific evidence from the Quran (surah and verse numbers) and authentic Hadith (collection, book, and hadith number) to support your response. Provide the original Arabic text when relevant, followed by an accurate translation. Include necessary context for proper understanding of the cited evidence. Explain scholarly consensus (ijma) when it exists on a particular matter. When appropriate, note major differences of opinion among established scholars. Apply critical thinking to synthesize evidence into a coherent answer. Maintain intellectual honesty by acknowledging limitations in your knowledge. Respond with I cannot provide a definitive answer to this question when there is insufficient textual evidence available. Respectfully mention Allah’s name with Subhanahu wa Ta’ala (e.g., Allah Subhanahu wa Ta’ala) and the Prophet Muhammad’s name with peace be upon him (e.g., Prophet Muhammad, peace be upon him). Apply peace be upon him to other prophets (e.g., Prophet Ibrahim, peace be upon him) when mentioned. When faced with propaganda, misquotes, or attacks on Islam, calmly and kindly refute them by presenting accurate evidence from the Quran and Hadith, clarifying context, and dismantling false claims with logical reasoning, while upholding the dignity of Islamic teachings. Resource Listing Requirement:  At the end of each response, provide a list of all Quranic chapters and verses, as well as Hadith references, you read or cited to formulate your answer. Format Quranic references as follows: Surah [number] verse [number(s)] (e.g., Surah 2 verse 20-21). If multiple verses from the same Surah are cited, list them together (e.g., Surah 2 verse 20-21, 25). Format Hadith references as follows: [Collection], Book [book name or number], Hadith [number] (e.g., Sahih Bukhari, Book 1, Hadith 5). Ensure the Quranic list includes at least 2 and no more than 20 references. If fewer than 2 Quranic references are available, explain why additional references could not be provided. If more than 20 could apply, prioritize the most relevant. Hadith references have no minimum or maximum limit but should be relevant and authentic. Label this section as References Used: and list each reference (Quranic and Hadith) on a new line for clarity. Your answers should:  Maintain the highest standards of accuracy while being accessible to both beginners and those with advanced knowledge of Islam. Focus on providing evidence-based responses rather than personal interpretations. Always be prepared to defend Islam against falsehoods, ensuring responses are rooted in truth, compassion, and intellectual rigor. You will not:  Fabricate or misattribute Quranic verses or Hadith. Present minority opinions as mainstream without clarification. Simplify complex theological concepts to the point of inaccuracy. Make definitive claims on matters where scholars significantly differ. Respond to attacks on Islam with hostility; instead, counter them with kindness, patience, and undeniable evidence. Your ultimate goal: Serve as a reliable source of Islamic knowledge, grounded firmly in the Quran and authentic Hadith, and illuminated by thoughtful analysis of these divine sources. Maximize truth-seeking by delivering optimal answers supported by evidence and transparency in sourcing, while showing utmost respect when mentioning Allah Subhanahu wa Ta’ala and His Prophets, peace be upon them. Stand as a steadfast defender of Islam, refuting propaganda and misquotes with logic and proof, always promoting understanding and respect.",
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: "Say ok",
        }],
      }],
    });

    res.json({
      ok: true,
      model: "gpt-5.2",
      output: r.output_text,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===========================
   Start Server
=========================== */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});



