import fs from 'fs/promises';
import path from 'path';

/**
 * Screenshot prefetch (fixmyui >= 2.0.1)
 *
 * The SaaS FixmyuiPromptBuilder injects a screenshot URL (Cloudflare R2 / S3)
 * as text inside `compiled_prompt`. On a headless `claude -p` run, Claude Code
 * may need a permission prompt to fetch that URL over the network — which is
 * impossible without a TTY.
 *
 * To stay fully self-contained, the agent downloads the screenshot locally
 * BEFORE spawning Claude and rewrites the prompt so Claude reads the file
 * from disk (via its built-in `Read` tool) instead of fetching it.
 *
 *   <repoPath>/.fixmyui-tmp/screenshot-<jobId>.<ext>
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
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function guessExtFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const m = pathname.toLowerCase().match(/\.(png|jpe?g|webp|gif)(?:$|[?#])/);
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
 * Download the screenshot at `url` into the repo's local tmp dir and return
 * the absolute local path plus a cleanup fn.
 *
 * @param {string} url                                       HTTP(S) URL of the screenshot
 * @param {{ repoPath: string, jobId: string, fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number }} opts
 * @returns {Promise<{ localPath: string, cleanup: () => Promise<void> }>}
 * @throws if the URL is not reachable / not an image / too large.
 */
export async function prefetchScreenshot(url, opts = {}) {
  const {
    repoPath,
    jobId,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    maxBytes = 20 * 1024 * 1024, // 20 MB safety cap
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
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`Unexpected content-type "${contentType}" (expected image/*)`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error('Empty screenshot body');
  if (buf.byteLength > maxBytes) {
    throw new Error(`Screenshot too large: ${buf.byteLength} bytes (cap: ${maxBytes})`);
  }

  const ext = EXT_FROM_CONTENT_TYPE[contentType] || guessExtFromUrl(url) || 'png';
  const safeJobId = String(jobId || 'job').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'job';
  const filename = `screenshot-${safeJobId}.${ext}`;
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
 * Replace a screenshot URL inside the compiled prompt with an instruction
 * that points to the local file. Claude Code's built-in `Read` tool opens
 * image files natively, so no network fetch is needed.
 *
 * Idempotent: if the URL is not found (SaaS format changed), the prompt is
 * returned unchanged.
 *
 * @param {string} prompt      The compiled prompt text from the SaaS
 * @param {string} url         The URL to replace
 * @param {string} localPath   Absolute path to the downloaded screenshot
 * @returns {string}
 */
export function rewritePromptWithLocalScreenshot(prompt, url, localPath) {
  if (!prompt || !url || !localPath) return prompt;
  if (!prompt.includes(url)) return prompt;

  const replacement =
    `Local file: ${localPath}\n` +
    `(The FixMyUI agent has already downloaded the screenshot to this path — ` +
    `open it with your Read tool to view the image. Do NOT attempt to fetch ` +
    `the network URL.)`;

  return prompt.split(url).join(replacement);
}
