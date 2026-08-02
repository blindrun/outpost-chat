import type { FastifyInstance } from "fastify";
import { z } from "zod";
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const previewSchema = z.object({ url: z.string().url().max(2048) });

const MAX_BYTES = 300 * 1024; // OG tags live in <head>, no need to read a whole page
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;

interface PreviewData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

// Client-fetched, best-effort, and looked up by an authenticated user for a
// URL someone else already posted — not sensitive enough to warrant DB
// persistence, an in-memory process-lifetime cache is enough to stop the
// same link being re-fetched by every viewer of the same message.
const cache = new Map<string, { data: PreviewData | null; expiresAt: number }>();

// SSRF guard. A user-posted URL is fetched *by the server*, so without this
// a malicious link could target internal-only infrastructure (cloud
// metadata endpoints, LAN admin panels, etc.) using this server's own
// network position. Blocking at the DNS-lookup layer (not just checking the
// URL's literal hostname) also closes the DNS-rebinding gap: this function
// is invoked fresh on every real TCP connect (including each redirect hop),
// so it can't be bypassed by a hostname that resolves differently between
// an earlier check and the actual connection.
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // unrecognized format — fail closed
}

function safeLookup(
  hostname: string,
  options: { all?: boolean } | ((err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void),
  callback?: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
): void {
  const cb = typeof options === "function" ? options : callback!;
  const opts = typeof options === "function" ? {} : options;
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err, undefined);
    const list = addresses as unknown as { address: string; family: number }[];
    if (list.length === 0) return cb(new Error("no addresses resolved") as NodeJS.ErrnoException, undefined);
    for (const a of list) {
      if (isPrivateIp(a.address)) {
        return cb(new Error(`refusing to connect to private address ${a.address}`) as NodeJS.ErrnoException, undefined);
      }
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

const safeAgent = new Agent({
  connect: { lookup: safeLookup as never, timeout: FETCH_TIMEOUT_MS },
});

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function extractMeta(html: string): Map<string, string> {
  const meta = new Map<string, string>();
  const metaTagPattern = /<meta\s+([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaTagPattern.exec(html))) {
    const attrs = match[1];
    const keyMatch = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = attrs.match(/content\s*=\s*["']([^"']*)["']/i);
    if (keyMatch && contentMatch) {
      meta.set(keyMatch[1].toLowerCase(), decodeEntities(contentMatch[1]));
    }
  }
  return meta;
}

function parseOpenGraph(html: string, pageUrl: URL): PreviewData | null {
  const meta = extractMeta(html);
  const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

  const title = meta.get("og:title") ?? meta.get("twitter:title") ?? (titleTagMatch ? decodeEntities(titleTagMatch[1]) : undefined);
  const description = meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description");
  const rawImage = meta.get("og:image") ?? meta.get("twitter:image");
  const siteName = meta.get("og:site_name") ?? pageUrl.hostname;

  if (!title && !description && !rawImage) return null;

  let image: string | undefined;
  if (rawImage) {
    try {
      image = new URL(rawImage, pageUrl).href;
      if (image.startsWith("http://") === false && image.startsWith("https://") === false) image = undefined;
    } catch {
      image = undefined;
    }
  }

  return {
    url: pageUrl.href,
    title: title?.slice(0, 300),
    description: description?.slice(0, 500),
    image,
    siteName: siteName?.slice(0, 100),
  };
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        const remaining = Math.max(0, maxBytes - (received - value.byteLength));
        out += decoder.decode(value.subarray(0, remaining));
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

async function fetchPreview(pageUrl: URL): Promise<PreviewData | null> {
  const res = await undiciFetch(pageUrl, {
    dispatcher: safeAgent,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "OutpostLinkPreview/1.0 (+https://outpost-chat.com)" },
  });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("html")) return null;
  const html = await readLimited(res as unknown as Response, MAX_BYTES);
  const finalUrl = res.url ? new URL(res.url) : pageUrl;
  return parseOpenGraph(html, finalUrl);
}

export async function linkPreviewRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/link-preview", async (req, reply) => {
    const { url } = previewSchema.parse(req.query);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reply.status(400).send({ error: "invalid url" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return reply.status(400).send({ error: "unsupported protocol" });
    }

    const cacheKey = parsed.href;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (!cached.data) return reply.status(204).send();
      return cached.data;
    }

    const data = await fetchPreview(parsed).catch(() => null);
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });

    if (!data) return reply.status(204).send();
    return data;
  });
}
