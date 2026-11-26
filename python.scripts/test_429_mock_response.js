// Paste this directly into your F12 browser console to force the loop into action:
const mockRes = { status: 429 };

// Simulate what happens when a standard fetch hits a 429
if (mockRes.status === 429) {
    console.log("🚀 Starting Rate Limit Simulation...");
    
    // This executes your exact client-side if-block logic
    // Replace 'https://spotify.com' with whatever valid URL your function accepts
    safeSpotifyFetch("https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent("https://spotify.com") + "&test429=true", { method: 'GET' });
}
