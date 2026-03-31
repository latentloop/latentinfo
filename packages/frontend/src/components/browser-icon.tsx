import { useEffect, useState, type ImgHTMLAttributes } from "react";

type BrowserIconProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  appPath: string;
};

const iconCache = new Map<string, string>();
const pendingLoads = new Map<string, Promise<string | null>>();

async function loadBrowserIcon(appPath: string): Promise<string | null> {
  const cached = iconCache.get(appPath);
  if (cached) return cached;

  const pending = pendingLoads.get(appPath);
  if (pending) return pending;

  const request = fetch(`/api/v1/browser-icon/${encodeURIComponent(appPath)}`)
    .then(async (response) => {
      if (!response.ok) return null;
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      iconCache.set(appPath, objectUrl);
      return objectUrl;
    })
    .catch(() => null)
    .finally(() => {
      pendingLoads.delete(appPath);
    });

  pendingLoads.set(appPath, request);
  return request;
}

export function BrowserIcon({ appPath, alt = "", ...imgProps }: BrowserIconProps) {
  const [src, setSrc] = useState<string | null>(() => iconCache.get(appPath) ?? null);

  useEffect(() => {
    let cancelled = false;

    const cached = iconCache.get(appPath);
    if (cached) {
      setSrc(cached);
      return () => { cancelled = true; };
    }

    loadBrowserIcon(appPath).then((nextSrc) => {
      if (!cancelled) setSrc(nextSrc);
    });

    return () => { cancelled = true; };
  }, [appPath]);

  if (!src) return null;
  return <img {...imgProps} src={src} alt={alt} />;
}
