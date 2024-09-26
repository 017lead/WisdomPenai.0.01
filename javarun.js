import { Handler } from '@netlify/functions'
import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export const handler: Handler = async (event, context) => {
  const { message, assistantId, threadId } = JSON.parse(event.body || '{}')

  let currentAssistantId = assistantId
  let currentThreadId = threadId

  if (!currentAssistantId) {
    const assistant = await openai.beta.assistants.create({
      name: "Wisdom Pen Islamic AI",
      instructions: "You are an AI assistant specializing in Islamic teachings, including the Quran, Bible, Torah, and Hadiths. Always greet the user with 'Assalamu alaikum' (Peace be upon you).",
      tools: [{ type: "code_interpreter" }],
      model: "gpt-4o-mini"
    })
    currentAssistantId = assistant.id
  }

  if (!currentThreadId) {
    const thread = await openai.beta.threads.create()
    currentThreadId = thread.id
  }

  await openai.beta.threads.messages.create(
    currentThreadId,
    {
      role: "user",
      content: message
    }
  )

  const run = await openai.beta.threads.runs.create(
    currentThreadId,
    { assistant_id: currentAssistantId }
  )

  let response = ''
  while (true) {
    const runStatus = await openai.beta.threads.runs.retrieve(currentThreadId, run.id)
    if (runStatus.status === 'completed') {
      const messages = await openai.beta.threads.messages.list(currentThreadId)
      response = messages.data[0].content[0].text.value
      break
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      response,
      assistantId: currentAssistantId,
      threadId: currentThreadId
    })
  }
}
