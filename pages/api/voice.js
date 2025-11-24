// pages/api/voice.js
export const config = { api: { bodyParser: false } };

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CANDIDATE_NAME = process.env.CANDIDATE_NAME || "Venu";

const PERSONA = `Respond as ${CANDIDATE_NAME}, a final-year CS student. Speak in first-person, friendly, concise. Do not say you are an AI.`;

const SHOTS = `
Transcript: Tell me about yourself.
Answer: I'm a final-year CS student who builds practical ML projects. I moved from full-stack to ML, and built a prototype that improved engagement in a class project.
`;

async function collectBody(req) {
  return new Promise((resolve, reject) => {
    const data = [];
    req.on("data", (c) => data.push(c));
    req.on("end", () => resolve(Buffer.concat(data).toString()));
    req.on("error", reject);
  });
}

function extractText(json) {
  try {
    const c = json?.candidates?.[0];
    if (c?.content?.parts) {
      const t = c.content.parts.map((p) => p.text || "").join("\n").trim();
      if (t) return t;
    }
    if (json?.outputText) return json.outputText.trim();
  } catch (e) {}
  return "";
}

function clean(t) {
  return String(t || "").replace(/Transcript:/i, "").replace(/Answer:/i, "").trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
  }

  try {
    const raw = await collectBody(req);
    const m = raw.match(/data:audio\/[^;]+;base64,([A-Za-z0-9+/=]+)/) || raw.match(/^([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: "Invalid audio" });
    const base64 = m[1];

    const primaryPrompt = `
${PERSONA}

${SHOTS}

Answer the user's spoken question. Output exactly:
Transcript: <short transcript>
Answer: <first-person answer>
`.trim();

    const primaryPayload = {
      contents: [
        { parts: [{ text: primaryPrompt }, { inlineData: { mimeType: "audio/webm", data: base64 } }] }
      ],
      generationConfig: { temperature: 0.18, maxOutputTokens: 500, topP: 0.9 }
    };

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(primaryPayload)
    });

    const json = await r.json().catch(() => ({}));
    let txt = extractText(json);
    const fr = json?.candidates?.[0]?.finishReason;

    if (!txt || fr === "MAX_TOKENS") {
      const fbPrompt = `
${PERSONA}
${SHOTS}
Please provide Transcript and Answer in first-person.
`.trim();

      const fbPayload = {
        contents: [
          { parts: [{ text: fbPrompt }, { inlineData: { mimeType: "audio/webm", data: base64 } }] }
        ],
        generationConfig: { maxOutputTokens: 1024 }
      };

      const fbRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify(fbPayload)
      });
      const fbJson = await fbRes.json().catch(() => ({}));
      txt = extractText(fbJson);
      if (!txt) return res.status(200).json({ transcript: "", reply: "", raw: fbJson });
      const transcript = clean(txt.split("Answer:")[0]);
      const reply = clean(txt.split("Answer:")[1]);
      return res.status(200).json({ transcript, reply, raw: fbJson });
    }

    const transcript = clean(txt.split("Answer:")[0]);
    const reply = clean(txt.split("Answer:")[1]);
    return res.status(200).json({ transcript, reply, raw: json });
  } catch (e) {
    console.error("voice handler error:", e);
    return res.status(500).json({ error: String(e) });
  }
}
