import { InstanceInfo, authedMediaUrl } from "./api";

// A locally cached copy of every bookmarked server's icon, so the rail can
// draw all of them at once.
//
// Why a cache rather than just rendering each instance's iconUrl: uploads are
// private (see routes/fileServing.ts), so fetching an icon needs *that*
// instance's own token appended to the URL. That works for the server you're
// currently signed in to and nowhere else — which is why every inactive server
// used to fall back to its text initials the moment you clicked away from it.
// Passing each stored token through to an <img> tag would technically render
// them, but it also puts every server's credential in the DOM and re-fetches
// from every server on every render.
//
// Instead each icon is fetched once, downscaled, and kept as a data URL. That
// means it renders instantly on load, keeps rendering while a server is
// unreachable or its session has expired, and never needs a token at paint
// time.

const KEY_PREFIX = "instance-icon:";

// The rail draws these at 48px; 96 covers 2x displays with room to spare.
// Downscaling matters more than it looks: a server icon is whatever image the
// owner uploaded (potentially megapixels), and localStorage caps out around
// 5MB for the whole origin. At this size a cached icon is a few KB.
const ICON_PX = 96;

interface CachedIcon {
  // The remote URL this was rendered from, so a changed server icon can be
  // detected and re-fetched rather than served stale forever.
  sourceUrl: string;
  dataUrl: string;
}

export function loadCachedIcon(instanceId: string): string | null {
  const raw = localStorage.getItem(KEY_PREFIX + instanceId);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as CachedIcon).dataUrl;
  } catch {
    return null;
  }
}

function loadCachedEntry(instanceId: string): CachedIcon | null {
  const raw = localStorage.getItem(KEY_PREFIX + instanceId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedIcon;
  } catch {
    return null;
  }
}

export function clearCachedIcon(instanceId: string) {
  localStorage.removeItem(KEY_PREFIX + instanceId);
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = ICON_PX;
        canvas.height = ICON_PX;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no 2d context"));
        // Cover-crop to a square rather than squashing a non-square upload —
        // the rail slot is square either way, so letterboxing would just
        // waste pixels.
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, ICON_PX, ICON_PX);
        resolve(canvas.toDataURL("image/webp", 0.85));
      } catch (err) {
        reject(err as Error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("icon failed to decode"));
    };
    img.src = objectUrl;
  });
}

// Fetches an instance's current icon and caches it, if it isn't already cached
// from the same source URL. Returns the data URL when something changed, so
// the caller can re-render, or null when nothing did.
//
// Every failure path is deliberately silent and non-destructive: a server
// that's down, a token that's expired, an icon that 404s or won't decode all
// leave whatever is already cached in place. The one case that *does* clear
// the cache is the server explicitly reporting no icon, which is a real
// removal rather than a failure to read one.
export async function refreshInstanceIcon(
  instanceId: string,
  baseUrl: string,
  token: string,
): Promise<string | null> {
  let info: InstanceInfo;
  try {
    const res = await fetch(`${baseUrl}/instance-info`);
    if (!res.ok) return null;
    info = await res.json();
  } catch {
    return null;
  }

  if (!info.iconUrl) {
    if (loadCachedEntry(instanceId)) clearCachedIcon(instanceId);
    return null;
  }

  const cached = loadCachedEntry(instanceId);
  if (cached?.sourceUrl === info.iconUrl) return null;

  try {
    const res = await fetch(authedMediaUrl(info.iconUrl, baseUrl, token));
    if (!res.ok) return null;
    const dataUrl = await toDataUrl(await res.blob());
    try {
      localStorage.setItem(KEY_PREFIX + instanceId, JSON.stringify({ sourceUrl: info.iconUrl, dataUrl }));
    } catch {
      // Quota exceeded — the icon still renders this session from the
      // returned value, it just won't survive a reload. Not worth evicting
      // other servers' icons over.
    }
    return dataUrl;
  } catch {
    return null;
  }
}
