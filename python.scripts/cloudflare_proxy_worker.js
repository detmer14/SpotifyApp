export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    // 🔴 TEMPORARY TESTING BLOCK: Force a 429 if "?test429=true" is passed
    if (url.searchParams.get('test429') === 'true') {
      const testHeaders = new Headers();
      testHeaders.set('Access-Control-Allow-Origin', '*');
      testHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      testHeaders.set('Access-Control-Allow-Headers', '*');
      
      // Crucial: Expose and set a mock cooldown time (e.g., 7 seconds)
      testHeaders.set('Access-Control-Expose-Headers', 'Retry-After');
      testHeaders.set('Retry-After', '32949000'); //9 hours, 9min, 9sec

      return new Response(JSON.stringify({ error: "Mock rate limit active" }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: testHeaders
      });
    }

    if (!targetUrl) {
      return new Response('Missing target URL parameter "?url="', { status: 400 });
    }

    try {
      // Forward the request directly to the target radio metadata server
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: request.headers,
      });

      // Clone the response to inject clean CORS headers for your local environment
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      newHeaders.set('Access-Control-Allow-Headers', '*');

      // 🟢 ADD THIS LINE TO FIX THE RETRY-AFTER ACCESSIBILITY
      newHeaders.set('Access-Control-Expose-Headers', 'Retry-After');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (err) {
      return new Response('Proxy Error: ' + err.message, { status: 500 });
    }
  }
};

// addEventListener('fetch', event => {
//   event.respondWith(handleRequest(event.request))
// })

// async function handleRequest(request) {
//   const url = new URL(request.url)
//   let targetUrl = url.searchParams.get('url')

//   if (!targetUrl) {
//     return new Response('Missing target URL parameter', { status: 400 })
//   }

//   try {
//     // 🌐 Use a raw URL string instead of a structured Request object.
//     // This alters Cloudflare's internal parsing rules and clears SSL host mismatch exceptions.
//     const response = await fetch(targetUrl, {
//       method: 'GET',
//       headers: {
//         'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
//         'Accept': 'application/json',
//         'Origin': 'https://catcountry1073.com',
//         'Referer': 'https://catcountry1073.com'
//       }
//     })
    
//     // Set up standard cross-origin bypass headers for your local project environment
//     const newHeaders = new Headers(response.headers)
//     newHeaders.set('Access-Control-Allow-Origin', '*')
//     newHeaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS')

//     return new Response(response.body, {
//       status: response.status,
//       headers: newHeaders
//     })
//   } catch (err) {
//     return new Response('Proxy connection handshake failed: ' + err.toString(), { status: 500 })
//   }
// }
