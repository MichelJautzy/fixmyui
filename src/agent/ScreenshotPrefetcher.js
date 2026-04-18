import fs from 'fs/promises';
import path from 'path';

/**
 * Attachment prefetch (fixmyui >= 2.0.1, multi-format since 2.1.0)
 *
 * The SaaS FixmyuiPromptBuilder injects attachment URLs (Cloudflare R2 / S3)
 * as text inside `compiled_prompt`. On a headless `claude -p` run, Claude Code
 * may need a permission prompt to fetch that URL over the network — which is
 * impossible without a TTY.
 *
 * To stay fully self-contained, the agent downloads each attachment locally
 * BEFORE spawning Claude and rewrites the prompt so Claude reads the file
 * from disk (via its built-in `Read` tool) instead of fetching it.
 *
 *   <repoPath>/.fixmyui-tmp/screenshot-<jobId>-<NN>.<ext>
 *
 * Since 2.1.0 the prefetcher accepts every file type Claude Code can ingest
 * natively: images, PDFs, and common text/code formats. The content-type
 * gate has been removed — anything the SaaS accepted on upload is allowed
 * through the pipe.
 *
 * The directory is added to `.git/info/exclude` (local, not committed) so
 * `git add -A` never stages it.
 *
 * If the download fails for any reason, we leave the original URL in the
 * prompt (graceful fallback — identical to fixmyui 2.0.0 behaviour).
 */

const TMP_DIR = '.fixmyui-tmp';
const EXCLUDE_ENTRY = `${TMP_DIR}/`;

const EXT_FROM_CONTENT_TYPE = {
  // images
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  // pdf
  'application/pdf': 'pdf',
  // text / code
  'text/html': 'html',
  'text/css': 'css',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
};

const KNOWN_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
  'pdf',
  'html', 'htm', 'css', 'js', 'json', 'md', 'txt', 'csv', 'xml',
  'yaml', 'yml', 'ts', 'tsx', 'jsx', 'vue', 'php',
];

function guessExtFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const m = pathname.toLowerCase().match(new RegExp(`\\.(${KNOWN_EXTENSIONS.join('|')})(?:$|[?#])`));
    if (!m) return null;
    return m[1] === 'jpeg' ? 'jpg' : m[1];
  } catch {
    return null;
  }
}

async function ensureGitExclude(repoPath) {
  const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
  try {
    let body = '';
    try {
      body = await fs.readFile(excludePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.includes(EXCLUDE_ENTRY) || lines.includes(TMP_DIR)) return;

    const prefix = body === '' || body.endsWith('\n') ? body : `${body}\n`;
    const appended = `${prefix}\n# FixMyUI agent — local screenshot prefetch (do not commit)\n${EXCLUDE_ENTRY}\n`;
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, appended, 'utf8');
  } catch {
    // Best-effort — if we cannot write .git/info/exclude (e.g. missing .git
    // dir because repoPath isn't a git repo yet), the rest of the pipeline
    // will still abort later in assertIsRepo. We do not rethrow here.
  }
}

/**
 * Download one image at `url` into the repo's local tmp dir and return the
 * absolute local path plus a cleanup fn.
 *
 * @param {string} url                                       HTTP(S) URL of the image
 * @param {{ repoPath: string, jobId: string, index?: number, fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number }} opts
 * @returns {Promise<{ localPath: string, cleanup: () => Promise<void> }>}
 * @throws if the URL is not reachable / not an image / too large.
 */
export async function prefetchScreenshot(url, opts = {}) {
  const {
    repoPath,
    jobId,
    index = 0,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    maxBytes = 30 * 1024 * 1024, // 30 MB safety cap (server caps uploads at 20 MB; headroom for redirects/headers)
  } = opts;

  if (!url) throw new Error('prefetchScreenshot: url is required');
  if (!repoPath) throw new Error('prefetchScreenshot: repoPath is required');
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable — requires Node.js 18+');
  }

  const dir = path.join(repoPath, TMP_DIR);
  await fs.mkdir(dir, { recursive: true });
  await ensureGitExclude(repoPath);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error('Empty attachment body');
  if (buf.byteLength > maxBytes) {
    throw new Error(`Attachment too large: ${buf.byteLength} bytes (cap: ${maxBytes})`);
  }

  // Resolve the on-disk extension. Order:
  //   1. content-type → known map
  //   2. URL path → known extension
  //   3. raw subtype after `application/` or `text/` (e.g. `application/pdf` → `pdf`)
  //   4. generic fallback (`bin`)
  let ext = EXT_FROM_CONTENT_TYPE[contentType] || guessExtFromUrl(url);
  if (!ext && contentType) {
    const sub = contentType.split('/')[1] || '';
    if (sub && /^[a-z0-9.+-]{1,12}$/i.test(sub)) {
      ext = sub.replace(/^x-/, '').replace(/\+.*$/, '');
    }
  }
  if (!ext) ext = 'bin';
  const safeJobId = String(jobId || 'job').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'job';
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  const filename = `screenshot-${safeJobId}-${String(safeIndex).padStart(2, '0')}.${ext}`;
  const filePath = path.join(dir, filename);

  await fs.writeFile(filePath, buf);

  return {
    localPath: filePath,
    cleanup: async () => {
      try { await fs.unlink(filePath); } catch { /* ignore */ }
      try {
        const remaining = await fs.readdir(dir);
        if (remaining.length === 0) await fs.rmdir(dir);
      } catch { /* ignore */ }
    },
  };
}

/**
 * Download every image in `attachments` into the repo's local tmp dir.
 *
 * @param {Array<{url: string, name?: string|null}|string>} attachments
 * @param {{ repoPath: string, jobId: string, fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, onError?: (url: string, err: Error) => void }} opts
 * @returns {Promise<Array<{url: string, localPath: string, cleanup: () => Promise<void>}>>}
 *          — one entry per SUCCESSFULLY downloaded attachment (failures are
 *          reported to `onError` but do not reject the whole batch).
 */
export async function prefetchAttachments(attachments, opts = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return [];

  const { onError } = opts;
  const results = await Promise.all(list.map(async (att, i) => {
    const url = typeof att === 'string' ? att : (att?.url ?? '');
    if (!url) return null;
    try {
      const pre = await prefetchScreenshot(url, { ...opts, index: i });
      return { url, localPath: pre.localPath, cleanup: pre.cleanup };
    } catch (err) {
      if (typeof onError === 'function') onError(url, err);
      return null;
    }
  }));

  return results.filter(Boolean);
}

/**
 * Replace an attachment URL inside the compiled prompt with an instruction
 * that points to the local file. Claude Code's built-in `Read` tool opens
 * images, PDFs and text files natively, so no network fetch is needed.
 *
 * Idempotent: if the URL is not found (SaaS format changed), the prompt is
 * returned unchanged.
 */
export function rewritePromptWithLocalScreenshot(prompt, url, localPath) {
  if (!prompt || !url || !localPath) return prompt;
  if (!prompt.includes(url)) return prompt;

  const replacement =
    `Local file: ${localPath}\n` +
    `(The FixMyUI agent has already downloaded the file to this path — ` +
    `open it with your Read tool to view it. Do NOT attempt to fetch ` +
    `the network URL.)`;

  return prompt.split(url).join(replacement);
}

/**
 * Replace multiple URLs at once. Each prefetched attachment must expose
 * `url` and `localPath`. Returns the new prompt.
 *
 * @param {string} prompt
 * @param {Array<{url: string, localPath: string}>} prefetched
 * @returns {string}
 */
export function rewritePromptWithLocalScreenshots(prompt, prefetched) {
  if (!prompt || !Array.isArray(prefetched)) return prompt;
  let out = prompt;
  for (const item of prefetched) {
    if (item?.url && item?.localPath) {
      out = rewritePromptWithLocalScreenshot(out, item.url, item.localPath);
    }
  }
  return out;
}
