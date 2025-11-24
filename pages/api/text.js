// pages/api/text.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "Missing text" });

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const CANDIDATE_NAME = process.env.CANDIDATE_NAME || "Venu";

    // TEMP fallback if key missing (lets frontend be tested)
    if (!GEMINI_KEY) {
      return res.status(200).json({
        reply: "I'm a final-year computer science student who builds practical ML projects and prototypes. I learn new tools quickly and deliver working demos to validate ideas.",
        raw: { note: "TEMP-FALLBACK: GEMINI_API_KEY missing" }
      });
    }

    const PERSONA = `
Respond as ${CANDIDATE_NAME}, a final-year computer science student (not an AI).
Speak in first-person. Friendly, confident, concise. ~25–40 seconds spoken length.
Start with a 1-line summary, then 1-2 supporting sentences, and a short closing line.
Include 1 brief concrete example or metric when helpful.
Never say you are an AI, model, or assistant.
`.trim();

    const SHOTS = `
Q: Tell me about yourself.
A: I'm a final-year CS student who builds practical ML projects and full-stack prototypes. I move quickly from idea to working demo — for example, I built a recommendation prototype that improved test engagement by 9%. I'm eager to learn and contribute to production systems.

Q: What's your #1 superpower?
A: I learn new technologies quickly and turn them into working features. I pick up tools fast and ship prototypes that validate ideas.
`.trim();

    const primaryPrompt = `
${PERSONA}

${SHOTS}

User question: ${text}

FORMAT:
Transcript: <user question>
Answer: <first-person answer>
`.trim();

    function extractText(json) {
      try {
        const cand = json?.candidates?.[0];
        if (cand?.content?.parts) {
          const t = cand.content.parts.map((p) => p.text || "").join("\n").trim();
          if (t) return t;
        }
        if (typeof json.outputText === "string" && json.outputText.trim()) return json.outputText.trim();
        if (Array.isArray(json.output) && json.output.length) {
          const parts = [];
          json.output.forEach((o) => {
            if (typeof o === "string") parts.push(o);
            if (o?.content) {
              if (Array.isArray(o.content)) o.content.forEach((c) => c?.text && parts.push(c.text));
              else if (typeof o.content === "string") parts.push(o.content);
            }
          });
          const joined = parts.join("\n").trim();
          if (joined) return joined;
        }
      } catch (e) {}
      return "";
    }

    const primaryPayload = {
      contents: [{ parts: [{ text: primaryPrompt }] }],
      generationConfig: { temperature: 0.18, maxOutputTokens: 400, candidateCount: 1, topP: 0.92 }
    };

    const primaryResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify(primaryPayload)
      }
    );

    const primaryJson = await primaryResp.json().catch(() => ({}));
    const extractedPrimary = extractText(primaryJson);
    const primaryFinish = primaryJson?.candidates?.[0]?.finishReason || primaryJson?.finishReason || null;

    if (!extractedPrimary || primaryFinish === "MAX_TOKENS") {
      const fallbackPrompt = `
${PERSONA}

${SHOTS}

User question: ${text}

FORMAT:
Transcript: <user question>
Answer: <first-person answer>

Please keep Answer in first-person and do not mention AI.
`.trim();

      const fallbackPayload = { contents: [{ parts: [{ text: fallbackPrompt }] }], generationConfig: { temperature: 0.15, maxOutputTokens: 1024, candidateCount: 1, topP: 0.9 } };

      const fbResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
          body: JSON.stringify(fallbackPayload)
        }
      );

      const fbJson = await fbResp.json().catch(() => ({}));
      const extractedFb = extractText(fbJson);

      if (!extractedFb) {
        return res.status(200).json({ reply: "", raw: fbJson, diagnostic: { message: "No text after fallback", primaryFinish } });
      }

      const replyText = (extractedFb.split("Answer:")[1] || extractedFb).trim();
      return res.status(200).json({ reply: replyText, raw: fbJson });
    }

    const reply = (extractedPrimary.split("Answer:")[1] || extractedPrimary).trim();
    return res.status(200).json({ reply, raw: primaryJson });
  } catch (err) {
    console.error("text handler error:", err);
    return res.status(500).json({ error: String(err) });
  }
}
