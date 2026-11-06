// GET /api/local-image?path=/abs/path.png
//
// Lets the chat view show screenshots Claude saved on this Mac (markdown
// images like ![x](/private/tmp/.../shot.png)). Mission Control only listens
// on localhost, and this only serves image files from temp/scratch folders
// and the user's Desktop/Downloads, never anything else.

import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const ROOTS = [
  "/private/tmp/",
  "/tmp/",
  "/private/var/folders/",
  "/var/folders/",
  resolve(tmpdir()) + sep,
  resolve(homedir(), "Desktop") + sep,
  resolve(homedir(), "Downloads") + sep,
];

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("path") ?? "";
  const path = resolve(raw);
  const type = TYPES[extname(path).toLowerCase()];
  if (!type || !ROOTS.some((r) => path.startsWith(r))) {
    return new Response("not allowed", { status: 403 });
  }
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > 25 * 1024 * 1024) return new Response("not found", { status: 404 });
    const body = await readFile(path);
    return new Response(body, { headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
