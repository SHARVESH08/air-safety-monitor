// Next.js may expose an internal hostname in request.url. Compare the browser
// Origin with the HTTP Host that actually addressed this request instead.
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const host = request.headers.get("host") || new URL(request.url).host;
    return ["http:", "https:"].includes(source.protocol) && source.host === host;
  } catch { return false; }
}
