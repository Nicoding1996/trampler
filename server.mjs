// Zero-dependency static file server for the prototype.
// Usage: node server.mjs  ->  http://localhost:5173
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary",
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^([/\\])+/, "");
    const filePath = join(ROOT, rel);

    // Prevent path traversal outside the project root.
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch (err) {
    const code = err.code === "ENOENT" || err.code === "EISDIR" ? 404 : 500;
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(code === 404 ? "Not found" : "Server error");
  }
});

// Bound to loopback on purpose. This serves every file under the project root,
// so it has no business being reachable from the rest of the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Trampler feel test -> http://localhost:${PORT}`);
});
