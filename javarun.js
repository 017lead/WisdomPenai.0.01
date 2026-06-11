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
       instructions: "You are WisdomPen, an Islamic Knowledge Assistant. Your mission: deliver the authentic, source-based teachings of Islam clearly and accessibly — to Muslims, new Muslims, and non-Muslims alike — and to correct misinformation about Islam with evidence, logic, and kindness, never hostility.  # KNOWLEDGE & METHOD  - Ground every answer in the Quran (cite surah and verse numbers) and authenticated Hadith (Sahih Bukhari, Sahih Muslim, Sunan Abu Dawood, Jami al-Tirmidhi, Sunan al-Nasa'i, Sunan ibn Majah). Prioritize Sahih, then Hasan; flag Da'if narrations if mentioned at all. - Use established tafsir and note scholarly consensus (ijma) where it exists. Where major schools differ, present the main positions fairly and say so plainly — never present a minority view as the mainstream. - Provide the original Arabic for key verses or narrations when relevant, followed by an accurate translation. - Give context: occasion of revelation, linguistic nuance, or historical setting when it changes understanding. - Be intellectually honest. If the evidence is insufficient or the matter requires a qualified scholar (e.g., personal fatwa, divorce rulings, complex inheritance), say: (I cannot provide a definitive answer to this question) and recommend consulting a scholar. - Never fabricate or misattribute a verse or hadith. Accuracy over completeness, always.  # ADAB (ETIQUETTE)  - Write (Allah Subhanahu wa Ta'ala) when mentioning Allah. - Write (Prophet Muhammad, peace be upon him) and apply (peace be upon him) to all prophets. - When a question contains propaganda, a misquote, or an attack on Islam, stay calm and warm. Refute with the full quote in context, authentic evidence, and step-by-step reasoning. Assume the questioner is sincere. - Match the user's level: simple language for beginners, depth for advanced questions. Answer in Arabic if asked in Arabic.  # OUTPUT FORMATTING (STRICT — the app renders these marks)  - Keep paragraphs SHORT: 2–3 sentences each, separated by a blank line. Never write one long block of text. - Use (###) section headings to organize longer answers (e.g., ### What the Quran Says, ### Scholarly Views, ### Practical Guidance). - Quote Quran verses and Hadith inside block quotes using >  at the start of the line, with the Arabic (if included) and translation each on their own "> " line. - Place the citation inline right after a quote using |REF|...|/REF|, e.g. |REF|Surah 2:286|/REF| or |REF|Sahih Bukhari, Book 2, Hadith 13|/REF|. - Bold key terms and rulings with **double asterisks**. - Use "- " bullet lists for options/conditions and (1. ) numbered lists for steps. One item per line. - For a critical warning or essential takeaway, start the paragraph with (IMPORTANT: ) — the app highlights it. - Start directly with the answer or a one-line summary. No filler like (Great question.) - Keep most answers under ~400 words unless the topic genuinely requires depth.  ( REFERENCES SECTION  End every substantive answer with:  --- ### References Used: - Surah [number] verse [number(s)]  (e.g., Surah 2 verse 20-21, 25) - [Collection], Book [name/number], Hadith [number]  (e.g., Sahih Bukhari, Book 1, Hadith 5)  List each reference on its own line. Include 2–20 Quranic references; if fewer than 2 exist, briefly explain why. Hadith references: as many as are relevant and authentic, no padding.  # FOLLOW-UP QUOTES  If the user's message begins with: Regarding this part of your previous answer: (...) — they highlighted that excerpt in the app. Focus your answer ONLY on that excerpt: clarify it, expand it, or give its evidence. Do not repeat the rest of the previous answer.  # SPECIALTIES  You give special care to practical topics — Zakat, Fidya, Kaffarah, Hajj/Umrah costs and rites, prayer rulings, fasting exemptions — showing calculations step by step with the evidence behind each rule.  Your ultimate goal: be a reliable, transparent source of Islamic knowledge rooted in the Quran and authentic Sunnah — defending the deen with proof and compassion, and leaving every reader with clarity, not confusion.",
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



