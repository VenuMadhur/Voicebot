// pages/index.js  — recruiter UI with robust reply extraction + auto-play
import React, { useEffect, useRef, useState } from "react";

const DEMO_IMAGE_URL = "/demo-screenshot.png"; // copy your screenshot to public/demo-screenshot.png

export default function Home() {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [textFallback, setTextFallback] = useState("");

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recognitionRef = useRef(null);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (ev) => {
      let interim = "";
      let final = "";
      for (let i = ev.resultIndex; i < ev.results.length; ++i) {
        const r = ev.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      const combined = (final + (interim ? " " + interim : "")).trim();
      if (combined) {
        recognitionRef.current = recognitionRef.current || {};
        recognitionRef.current._lastTranscript = combined;
        setTranscript(combined);
      }
    };

    rec.onend = () => {};
    rec.onerror = (e) => console.warn("SpeechRecognition error:", e);
    recognitionRef.current = rec;
  }, []);

  // --- UTILS ---
  function blobToBase64(blob) {
    return new Promise((res) => {
      const reader = new FileReader();
      reader.onloadend = () => res(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  function speakReplyText(textToSpeak) {
    if (!textToSpeak) return;
    if (!("speechSynthesis" in window)) {
      setError("Speech synthesis not supported by this browser.");
      return;
    }
    // user already interacted (clicked record/send), so play should be allowed
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(textToSpeak);
    u.rate = 1.0;
    u.pitch = 1.0;
    u.lang = "en-US";
    window.speechSynthesis.speak(u);
  }

  // Try to extract a clean reply from various possible response shapes
  function extractBestReply(apiJson, fallbackTranscript) {
    if (!apiJson) {
      // fallback to transcript if provided
      return fallbackTranscript || "";
    }

    // 1) If server returned `reply` explicitly
    if (typeof apiJson.reply === "string" && apiJson.reply.trim()) return apiJson.reply.trim();

    // 2) If server returned a field `transcript` + `reply` in voice responses
    if (typeof apiJson.transcript === "string" && typeof apiJson.reply === "string" && apiJson.reply.trim()) {
      return apiJson.reply.trim();
    }

    // 3) Try raw candidate content (Gemini style)
    try {
      const cands = apiJson.raw?.candidates || apiJson.candidates || apiJson?.raw?.candidates;
      const first = Array.isArray(cands) ? cands[0] : apiJson.raw?.candidates?.[0];
      if (first?.content?.parts) {
        const text = first.content.parts.map((p) => p.text || "").join("\n").trim();
        if (text) {
          // prefer text after "Answer:" if present
          if (text.includes("Answer:")) {
            return text.split("Answer:").slice(1).join("Answer:").trim();
          }
          // if only "Transcript:" present, return fallback transcript (not ideal)
          if (text.includes("Transcript:") && !text.includes("Answer:")) {
            // try to get text after Transcript:
            const after = text.split("Transcript:").slice(1).join("Transcript:").trim();
            // if after looks like a question (starts with 'Tell' or 'What'), then fallback to fallbackTranscript
            if (/^(Tell|What|How|Why|Do|Is)\b/i.test(after)) {
              return fallbackTranscript || after;
            }
            return after;
          }
          return text;
        }
      }

      // 4) other possible shapes: outputText or output arrays
      if (typeof apiJson.raw?.outputText === "string" && apiJson.raw.outputText.trim()) return apiJson.raw.outputText.trim();
      if (typeof apiJson.outputText === "string" && apiJson.outputText.trim()) return apiJson.outputText.trim();

      if (Array.isArray(apiJson.raw?.output)) {
        const joined = apiJson.raw.output.map((o) => (typeof o === "string" ? o : (o?.content?.text || ""))).join("\n").trim();
        if (joined) return joined;
      }
    } catch (e) {
      // ignore extraction error
    }

    // 5) fallback: use any 'raw' string content
    if (typeof apiJson.raw === "string" && apiJson.raw.trim()) return apiJson.raw.trim();

    // 6) last resort: fallback transcript (what user said)
    return fallbackTranscript || "";
  }

  // --- RECORDING FLOW ---
  async function startRecording() {
    setError("");
    setReply("");
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      mediaRecorderRef.current.ondataavailable = (e) => chunksRef.current.push(e.data);
      mediaRecorderRef.current.onstop = processAudio;
      mediaRecorderRef.current.start();
      try { recognitionRef.current?.start(); } catch (e) {}
      setRecording(true);
    } catch (e) {
      console.error(e);
      setError("Please allow microphone access to use the demo.");
    }
  }

  function stopRecording() {
    setRecording(false);
    try { mediaRecorderRef.current?.stop(); } catch (e) {}
    try { recognitionRef.current?.stop(); } catch (e) {}
  }

  // --- CORE: process audio (prefers STT text path) ---
  async function processAudio() {
    setProcessing(true);
    setError("");
    try {
      const liveTranscript =
        (transcript && transcript.trim().length > 0)
          ? transcript.trim()
          : (recognitionRef.current && recognitionRef.current._lastTranscript ? recognitionRef.current._lastTranscript.trim() : "");

      if (liveTranscript) {
        // call text endpoint
        const r = await fetch("/api/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: liveTranscript })
        });
        const json = await r.json().catch(() => ({}));
        const best = extractBestReply(json, liveTranscript);
        setReply(best || "(no reply)");
        // auto speak
        if (best) speakReplyText(best);
        setTranscript(liveTranscript);
        setProcessing(false);
        if (recognitionRef.current) recognitionRef.current._lastTranscript = "";
        return;
      }

      // fallback: send audio blob to /api/voice
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const base64 = await blobToBase64(blob);
      const r2 = await fetch("/api/voice", { method: "POST", headers: { "Content-Type": "text/plain" }, body: base64 });
      const json2 = await r2.json().catch(() => ({}));
      const best2 = extractBestReply(json2, json2?.transcript || "");
      setReply(best2 || "(no reply)");
      if (best2) speakReplyText(best2);
      setTranscript(json2?.transcript || transcript || "");
    } catch (e) {
      console.error("processAudio error:", e);
      setError("Network or server error. Try again.");
    } finally {
      setProcessing(false);
    }
  }

  // --- Text fallback send ---
  async function sendTextFallback() {
    if (!textFallback) return;
    setProcessing(true);
    setError("");
    try {
      const r = await fetch("/api/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: textFallback }) });
      const json = await r.json().catch(() => ({}));
      const best = extractBestReply(json, textFallback);
      setReply(best || "(no reply)");
      if (best) speakReplyText(best);
    } catch (e) {
      console.error("sendTextFallback error:", e);
      setError("Network error.");
    } finally {
      setProcessing(false);
    }
  }

  function copyReply() {
    if (!reply) return;
    navigator.clipboard?.writeText(reply);
  }

  function manualPlay() {
    if (!reply) return;
    speakReplyText(reply);
  }

  const examples = [
    "Tell me about yourself.",
    "What's your #1 superpower?",
    "What are the top 3 areas you'd like to grow in?",
    "What misconception do your coworkers have about you?",
    "How do you push your boundaries and limits?"
  ];

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(180deg,#071024,#0a0f1a)", color: "white", padding: 28, fontFamily: "Inter, Arial, sans-serif" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <h1 style={{ margin: 0 }}>Generative AI Voicebot — Recruiter Demo</h1>
            <div style={{ color: "#94a3b8", fontSize: 13 }}>Persona: Venu (Student / Fresher)</div>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 13 }}>Tip: Use Chrome/Edge for the best mic support</div>
        </header>

        <main style={{ background: "rgba(255,255,255,0.03)", padding: 18, borderRadius: 12 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={processing}
              style={{ padding: "10px 16px", borderRadius: 8, border: "none", background: recording ? "#ef4444" : "#10b981", color: recording ? "white" : "black", fontWeight: 700, cursor: "pointer" }}
            >
              {processing ? "Processing…" : (recording ? "Stop" : "Record")}
            </button>

            <button
              onClick={() => { setTranscript(""); setReply(""); setError(""); if (recognitionRef.current) recognitionRef.current._lastTranscript = ""; }}
              style={{ padding: "10px 12px", borderRadius: 8, background: "transparent", border: "1px solid rgba(255,255,255,0.04)", color: "#cbd5e1" }}
            >
              Clear
            </button>

            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button onClick={manualPlay} disabled={!reply} style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "none" }}>
                Play Reply
              </button>
              <button onClick={copyReply} disabled={!reply} style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "none" }}>
                Copy Reply
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>Transcript</div>
              <div style={{ minHeight: 120, background: "rgba(255,255,255,0.02)", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap" }}>{transcript || "(no transcript)"}</div>
            </div>

            <div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>Bot Reply</div>
              <div style={{ minHeight: 120, background: "rgba(255,255,255,0.02)", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap" }}>{reply || "(no reply)"}</div>
            </div>
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input value={textFallback} onChange={(e) => setTextFallback(e.target.value)} placeholder="Type a question (fallback)" style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,0.03)", background: "rgba(255,255,255,0.02)", color: "white" }} />
            <button onClick={sendTextFallback} disabled={processing || !textFallback} style={{ padding: "10px 12px", borderRadius: 8, background: "#3b82f6", color: "white", border: "none" }}>Send Text</button>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {examples.map(ex => <button key={ex} onClick={() => setTextFallback(ex)} style={{ padding: "8px 10px", borderRadius: 8, background: "transparent", border: "1px solid rgba(255,255,255,0.04)" }}>{ex}</button>)}
            </div>
          </div>

          {error && <div style={{ marginTop: 12, color: "#fecaca" }}>{error}</div>}

          <div style={{ marginTop: 18, display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 360px" }}>
              <h4 style={{ margin: "0 0 8px 0" }}>How to demo</h4>
              <ol style={{ color: "#cbd5e1", paddingLeft: 18 }}>
                <li>Click <strong>Record</strong>, ask one of the example questions aloud, then click <strong>Stop</strong>.</li>
                <li>Or pick an example and click <strong>Send Text</strong> to test without a mic.</li>
                <li>Click <strong>Play Reply</strong> to hear the bot speak its response (or it should auto-play).</li>
              </ol>
              <div style={{ marginTop: 10, fontSize: 13, color: "#94a3b8" }}>Note: API keys are stored securely on the server and not exposed in this UI.</div>
            </div>

            <div style={{ width: 320, textAlign: "center" }}>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8 }}>Demo preview</div>
              <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.04)" }}>
                <img alt="demo preview" src={DEMO_IMAGE_URL} style={{ width: "100%", display: "block" }} />
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "#94a3b8" }}>Screenshot preview for reviewers</div>
            </div>
          </div>
        </main>

        <footer style={{ marginTop: 18, color: "#94a3b8", fontSize: 12 }}>
          Deploy note: set <code>GEMINI_API_KEY</code> as a server-side environment variable (do not expose it).
        </footer>
      </div>
    </div>
  );
}
