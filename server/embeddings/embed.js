import { log, logError } from "../log.js";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const MAX_BATCH = 100;

/**
 * Embed an array of texts using OpenAI's embedding API.
 * Returns null if OPENAI_API_KEY is not set.
 */
export async function embedTexts(texts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const results = new Array(texts.length);

  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, input: batch, dimensions: DIMENSIONS }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings API error ${res.status}: ${body}`);
    }

    const json = await res.json();
    for (const item of json.data) {
      results[i + item.index] = item.embedding;
    }

    // Rate-limit courtesy pause between batches
    if (i + MAX_BATCH < texts.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return results;
}

export { DIMENSIONS };
