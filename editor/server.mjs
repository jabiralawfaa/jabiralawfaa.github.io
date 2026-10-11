// Local content editor server — zero dependencies (Node 22 built-ins only).
// Edits src/data/*.json via a local form UI and commits through the
// GitHub Contents API. The existing deploy workflow stays the only deploy path.
//
// Usage:
//   npm run editor            (from repo root)
//   DRY_RUN=1 npm run editor  (validate + preview, no commits)
//
// Config (process.env, then optional editor/.env as KEY=VALUE):
//   GITHUB_TOKEN   PAT with contents:write (repo scope or fine-grained Contents R/W)
//   GITHUB_REPO    owner/name — auto-detected from `git remote get-url origin` if unset
//   GITHUB_BRANCH  default 'main'
//   DRY_RUN        '1' or 'true' to disable all GitHub writes
//   EDITOR_PORT    default 8787

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { FILES } from './schema.mjs';

const BOOT_START = Date.now();

const EDITOR_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(EDITOR_DIR, '..');
const PUBLIC_DIR = path.join(EDITOR_DIR, 'public');
const MAX_BODY = 15 * 1024 * 1024; // 15 MB (image uploads)

// ---------- config ----------

function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(EDITOR_DIR, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env file — fine */ }
}

function detectRepo() {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // boot guard: a slow/stuck git must never hang the editor
      timeout: 5000,
      windowsHide: true,
    }).trim();
    const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch { /* no remote, non-github remote, or timeout — boot continues without a repo */ }
  return null;
}

loadDotEnv();

const TOKEN = process.env.GITHUB_TOKEN || null;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const PORT = Number(process.env.EDITOR_PORT) || 8787;
let REPO = process.env.GITHUB_REPO || detectRepo();

// ---------- helpers ----------

function ghHeaders() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'local-content-editor',
  };
}

// Submitted data wins; existing extra keys are preserved (lossless round-trip
// even if the schema lags behind the data). Arrays replace wholesale.
function deepMerge(existing, submitted) {
  if (Array.isArray(submitted)) return submitted;
  if (
    submitted && typeof submitted === 'object' &&
    existing && typeof existing === 'object' && !Array.isArray(existing)
  ) {
    const out = { ...existing };
    for (const k of Object.keys(submitted)) {
      out[k] = deepMerge(existing[k], submitted[k]);
    }
    return out;
  }
  return submitted;
}

function validateFields(fields, data, prefix, issues) {
  for (const f of fields) {
    const p = prefix ? `${prefix}.${f.name}` : f.name;
    const v = data ? data[f.name] : undefined;
    if (v === undefined || v === null) {
      if (f.required !== false) issues.push({ path: p, message: 'required' });
      continue;
    }
    switch (f.type) {
      case 'string':
      case 'text':
      case 'image': {
        if (typeof v !== 'string') issues.push({ path: p, message: `expected string, got ${typeof v}` });
        else if (f.required !== false && v.trim() === '') issues.push({ path: p, message: 'must not be empty' });
        break;
      }
      case 'select': {
        if (typeof v !== 'string') issues.push({ path: p, message: `expected string, got ${typeof v}` });
        else if (!f.options.includes(v)) issues.push({ path: p, message: `must be one of: ${f.options.join(', ')}` });
        break;
      }
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v)) issues.push({ path: p, message: 'expected a finite number' });
        break;
      }
      case 'boolean': {
        if (typeof v !== 'boolean') issues.push({ path: p, message: 'expected true/false' });
        break;
      }
      case 'object': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) issues.push({ path: p, message: 'expected object' });
        else validateFields(f.fields, v, p, issues);
        break;
      }
      case 'list': {
        if (!Array.isArray(v)) { issues.push({ path: p, message: 'expected array' }); break; }
        v.forEach((item, i) => {
          const ip = `${p}[${i}]`;
          if (f.itemType === 'string') {
            if (typeof item !== 'string') issues.push({ path: ip, message: 'expected string' });
          } else if (!item || typeof item !== 'object' || Array.isArray(item)) {
            issues.push({ path: ip, message: 'expected object' });
          } else {
            validateFields(f.itemFields, item, ip, issues);
          }
        });
        break;
      }
      default:
        issues.push({ path: p, message: `unknown schema type: ${f.type}` });
    }
  }
}

async function ghGetSha(filePath) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${filePath}?ref=${BRANCH}`,
    { headers: ghHeaders() },
  );
  if (res.status === 404) return null; // create (no sha)
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GET ${filePath} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.sha || null;
}

async function ghPut(filePath, message, contentBase64, sha) {
  const payload = { message, content: contentBase64, branch: BRANCH };
  if (sha) payload.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${filePath}`,
    { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(payload) },
  );
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`GitHub PUT ${filePath} failed (${res.status}): ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------- request plumbing ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serveStatic(res, urlPath) {
  // '/static/<file>' maps to editor/public/<file>; '/' maps to index.html
  let rel = urlPath === '/' ? '/index.html' : urlPath.replace(/^\/static(?=\/|$)/, '');
  if (rel === '' || rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- routes ----------

function handleState(res) {
  const data = {};
  for (const f of FILES) {
    data[f.key] = JSON.parse(fs.readFileSync(path.join(ROOT, f.path), 'utf8'));
  }
  send(res, 200, {
    schema: FILES,
    data,
    config: {
      repo: REPO,
      branch: BRANCH,
      dryRun: DRY_RUN,
      hasToken: Boolean(TOKEN),
    },
  });
}

async function handleSave(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return send(res, 400, { ok: false, error: 'malformed JSON body' }); }

  const entry = FILES.find((f) => f.key === body?.file);
  if (!entry) return send(res, 400, { ok: false, error: `unknown file key: ${body?.file}` });

  const issues = [];
  validateFields(entry.fields, body.data, '', issues);
  if (issues.length) return send(res, 400, { ok: false, issues });

  const existing = JSON.parse(fs.readFileSync(path.join(ROOT, entry.path), 'utf8'));
  const merged = deepMerge(existing, body.data);
  const serialized = JSON.stringify(merged, null, 2) + '\n';

  if (DRY_RUN || !TOKEN) {
    return send(res, 200, {
      ok: true, dryRun: true, path: entry.path,
      bytes: Buffer.byteLength(serialized),
      note: DRY_RUN ? 'DRY_RUN enabled — nothing committed' : 'GITHUB_TOKEN missing — nothing committed',
    });
  }
  if (!REPO) return send(res, 500, { ok: false, error: 'GITHUB_REPO not set and not detectable from git remote' });

  try {
    const sha = await ghGetSha(entry.path);
    const result = await ghPut(
      entry.path,
      `content(editor): update ${entry.path}`,
      Buffer.from(serialized, 'utf8').toString('base64'),
      sha,
    );
    send(res, 200, { ok: true, dryRun: false, path: entry.path, commit: result?.commit?.sha?.slice(0, 7) || null });
  } catch (e) {
    send(res, e.status || 502, { ok: false, error: e.message });
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

async function handleUpload(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return send(res, 400, { ok: false, error: 'malformed JSON body' }); }

  const name = typeof body?.name === 'string' ? body.name : '';
  const b64 = typeof body?.base64 === 'string' ? body.base64 : '';
  // reject any path components before basename — traversal never proceeds
  if (!name || /[\\/]/.test(name) || name !== path.basename(name) || !IMAGE_EXT.test(name)) {
    return send(res, 400, { ok: false, error: 'invalid image name (letters, digits, . _ - and an image extension only)' });
  }
  if (!b64) return send(res, 400, { ok: false, error: 'missing base64 content' });

  const filePath = `public/img/${name}`;
  const url = `/img/${name}`;

  if (DRY_RUN || !TOKEN) {
    return send(res, 200, { ok: true, dryRun: true, url, note: 'not uploaded' });
  }
  if (!REPO) return send(res, 500, { ok: false, error: 'GITHUB_REPO not set and not detectable from git remote' });

  try {
    const sha = await ghGetSha(filePath);
    const result = await ghPut(filePath, `content(editor): add image ${name}`, b64, sha);
    send(res, 200, { ok: true, dryRun: false, url, commit: result?.commit?.sha?.slice(0, 7) || null });
  } catch (e) {
    send(res, e.status || 502, { ok: false, error: e.message });
  }
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return handleState(res);
    if (req.method === 'POST' && url.pathname === '/api/save') return handleSave(req, res);
    if (req.method === 'POST' && url.pathname === '/api/upload') return handleUpload(req, res);
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    send(res, 405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    send(res, e.status || 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[editor] http://127.0.0.1:${PORT} (boot ${Date.now() - BOOT_START}ms)`);
  console.log(`[editor] repo=${REPO || '(not set)'} branch=${BRANCH}`);
  console.log(`[editor] dryRun=${DRY_RUN} hasToken=${Boolean(TOKEN)}`);
  if (DRY_RUN) console.log('[editor] DRY_RUN active — saves are validated but never committed');
  else if (!TOKEN) console.log('[editor] no GITHUB_TOKEN — saves are dry-run only; set it in editor/.env');
});
