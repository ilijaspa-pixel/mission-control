// POST /api/transcribe
//
// Receives audio (webm/ogg from MediaRecorder) and sends it to Groq's
// Whisper API for transcription. Returns { text: "..." }.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Optional: voice-to-text needs a Groq key in .env.local (GROQ_API_KEY=...). Without it, the mic button returns an error.
const GROQ_KEY = process.env.GROQ_API_KEY ?? "";

export async function POST(req: Request) {
  if (!GROQ_KEY) return Response.json({ error: "Voice input is off: add GROQ_API_KEY to .env.local (free key at console.groq.com)" }, { status: 400 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return Response.json({ error: "missing audio file" }, { status: 400 });
  }

  // Forward to Groq Whisper API.
  const groqForm = new FormData();
  groqForm.append("file", file, "audio.webm");
  groqForm.append("model", "whisper-large-v3-turbo");
  groqForm.append("language", "en");
  groqForm.append("response_format", "json");

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: groqForm,
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`[transcribe] Groq ${r.status}:`, body.slice(0, 500));
    return Response.json(
      { error: `Groq ${r.status}: ${body.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const result = (await r.json()) as { text?: string };
  return Response.json({ text: result.text ?? "" });
}
