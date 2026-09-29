/**
 * Hikvision terminals take the push target as separate fields (HTTP Listening: protocol, host, port, URL path), not as one URL.
 * Splitting it here spares the admin from cutting the URL by hand on a small device screen.
 */
export function hikvisionListeningFields(pushUrl: string | null): { protocol: string; host: string; port: string; path: string } | null {
  if (!pushUrl) return null;
  let url: URL;
  try { url = new URL(pushUrl); } catch { return null; }
  if (!url.pathname.includes('/device-push/hikvision/')) return null;
  const protocol = url.protocol === 'https:' ? 'HTTPS' : 'HTTP';
  return { protocol, host: url.hostname, port: url.port || (protocol === 'HTTPS' ? '443' : '80'), path: url.pathname };
}
