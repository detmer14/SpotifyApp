export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Extract and fix the target URL from the path
    let targetUrl = url.pathname.substring(1) + url.search;
    targetUrl = targetUrl.replace(/^https?:\/([^\/])/, 'https://$1');

    if (!targetUrl.startsWith("http")) {
      return new Response("Invalid target URL", { status: 400 });
    }

    // Force Cloudflare to treat this fetch as a completely clean, isolated visitor
    const cleanHeaders = new Headers();
    cleanHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
    cleanHeaders.set("Accept", "application/json, text/plain, */*");
    cleanHeaders.set("Accept-Language", "en-US,en;q=0.9");
    cleanHeaders.set("Cache-Control", "no-cache");
    cleanHeaders.set("Pragma", "no-cache");

    try {
      // We alter the fetch options context by removing Cloudflare request tracking properties
      const targetResponse = await fetch(targetUrl, {
        method: "GET",
        headers: cleanHeaders,
        credentials: "omit",
        redirect: "follow"
      });

      // If xmplaylist still blocks the native Worker IP, we route it through an open proxy tunnel
      if (targetResponse.status === 403) {
        const backupProxyUrl = "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(targetUrl);
        const backupResponse = await fetch(backupProxyUrl, {
          method: "GET",
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        
        return new Response(backupResponse.body, {
          status: backupResponse.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      return new Response(targetResponse.body, {
        status: targetResponse.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    } catch (err) {
      return new Response("Proxy failed: " + err.message, { status: 500 });
    }
  },
};
