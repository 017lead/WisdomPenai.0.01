import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import NodeCache from "node-cache";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, ".env") });

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

/* HARD FAIL if Responses API is not present */
if (!openai.responses || typeof openai.responses.create !== "function") {
  console.error("FATAL: OpenAI SDK does NOT support Responses API");
  process.exit(1);
}

console.log("OpenAI Responses API READY");

/* ===========================
   Session → Conversation
=========================== */
const sessionConversations = new Map();

/* ===========================
   Start Conversation
=========================== */
app.post("/start-conversation", (req, res) => {
  const sessionId = randomUUID();
  const conversationId = randomUUID();

  sessionConversations.set(sessionId, conversationId);
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

  let full = [];
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      res.write(`data: ${event.delta}\n\n`);
      full.push(event.delta);
    }

    if (event.type === "response.error") {
      res.write(`data: Error: ${event.error?.message}\n\n`);
    }
  }

  res.write(`data: [END]\n\n`);
  res.end();

  if (cacheKey) cache.set(cacheKey, full);
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

    if (!sessionConversations.has(sessionId)) {
      res.write(`data: Error: Invalid session\n\n`);
      res.write(`data: [END]\n\n`);
      return res.end();
    }

    const conversation = sessionConversations.get(sessionId);
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
          { type: "text", text: message || "Describe this image" },
          {
            type: "image_url",
            image_url: { url: `data:${img.mimetype};base64,${base64}` },
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
          { type: "text", text: message || "Analyze this file" },
          {
            type: "input_file",
            file: { id: uploaded.id, filename: files[0].originalname },
          },
        ],
      }];
    }

    /* ===== Text ===== */
    else {
      input = [{
        role: "user",
        content: [{ type: "text", text: message }],
      }];
    }

    await streamResponse({
      res,
      cacheKey,
      payload: {
        model: "gpt-5.2",
        input,
        conversation,
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
      input: [{
        role: "user",
        content: [{ type: "text", text: "Say ok" }],
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



