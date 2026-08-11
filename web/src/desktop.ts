// The desktop shell's preload bridge, as seen from the page. Absent in a
// browser, in the Docker-served web client, and in the mobile shells -- so
// every caller has to treat it as optional rather than assume it's there.
export interface SsoResult {
  code: string | null;
  error: string | null;
}

export interface DesktopBridge {
  isDesktop: true;
  openExternal(url: string): Promise<boolean>;
  onSsoResult(callback: (result: SsoResult) => void): () => void;
}

declare global {
  interface Window {
    outpost?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | null {
  return window.outpost ?? null;
}
