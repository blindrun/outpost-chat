import { useEffect, useState } from "react";
import { getLinkPreview, LinkPreviewData } from "./api";

// Module-level, not component-level: many MessageItems across the channel
// history can reference the same URL (a link someone posted twice, or a
// site multiple people shared), and this avoids every mounted instance
// re-fetching independently. The backend also caches server-side, but this
// skips the network round-trip entirely for anything already seen this
// session. Never expires client-side — same lifetime as the page.
const previewCache = new Map<string, LinkPreviewData | null>();

export function LinkPreview({ baseUrl, token, url }: { baseUrl: string; token: string; url: string }) {
  const [data, setData] = useState<LinkPreviewData | null | undefined>(previewCache.get(url));

  useEffect(() => {
    if (previewCache.has(url)) {
      setData(previewCache.get(url));
      return;
    }
    let cancelled = false;
    getLinkPreview(baseUrl, token, url).then((result) => {
      const resolved = result ?? null;
      previewCache.set(url, resolved);
      if (!cancelled) setData(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, token, url]);

  // undefined = still loading (render nothing, avoid a layout-shifting
  // placeholder box for the common case where most links have no preview
  // ready within a frame or two); null = fetched, nothing to show.
  if (!data) return null;
  if (!data.title && !data.description && !data.image) return null;

  return (
    <a className="link-preview-card" href={data.url} target="_blank" rel="noopener noreferrer">
      <div className="link-preview-body">
        {data.siteName && <div className="link-preview-site">{data.siteName}</div>}
        {data.title && <div className="link-preview-title">{data.title}</div>}
        {data.description && <div className="link-preview-description">{data.description}</div>}
      </div>
      {data.image && <img className="link-preview-image" src={data.image} alt="" loading="lazy" />}
    </a>
  );
}
