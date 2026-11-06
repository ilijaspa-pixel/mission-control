// POST /api/paste-image
//
// Receives an image file from the Mission Control QuickInputBar (typically
// pasted from the clipboard) and writes it to a stable temp directory so
// the user can reference the file path in a message to Claude Code. The
// PTY-bound `claude` process can then read the file via its Read tool.
//
// Body: multipart/form-data with a single "file" field.
// Returns: { path: "/tmp/cc-pastes/screenshot-<ts>.<ext>" }

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extFor(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  return "bin";
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return Response.json({ error: "missing file" }, { status: 400 });
  }
  const blob = file as File;
  if (!blob.type.startsWith("image/")) {
    return Response.json({ error: "not an image" }, { status: 415 });
  }

  const dir = join(tmpdir(), "cc-pastes");
  await mkdir(dir, { recursive: true });
  const ts = Date.now();
  const raw = Buffer.from(await blob.arrayBuffer());

  // Compress: resize to max 1200px wide and convert to JPEG at 70% quality.
  // This cuts ~1.5MB PNGs down to ~100-200KB, making Claude's Read much faster.
  let compressed: Buffer;
  try {
    compressed = await sharp(raw)
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch {
    // Fallback to raw if sharp fails (e.g. unsupported format).
    compressed = raw;
  }

  const ext = compressed === raw ? extFor(blob.type) : "jpg";
  const path = join(dir, `screenshot-${ts}.${ext}`);
  await writeFile(path, compressed);

  return Response.json({ path });
}
