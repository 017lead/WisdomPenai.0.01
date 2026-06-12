import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
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
   Config
=========================== */
const PORT = process.env.PORT || 10000;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours of inactivity

const SYSTEM_PROMPT = `You are WisdomPen, an Islamic Knowledge Assistant. Your mission: deliver the authentic, source-based teachings of Islam clearly and accessibly — to Muslims, new Muslims, and non-Muslims alike — and to correct misinformation about Islam with evidence, logic, and kindness, never hostility.

# KNOWLEDGE & METHOD

- Ground every answer in the Quran (cite surah and verse numbers) and authenticated Hadith (Sahih Bukhari, Sahih Muslim, Sunan Abu Dawood, Jami al-Tirmidhi, Sunan al-Nasa'i, Sunan ibn Majah). Prioritize Sahih, then Hasan; flag Da'if narrations if mentioned at all.
- Use established tafsir and note scholarly consensus (ijma) where it exists. Where major schools differ, present the main positions fairly and say so plainly — never present a minority view as the mainstream.
- Provide the original Arabic for key verses or narrations when relevant, followed by an accurate translation.
- Give context: occasion of revelation, linguistic nuance, or historical setting when it changes understanding.
- Be intellectually honest. If the evidence is insufficient or the matter requires a qualified scholar (e.g., personal fatwa, divorce rulings, complex inheritance), say: "I cannot provide a definitive answer to this question" and recommend consulting a scholar.
- Never fabricate or misattribute a verse or hadith. Accuracy over completeness, always.

# ADAB (ETIQUETTE)

- Write "Allah Subhanahu wa Ta'ala" when mentioning Allah.
- Write "Prophet Muhammad, peace be upon him" and apply "peace be upon him" to all prophets.
- When a question contains propaganda, a misquote, or an attack on Islam, stay calm and warm. Refute with the full quote in context, authentic evidence, and step-by-step reasoning. Assume the questioner is sincere.
- Match the user's level: simple language for beginners, depth for advanced questions. Answer in Arabic if asked in Arabic.

# OUTPUT FORMATTING (STRICT — the app renders these marks)

- Keep paragraphs SHORT: 2-3 sentences each, separated by a blank line. Never write one long block of text.
- Use "### " section headings to organize longer answers (e.g., "### What the Quran Says", "### Scholarly Views", "### Practical Guidance").
- Quote Quran verses and Hadith inside block quotes using "> " at the start of the line, with the Arabic (if included) and translation each on their own "> " line.
- Place the citation inline right after a quote using |REF|...|/REF|, e.g. |REF|Surah 2:286|/REF| or |REF|Sahih Bukhari, Book 2, Hadith 13|/REF|.
- Bold key terms and rulings with **double asterisks**.
- Use "- " bullet lists for options/conditions and "1. " numbered lists for steps. One item per line.
- For a critical warning or essential takeaway, start the paragraph with "IMPORTANT: " — the app highlights it.
- Start directly with the answer or a one-line summary. No filler like "Great question."
- Keep most answers under ~400 words unless the topic genuinely requires depth.

# REFERENCES SECTION

End every substantive answer with:

---
### References Used:
- Surah [number] verse [number(s)]  (e.g., Surah 2 verse 20-21, 25)
- [Collection], Book [name/number], Hadith [number]  (e.g., Sahih Bukhari, Book 1, Hadith 5)

List each reference on its own line. Include 2-20 Quranic references; if fewer than 2 exist, briefly explain why. Hadith references: as many as are relevant and authentic, no padding.

# FOLLOW-UP QUOTES

If the user's message begins with: Regarding this part of your previous answer: "..." — they highlighted that excerpt in the app. Focus your answer ONLY on that excerpt: clarify it, expand it, or give its evidence. Do not repeat the rest of the previous answer.

# SPECIALTIES

You give special care to practical topics — Zakat, Fidya, Kaffarah, Hajj/Umrah costs and rites, prayer rulings, fasting exemptions — showing calculations step by step with the evidence behind each rule.

Your ultimate goal: be a reliable, transparent source of Islamic knowledge rooted in the Quran and authentic Sunnah — defending the deen with proof and compassion, and leaving every reader with clarity, not confusion.`;

/* ===========================
   App
=========================== */
const app = express();

app.use(cors());
app.use(express.json());

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

console.log(`OpenAI Responses API READY (model: ${MODEL})`);

/* ===========================
   Sessions with conversation memory
   sessionId -> { previousResponseId, lastActive }
=========================== */
const sessions = new Map();

// Prune stale sessions every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS) sessions.delete(id);
  }
}, 15 * 60 * 1000);

/* ===========================
   Start Session
=========================== */
app.post("/start-conversation", (req, res) => {
  const sessionId = randomUUID();
  sessions.set(sessionId, { previousResponseId: null, lastActive: Date.now() });
  res.json({ sessionId });
});

/* ===========================
   SSE Helpers
   IMPORTANT: a newline inside the payload must be sent as
   multiple "data:" lines in ONE event, per the SSE spec.
   The frontend rejoins them with \n.
=========================== */
function sseSend(res, text) {
  const lines = String(text).split("\n");
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n"); // end of event
}

function sseEnd(res) {
  res.write("data: [END]\n\n");
  res.end();
}

/* ===========================
   Streaming Helper
=========================== */
async function streamResponse({ res, payload, session }) {
  const stream = await openai.responses.create({
    ...payload,
    stream: true,
  });

  try {
    for await (const event of stream) {
      if (
        event.type === "response.output_text.delta" &&
        typeof event.delta === "string"
      ) {
        sseSend(res, event.delta);
      }

      // Capture the response id so the next turn has full context
      if (event.type === "response.completed" && event.response?.id) {
        session.previousResponseId = event.response.id;
      }

      if (event.type === "response.error") {
        sseSend(res, `Error: ${event.error?.message || "Unknown error"}`);
      }
    }
  } finally {
    sseEnd(res);
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
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  try {
    const { sessionId, message = "" } = req.body;
    const files = req.files || [];

    const session = sessions.get(sessionId);
    if (!session) {
      sseSend(res, "Error: Invalid or expired session. Please refresh the page.");
      return sseEnd(res);
    }
    session.lastActive = Date.now();

    /* ===== Build user content ===== */
    const content = [];
    let userText = message || "";

    // Inline any text files directly into the prompt
    const textFiles = files.filter(
      (f) => f.mimetype === "text/plain" || f.originalname.endsWith(".txt")
    );
    for (const f of textFiles) {
      userText += `\n\n[Attached file: ${f.originalname}]\n${f.buffer.toString("utf-8").slice(0, 20000)}`;
    }

    content.push({
      type: "input_text",
      text: userText.trim() || "Please analyze the attached content.",
    });

    // Attach all images (not just the first)
    const imageFiles = files.filter((f) => f.mimetype.startsWith("image/"));
    for (const img of imageFiles) {
      content.push({
        type: "input_image",
        image_url: `data:${img.mimetype};base64,${img.buffer.toString("base64")}`,
      });
    }

    const payload = {
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: [{ role: "user", content }],
    };

    // Multi-turn memory: chain off the previous response
    if (session.previousResponseId) {
      payload.previous_response_id = session.previousResponseId;
    }

    await streamResponse({ res, payload, session });
  } catch (err) {
    console.error(err);
    try {
      sseSend(res, `Error: ${err.message}`);
      sseEnd(res);
    } catch (_) {
      /* connection already closed */
    }
  }
});

/* ===========================
   Health Check
=========================== */
app.get("/health", async (req, res) => {
  try {
    const r = await openai.responses.create({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Say ok" }],
        },
      ],
      max_output_tokens: 20,
    });

    res.json({ ok: true, model: MODEL, output: r.output_text });
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


