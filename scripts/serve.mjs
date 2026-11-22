/**
 * 极简静态服务器（零依赖），用于 `npm run preview`。
 *
 * 为什么不用 `vite preview`：实测 WebKit/Safari 内核在请求带 `crossorigin`
 * 的 module script 时，vite preview 会对同一 keep-alive 连接上的 JS 资源返回 404
 * （直接访问该 URL 却是 200），导致 Safari 打开是白屏。换成一个行为可预期的
 * 静态服务器后，Safari / Chromium / Firefox 都能正常加载。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'dist');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendFile(req, res, filePath, statusCode = 200) {
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const { size } = statSync(filePath);
  res.writeHead(statusCode, {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': 'no-cache',
    // 允许 file:// 或其它静态托管场景下的同源/跨源加载
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // 防目录穿越：规范化后必须仍在 dist 内
  const relative = normalize(pathname).replace(/^([/\\])+/, '');
  let filePath = join(ROOT, relative);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    sendFile(req, res, filePath);
    return;
  }

  // SPA 回退：无扩展名的路径回 index.html；带扩展名的资源缺失就老实 404
  if (!extname(pathname)) {
    const fallback = join(ROOT, 'index.html');
    if (existsSync(fallback)) {
      sendFile(req, res, fallback, 200);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`um-next static server: http://${HOST}:${PORT}  (root: ${ROOT})`);
});
