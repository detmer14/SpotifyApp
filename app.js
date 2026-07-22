//alert("app.js loaded")

let player;
let device_id;
let device_ready = false //used in ready listener
let isPlayerReady = false
let isRecoveringFromBackground = false
let devicePoweredOn = false
let appVisible = true
let musicStartedOnDevice = false
let musicPlayingOnDevice = false
let SESSION_ID;
let APP_DEVICE_ID;
let CURRENT_USER_IP;
let userInitiatedPause = false;
let autoPlayBlocked = false;
let ghostPauseRecovery = false
let lastPickTime = 0;
let internalQueue = []; // Array of {id, name, artist, playlistName}
let playbackHistory = []; // Global array to store track objects
let historyIndex = -1; // -1 means we are on the "live" mixer track
let buttonPreviousNext = false;
let nowPlayingText = ""
let queuePlaylistName = ""
const queuePlaylistNames = [
  { id: "id1", name: 'Alice' },
  { id: "id2", name: 'Bob' }
];
const queuePlaylistsMap = new Map(queuePlaylistNames.map(obj => [obj.id, obj]));
let lastTrackId = null
let playlistContextEnabled = false;
let contextSyncedForCurrentTrack = false
let playlistContextChanging = false;

let logMap = new Map();
let logCounter = 0;

let isDraggingProgress = false

window.onSpotifyWebPlaybackSDKReady = async () => {
    console.warn("Spotify SDK is ready to initialize!");
    const token = localStorage.getItem('access_token');
};

let activeTimeouts = []; // Array to track all pending retries

// Helper to safely set timeouts
function safeTimeout(func, delay) {
    const id = setTimeout(() => {
        func();
        activeTimeouts = activeTimeouts.filter(tId => tId !== id);
    }, delay);
    activeTimeouts.push(id);
}

function updateSessionTimer() {
    const expiry = localStorage.getItem('token_expiry');
    const display = document.getElementById('timer-display');
    if (!expiry || !display) return;

    const remainingMs = expiry - Date.now();
    
    if (remainingMs <= 0) {
        display.textContent = "EXPIRED";
        display.style.color = "red";
        return;
    }

    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);
    display.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    display.style.color = minutes < 5 ? "red" : minutes < 10 ? "orange" : "#1DB954"; // Turns orange at 5 mins
}

// Run this every second to keep the UI fresh
setInterval(updateSessionTimer, 1000);

async function emergencyStop() {

    devicePoweredOn = false

    console.warn("EMERGENCY STOP TRIGGERED");
            // SEND THE LOG
            logEvent("ERROR", `EMERGENCY STOP TRIGGERED`, {
                step: "emergencyStop",
                error: `EMERGENCY_STOP`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

    isRecoveringFromBackground = true; //set to true for reconnect
    //musicStartedOnDevice = false //nah, keep this for reconnect
    musicPlayingOnDevice = false
    isRefreshing = false
    //userInitiatedPause = false //leave this for reconnect
    autoPlayBlocked = false
    ghostPauseRecovery = false
    //internalQueue = []
    //playbackHistory = []
    historyIndex = -1
    buttonPreviousNext = false
    //don't care about queuePlaylistMap
    //keep the logMap
    isDraggingProgress = false
    apiCallCounter = 0
    refreshTokenCallCounter = 0
    fetchUserProfileCallCounter = 0
    isSoftLocked = false
    isSoftLockedISRC = false //not used anymore
    fetch401 = false
    loggingLocked = false
    rateLimitStrikes = 0
    rateLimitStrikesISRC = 0 //not used anymore



    // 1. Clear all pending pickRandomSong retries
    activeTimeouts.forEach(id => clearTimeout(id));
    activeTimeouts = [];

    // 2. Disconnect the Player
    if (player) {
        player.disconnect();
        // Remove listeners to prevent "Ghost" events
        player.removeListener('player_state_changed');
        player.removeListener('ready');
        player.removeListener('not_ready');
        player.removeListener('autoplay_failed');
        player.removeListener('initialization_error');
        player.removeListener('authentication_error');
        player.removeListener('account_error');
    }

    // 3. Reset UI
    device_id = null;
    device_ready = false;
    isPlayerReady = false
    localStorage.removeItem('last_active_device')
    currentTrackId = null;
    currentTrackIdISRC = null
    lastTrackId = null
    document.getElementById('init-player').textContent = "🔌 Power On Mixer";
    document.getElementById('init-player').style.background = "#ff0000";
    showResult(`%c Mixer Hard-Reset: All processes stopped.`, "color: #ff0000;")
    visualLog(`%c Mixer Hard-Reset: All processes stopped.`, "color: #ff0000;")
    console.log(`%c Mixer Hard-Reset: All processes stopped.`, "color: #ff0000;")

    if (window.refreshInterval) {
        clearInterval(window.refreshInterval);
        window.refreshInterval = null;
        console.warn("Refresh heartbeat stopped.");
    }
}

function getStackTrace() {
    const error = new Error();
    return error.stack; // Captures current call stack
}

async function logEvent(level, message, metadata = {}) {
    const SOURCE_TOKEN = "K77AoFCVGv9iKQyCyLEdvjYe";

    if(!loggingLocked){

        if(fetchUserStrikes < MAX_STRIKES_10MIN_FETCHUSER){
        if((currentSpotifyUser === "fail") || (currentSpotifyUser === "guest")){
            await fetchUserProfile();
        }
        }
        try {
            const res = await fetch("https://in.logs.betterstack.com", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${SOURCE_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    dt: new Date().toISOString(), // Timestamp
                    level: level,
                    user_id: currentSpotifyUser,
                    user_url: `https://open.spotify.com/user/${currentSpotifyUser}`,
                    device_id: device_id,
                    session_id: SESSION_ID,
                    app_device_id: APP_DEVICE_ID,
                    user_ip_address: CURRENT_USER_IP,
                    app_url: window.location.href,
                    platform: navigator.platform,
                    userAgent: navigator.userAgent,
                    message: message,
                    ...metadata
                })
            });

            if (res.status === 429) {
                loggingLocked = true;
                console.warn(`Logging 429 - rate limited`)
            }
            if ([401, 403, 405].includes(res.status)) {
                loggingLocked = true;
                console.warn(`Logging 400, 401, 402 - pre-flight failure`)

                // A 401 Unauthorized status is not specifically a CORS error, though it often appears alongside one. 
                // If you see a CORS error and a 401 status together, it typically means the browser’s CORS Preflight 
                // request (an OPTIONS call) was rejected by your server's security layer before the actual request 
                // could be made

                // Preflight Failure (401/403/405): Before sending complex requests (like those with 
                //     JSON or custom headers), browsers send an OPTIONS preflight request. 
                //     If your server requires authentication for all requests, it may return a 401 Unauthorized for 
                //     this preflight because the browser does not send credentials with it. This causes the 
                //     browser to block the subsequent "real" request and report a CORS error.
                // Redirect Issues (301/302): If a server redirects a preflight request, the browser will block it 
                //     with a CORS error because redirects are not allowed during the preflight phase.
            }
            



            // Emergency (emerg): indicates that the system is unusable and requires immediate attention.
            // Alert (alert): indicates that immediate action is necessary to resolve a critical issue.
            // Critical (crit): signifies critical conditions in the program that demand intervention to prevent system failure.
            // Error (error): indicates error conditions that impair some operation but are less severe than critical situations.
            // Warning (warn): signifies potential issues that may lead to errors or unexpected behavior in the future if not addressed.
            // Notice (notice): applies to normal but significant conditions that may require monitoring.
            // Informational (info): includes messages that provide a record of the normal operation of the system.
            // Debug (debug): intended for logging detailed information about the system for debugging purposes.

            // Fatal & Error: Highlighted in Red to demand immediate attention for critical failures.
            // Warning: Highlighted in Yellow to surface emerging issues or undesirable conditions that aren't yet critical errors.
            // Info: Typically displayed in Green or standard text, indicating interesting runtime events like startup or shutdown.
            // Debug & Trace: Usually highlighted in Gray or muted tones to keep detailed diagnostic information in the background unless intentionally viewed. 


            //console.log("📈 Event logged to BetterStack");
        } catch (err) {
            // We fail silently so a logging error never crashes your music player
        }
    }
}

let currentSpotifyUser = "guest"; // Default
let updatingCurrentSpotifyUser = false

async function fetchUserProfile() {

    console.log(`fetchUserProfile`)
    // visualLog(`%cfetchUserProfile ${fetchUserProfileCallCounter}`, "color: #ff00bf;")
    // visualLog(`%cfetchUserProfile ${fetchUserProfileCallCounter}`, "color: #00ff2a;")
    // visualLog(`%cfetchUserProfile ${fetchUserProfileCallCounter}`, "color: #0084ff;")
    // visualLog(`hey%c fetchUserProfile%c ${fetchUserProfileCallCounter}`, "color: #ff0000;", "color: #0044ff;")
    // visualLog(`%c hey `, "color: #ff0000;", "color: #0044ff;")

    if (fetchUserStrikes > MAX_STRIKES_10MIN_FETCHUSER) {

        emergencyStop(); // Kill everything
        fetchUserStrikes = 0; // Reset for next Power On
        fetchUserProfileCallCounter = 0;

        //showResult("Slow down! Too many requests.");
        console.warn("fetchUserProfile - MAX_STRIKES_10MIN_FETCHUSER- Slow down! Too many requests.");
        console.warn("fetchUserProfile - MAX_STRIKES_10MIN_FETCHUSER")
            // SEND THE LOG
            logEvent("ERROR", `fetchUserProfile - MAX_STRIKES_10MIN_FETCHUSER - Strike: ${fetchUserStrikes} - Slow down! Too many requests`, {
                step: "fetchUserProfile",
                error: "MAX_STRIKES_10MIN_FETCHUSER",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: fetchUserStrikes,
                activeMix: activeMixId
            });
        return
    }

    if (fetchUserProfileCallCounter > MAX_CALLS_PER_MINUTE_FETCHUSER) {

        fetchUserStrikes++;
        safeTimeout(() => fetchUserStrikes--, 600000); // Reset count after 10 min

        //showResult("Slow down! Too many requests.");
        console.warn("fetchUserProfile - MAX_CALLS_PER_MINUTE - Slow down! Too many requests.");
        console.warn(`fetchUserProfile - MAX_CALLS_PER_MINUTE - Strike: ${fetchUserStrikes}`)
            // SEND THE LOG
            logEvent("ERROR", `fetchUserProfile - MAX_CALLS_PER_MINUTE_FETCHUSER - Strike: ${fetchUserStrikes} - Slow down! Too many requests`, {
                step: "fetchUserProfile",
                error: "MAX_CALLS_PER_MINUTE_FETCHUSER",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: fetchUserStrikes,
                activeMix: activeMixId
            });
        return
    }

    fetchUserProfileCallCounter++;
    safeTimeout(() => fetchUserProfileCallCounter--, 60000); // Reset count after 1 min

    if(!updatingCurrentSpotifyUser){
        
        updatingCurrentSpotifyUser = true

        const token = localStorage.getItem('access_token');
        //const res = await fetch('https://api.spotify.com/v1/me', {
        console.log("Active Auth Token:", token)
        const res = await safeSpotifyFetch('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if(!res){
            console.log(`No response res`)
            return
        }
        if(!res.ok){
            return
        }
        const data = await res.json();
        
        // Store the ID (e.g., "spotify_user_88")
        if(data.id){
            currentSpotifyUser = data.id; 
            // Optional: Log that they logged in
            console.warn(`fetchUserProfile - User Session Started: ${currentSpotifyUser}`)
            // SEND THE LOG
            logEvent("WARN", `fetchUserProfile - User Session Started`, {
                step: "fetchUserProfile",
                error: `FETCH_USER_PROFILE`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

                    console.debug("New song detected:", currentSpotifyUser);
                    console.info("New song detected:", currentSpotifyUser);
                    console.log("%cNew song detected:", currentSpotifyUser, "color: blue;");
                    console.log("%cNew song detected:", "color: blue;");
                    console.log("%cNew song detected:", "color: blue;", currentSpotifyUser);
                    console.log("%cNew song detected:", "color: #1eff00;", currentSpotifyUser);
                    console.log("%cNew song detected:", "color: #ff0000;", currentSpotifyUser);
                    console.log("%cNew song detected:", "color: #ff00bf;", currentSpotifyUser);
                    console.warn("%cNew song detected:", "color: #ff00bf;", currentSpotifyUser);
                    console.error("%cNew song detected:", "color: #ff00bf;", currentSpotifyUser);
                    console.log(`%cNew song detected: ${currentSpotifyUser}`, "color: #00d1ec;");
            
            // 1. Save identity key natively
            localStorage.setItem('spotify_user_id', currentSpotifyUser);
        }
        else{
            console.warn(`fetchUserProfile FAIL`)
            currentSpotifyUser = "fail"
        }

        updatingCurrentSpotifyUser = false;
    }
}

// =========================================================================
// ☁️ SUPABASE DATABASE INITIALIZATION TERMINAL
// =========================================================================
const SUPABASE_URL = "https://" + "hwkgwhuixwqxovwxujkl" + ".supabase.co"

// 🔑 PASTE YOUR ACTUAL, LONG 'anon / public' API KEY STRING BETWEEN THESE QUOTES:
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3a2d3aHVpeHdxeG92d3h1amtsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNTQ0MzAsImV4cCI6MjA5NTgzMDQzMH0.xkQRAcpcKrY1EgJsuXt0bGiO6phjz4TGr43hxBpCh4o";

// Initialize the global client layer object
const supabaseClient  = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log("🔌 [Supabase] Cloud client environment initial configuration locked.");

async function testSupabaseConnection() {
    try {
        console.log("📡 Sending test probe to user_caches table space...");
        
        // Execute a basic read check to ensure the table schema routes correctly
        const { data, error } = await supabaseClient 
            .from('user_caches')
            .select('spotify_id')
            .limit(1);

        if (error) {
            console.error("❌ Supabase Handshake Rejected:", error.message);
        } else {
            console.log("%c🎉 Supabase Connected Flawlessly! Cloud pipeline is wide open.", "color: #1DB954; font-weight: bold;");
        }
    } catch (err) {
        console.error("❌ Fatal boundary exception during network handshake:", err);
    }
}

// Fire the test immediately at script evaluation time
testSupabaseConnection();

function setUserInitiatedPause(){
    autoPlayBlocked = false
    if(userInitiatedPause){
        userInitiatedPause = false;
    console.error(`userInitiatedPause ${userInitiatedPause}`)
    }
    else{
        userInitiatedPause = true;
    console.error(`userInitiatedPause ${userInitiatedPause}`)
    }

}

async function togglePlayback(){

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    if (!player || !devicePoweredOn) {
        alert("Powering player on first. Then starting music");
        initBtn.click()

        // Create a promise that resolves when a specific event is heard
        // await new Promise((resolve) => {
        //     initBtn.click();
        //     window.addEventListener('devicePoweredOn', resolve, { once: true });
        // });
    }
    // Code below will now wait for 'devicePoweredOn'

    // Wait until devicePoweredOn is true
    await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
        console.log(`%c checking devicePoweredOn`, "color: #ff00ffff; background: #000000;");
            if (player && devicePoweredOn) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 100); // check every 100ms
    });

    if(!player || !devicePoweredOn){
        return
    }

    if (player){
        console.log(`Media Session Play Button - player.resume()`)


        // Get the current state to see if a song is already loaded
        const state = await player.getCurrentState();

        if (!state) {
            // CASE 1: No song is loaded/playing yet
            console.log("No track detected. Starting first pick...");
            showResult(`%c Initializing first mix...`, "color: #000000;")
            visualLog(`%c Initializing first mix...`, "color: #000000;")
            const returnPickRandom = await pickRandomSong(); 

            if(returnPickRandom !== "SUCCESS"){
                console.warn("playPauseBtn - pickRandomSong - FAIL:", returnPickRandom)
            }

                safeTimeout(() => {
                    prepareNextQueueItem();
                }, 15000);

                safeTimeout(() => {
                    prepareNextQueueItem();
                }, 30000);

                safeTimeout(() => {
                    prepareNextQueueItem();
                }, 45000);

        }
        else {
            setUserInitiatedPause()
            // CASE 2: A song exists, so just toggle play/pause
            player.togglePlay().then(() => {
                console.log('Toggled playback');
                    logEvent("INFO", `playPauseBtn_main | Toggled playback`, {
                        step: "playPauseBtn_main",
                        error: "PLAY_PAUSE_BTN_MAIN",
                        pause: "PAUSE",
                        strikeCount: rateLimitStrikes,
                        activeMix: activeMixId
                    });
            });
    
            showResult(`${nowPlayingText}`, "color: #129900;")
        }

    }
}

async function playTrack(trackUri, isRetry = false) {
    const token = localStorage.getItem('access_token');
    // If the app just refreshed, device_id might be null, so check storage
    if (!device_id) {
        device_id = localStorage.getItem('last_active_device');
        console.warn(`No device ID, attempting to use last_active_device`)
    }
    if (!device_id) alert("Click 'Power On' first!");
    if (!device_id) {
        showResult(`%c No device found. Please Power On.`, "color: #ff0000ff");
        return "NO_DEVICE_TURN_POWER_ON";
    }

    try {
        const response = await safeSpotifyFetch(`https://api.spotify.com/v1/me/player/play?device_id=${device_id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            // CRITICAL: trackUri must be inside an array []
            body: JSON.stringify({ 
                uris: [trackUri] 
            }),
        });

        if(response === "MAX_CALLS_PER_MINUTE"){
            console.warn("playTrack - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "playTrack",
                error: "MAX_CALLS_PER_MINUTE",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return("MAX_CALLS_PER_MINUTE")
        }
        if(response === "SOFT_LOCKED"){
            console.warn("playTrack - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "playTrack",
                error: "SOFT_LOCKED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return("SOFT_LOCKED")
        }
        if(response === "429_MAX_STRIKES"){
            console.warn("playTrack - safeSpotifyFetch - 429_MAX_STRIKES")
            // SEND THE LOG
            logEvent("ERROR", `playTrack - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "playTrack",
                error: "429_MAX_STRIKES",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return("429_MAX_STRIKES")
        }
        if(response === "429_STRIKE"){
            console.warn("playTrack - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `playTrack - safeSpotifyFetch - 429_STRIKE`, {
                step: "playTrack",
                error: "429_STRIKE",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            return("429_STRIKE")
        }
        if(response === "401_TOKEN_EXPIRED"){
            console.warn("playTrack - safeSpotifyFetch - 401_TOKEN_EXPIRED")
            // SEND THE LOG
            logEvent("ERROR", `playTrack - safeSpotifyFetch - 401_TOKEN_EXPIRED`, {
                step: "playTrack",
                error: "401_TOKEN_EXPIRED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            return("401_TOKEN_EXPIRED")
        }

        if (response.status === 404) {
            console.warn("playTrack Device ID not found. Attempting to refresh device list...");
            showResult(`%cRe-syncing with Spotify...`, "color: #0044ff;")
            visualLog(`%cRe-syncing with Spotify...`, "color: #0044ff;")


            // Check if the token is likely the problem
            const expiry = localStorage.getItem('token_expiry');
            if (Date.now() > expiry) {
                showResult(`%c 404 Session expired. Refreshing...`, "color: #ff0000;")
                visualLog(`%c 404 Session expired. Refreshing...`, "color: #ff0000;")
                console.warn("playTrack 404 Session expired. Refreshing...");
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - 404 Session expired. Refreshing...`, {
                step: "playTrack",
                error: "404_SESSION_EXPIRED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                //await refreshAccessToken();
            }

            if(!isRetry){

                await refreshAccessToken();

                // Logic to re-fetch devices or re-initialize player
                // 1. Tell the SDK to re-announce itself to Spotify
                if(player){
                    // The SDK will try to reconnect itself, but we can nudge it:
                    await player.connect().then(success => {
                        if (success) {
                            visualLog(`%c Playing song - Player reconnected successfully`, "color: #2d8a02")
                            showResult(`%c Playing song - Player reconnected successfully`, "color: #2d8a02")
                            console.warn(`%c Playing song - Player reconnected successfully`, "color: #2d8a02")
                            // SEND THE LOG
                            logEvent("WARN", `playTrack - Player reconnect SUCCESS`, {
                                step: "playTrack",
                                error: `PLAYTRACK_RECONNECT_SUCCESS`,
                                stack_trace: new Error().stack, // Auto-trace errors
                                strikeCount: rateLimitStrikes,
                                activeMix: activeMixId
                            });
                        } 
                        else {
                            visualLog(`%c Playing song - Player Re-Connection failed.`, "color: #ff0000;");
                            showResult(`%c Playing song - Player Re-Connection failed.`, "color: #ff0000;");
                            console.error(`%c Playing song - Player Re-Connection failed.`, "color: #ff0000;");
                            // SEND THE LOG
                            logEvent("WARN", `playTrack - Player reconnect FAIL`, {
                                step: "playTrack",
                                error: `PLAYTRACK_RECONNECT_FAIL`,
                                stack_trace: new Error().stack, // Auto-trace errors
                                strikeCount: rateLimitStrikes,
                                activeMix: activeMixId
                            });
                        }
                    });
                }
                
                // 2. Wait a split second for the 'ready' event to update the device_id
                setTimeout(async () => {
                    console.warn("playTrack - 404 Retrying playback with refreshed device...");
                    const playTrackReturn = await playTrack(trackUri, true); // retry = true to prevent infinite loops
                    if(playTrackReturn === "SUCCESS"){
                        return "SUCCESS"
                    }
                    else{
                        console.warn("playTrack - 404 retry playback fail:", playTrackReturn)
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - 404 retry playback fail: ${playTrackReturn}`, {
                step: "playTrack",
                error: "404_DEVICE_ID_NOT_FOUND.RETRY.FAIL",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                        return "404_DEVICE_ID_NOT_FOUND.RETRY.FAIL"
                    }
                }, 1000);
            } else {
                console.warn("playTrack - 404 persisted after retry. Stopping loop.");
                showResult(`%c Play Track attempt - Connection lost. Please Power Off and On again.`, "color: #ff0000;")
                visualLog(`%c Play Track attempt - 404 persisted - Connection lost. Please Power Off and On again.`, "color: #ff0000;")
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - 404 persisted after retry. Stopping loop.`, {
                step: "playTrack",
                error: "404_DEVICE_NOT_FOUND",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                // EXIT HERE. No more setTimeouts.
            }
//            if(!response.ok){
                console.error("Error: playTrack - safeSpotifyFetch blocked")
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                }              //throw new Error(errorBody.error.message || "Forbidden or Not Found");
//            }
            return("404_DEVICE_NOT_FOUND");
        }

        if (response.status === 403) {
            let returnCodePickRetry = "NONE"
            console.warn("403: Song restricted. Skipping to a new one...");
            showResult(`%c Song restricted by Spotify. Picking another...`, "color: #0011ff;")
            visualLog(`%c Song restricted by Spotify. Picking another...`, "color: #0011ff;")
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - 403: Song restricted. Skipping to a new one...`, {
                step: "playTrack",
                error: "403_SONG_RESTRICTED.RETRY",
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            //alert("Spotify Premium is required for this feature.");
            // AUTO-RECOVERY: Just trigger a new pick!
//            if(!response.ok){
                console.error("Error: playTrack - safeSpotifyFetch blocked")
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                }              //throw new Error(errorBody.error.message || "Forbidden or Not Found");
//            }
            safeTimeout(() => (returnCodePickRetry = pickRandomSong()), 500);
            console.warn("playTrack - 403 Song restricted - RETRY:", returnCodePickRetry)
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - 403 Song restricted - RETRY: ${returnCodePickRetry}`, {
                step: "playTrack",
                error: `403_SONG_RESTRICTED.RETRY.${returnCodePickRetry}`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            if(returnCodePickRetry === "SUCCESS"){
                return("SUCCESS")
            }

            console.warn("playTrack - 403 Song restricted - RETRY:FAIL:", returnCodePickRetry)
            return("403_SONG_RESTRICTED.RETRY.FAIL");

        } 
        else if (response.status === 204  || response.status === 200) {
            // SEND THE LOG
            logEvent("INFO", `playTrack - safeSpotifyFetch - 200 204 SUCCESS`, {
                step: "playTrack",
                error: `200_204_SUCCESS`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            // Wait 300ms for Spotify's servers to process the change, 
            // then force the local player to start.
            safeTimeout(async () => {
                if (player){
                    await player.resume().then(() => {
                        musicStartedOnDevice = true
                        autoPlayBlockRecovered = true
                        console.log("Local player resumed after URI injection");
                    }).catch(err => {
                        // If this fails, the browser is likely blocking autoplay
                        console.error("Autoplay blocked by browser. Manual click required.", err);
                        showResult(`%c Autoplay blocked by browser. Manual click required. ${err}`, "color: #ff0000;")
                        visualLog(`%c Autoplay blocked by browser. Manual click required. ${err}`, "color: #ff0000;")
            // SEND THE LOG
            logEvent("INFO", `playTrack - safeSpotifyFetch - 200 204 SUCCESS - Resume Player - Autoplay blocked by browser. Manual click required. ${err}`, {
                step: "playTrack",
                error: `200_204_SUCCESS_AUTOPLAY_BLOCKED`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

                    });

                    //player.togglePlay();

                }
            }, 1000);

            
            if(internalQueue.length < 2){ //no need to overload the queue
                console.log("Current song started. Pre-picking next song for the queue...");
                // Wait 3 seconds to let the current song settle, then queue the next one
                safeTimeout(() => {
                    prepareNextQueueItem();
                }, 3000);
            }   
            console.log("Playback started successfully.");

            // 1. Set Chrome Battery Usage to "Unrestricted"
            // By default, Android "optimizes" Chrome, which kills audio connections when the screen is off.
            // Go to Settings > Apps > Chrome.
            // Tap App battery usage (or Battery).
            // Change the setting from Optimized to Unrestricted.

            // 2. Disable Chrome's "Memory Saver"
            // Chrome has a built-in feature that discards inactive tabs to free up RAM, causing them to refresh when you return to them.
            // Open Chrome and tap the three dots (Menu) > Settings.
            // Go to Performance.
            // Turn off Memory Saver.
            // Add your Netlify URL to the "Always keep these sites active" list.

            // 3. Use the "Desktop Site" Hack
            // If the tab still suspends, enabling "Desktop Site" in Chrome's menu can sometimes trick Android into treating the tab with higher priority, similar to how YouTube Music is often kept alive in the background.

            // // To keep the music playing when the screen goes off, Android requires a "Foreground Service." Browsers can't do this easily, but there is a hack: The Media Session API. If you "tell" Android that media is playing, it’s less likely to kill the tab.
            // // Add this whenever a song starts:
            // if ('mediaSession' in navigator) {
            //     navigator.mediaSession.metadata = new MediaMetadata({
            //         title: track.name,
            //         artist: track.artists[0].name,
            //         album: chosenplaylist.name,
            //         artwork: [{ src: track.album.images[0].url }]
            //     });

            //     // Update the playback state so the play/pause button looks right
            //     navigator.mediaSession.playbackState = "playing";
            // }
            return("SUCCESS")

        }
    }
    catch (err) {
        console.error("playTrack - Playback error:", err);
            // SEND THE LOG
            logEvent("ERROR", `playTrack - Playback error: ${err}`, {
                step: "playTrack",
                error: `PLAYTRACK_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
}

async function playPreviousTrack() {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    // Index 0 is CURRENT song. Index 1 is the PREVIOUS song.
    if (historyIndex + 1 >= playbackHistory.length) {
        console.log("No previous tracks in history yet.");
        return;
    }

    buttonPreviousNext = true;
    historyIndex++;

    // 1. Get the last song's URI
    const previousTrack = playbackHistory[historyIndex]; 
    
    // 2. Play it
    const playTrackReturn  = await playTrack(previousTrack.uri, false);
    if(playTrackReturn !== "SUCCESS"){
        console.warn("playPreviousTrack playTrack - safeSpotifyFetch - FAIL:", playTrackReturn)
            // SEND THE LOG
            logEvent("ERROR", `playPreviousTrack playTrack - safeSpotifyFetch - FAIL: ${playTrackReturn}`, {
                step: "playPreviousTrack",
                error: `PLAYTRACK_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        historyIndex--;
        buttonPreviousNext = false
        return
    }

    updateHistoryHighlight();

    // 3. Remove the "current" track we just skipped back from
    // so that the history stays accurate
    //playbackHistory.shift(); 
    
    // 4. Update your HTML history list to reflect the removal
    //renderHistoryList(); 

        logEvent('INFO', 'now_playing_back_button | Play previous track!', { 
            step: 'now_playing_back_button', 
            error: 'NOW_PLAYING_BACK_BUTTON', 
            back: 'BACK', 
            track: previousTrack.name,
            track_artist: previousTrack.artists[0].name,
            track_id: previousTrack.id,
            device_id: device_id, 
            strikeCount: rateLimitStrikes, 
            activeMix: activeMixId 
        });
}

async function playNextTrack(lastState) {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    if (historyIndex > 0) {
        
        buttonPreviousNext = true;
        historyIndex--; // Move closer to the "live" track

        const track = playbackHistory[historyIndex];

        const playTrackReturn  = await playTrack(track.uri, false);
        if(playTrackReturn !== "SUCCESS"){
            console.warn("playNextTrack playTrack - safeSpotifyFetch - FAIL:", playTrackReturn)
                // SEND THE LOG
                logEvent("ERROR", `playNextTrack playTrack - safeSpotifyFetch - FAIL: ${playTrackReturn}`, {
                    step: "playNextTrack",
                    error: `PLAYTRACK_FAIL`,
                    stack_trace: new Error().stack, // Auto-trace errors
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
            historyIndex++;
            buttonPreviousNext = false
            return
        }

        updateHistoryHighlight();
            logEvent('INFO', `now_playing_next_button | Skipped to the next track! duration:${lastState.duration}`, { 
                step: 'now_playing_next_button', 
                error: 'NOW_PLAYING_NEXT_BUTTON', 
                next: 'NEXT', 
                track: track.name,
                track_artist: track.artists[0].name,
                track_id: track.id,
                device_id: device_id, 
                strikeCount: rateLimitStrikes, 
                activeMix: activeMixId 
            });
    }
    else {
        // If we are at index 0, we are "Live," so pick a NEW random song
        player.nextTrack(); 
            logEvent('INFO', `now_playing_skip_button | Skipped to the next track! duration:${lastState.duration}`, { 
                step: 'now_playing_skip_button', 
                error: 'NOW_PLAYING_SKIP_BUTTON', 
                skip: 'SKIP', 
                device_id: device_id, 
                strikeCount: rateLimitStrikes, 
                activeMix: activeMixId 
            });
    }
}

async function playFromSpecificPlaylist(chosenplaylist) {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    const playlistIndex = playlists.findIndex(p => p.id === chosenplaylist.id);
    refreshPlaylistCount(chosenplaylist.id, playlistIndex);

    const index = Math.floor(Math.random() * chosenplaylist.trackCount) // uniform inside playlist
        //showResult(`Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`)        
        visualLog(`%c Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`, "color: #0004ff;")
        console.log(`--------------- Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`)
            // SEND THE LOG
            logEvent("TRACE", `playFromSpecificPlaylist - Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`, {
                step: "playFromSpecificPlaylist",
                error: `PLAYLIST_CHOSEN`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });


    if (MOCK_MODE) {
        showResult(`--------------- Playlist ${chosenplaylist.name}, song #${index + 1}`)
        return
    }

    // --- NEW: SPOTIFY ID VALIDATION ---
    // If the ID is just a name like "A" or "MyMix", we only do "Mock" mode
    const isSpotifyId = /^[a-zA-Z0-9]{22}$/.test(chosenplaylist.id);

    if (!isSpotifyId) {
        const randomIndex = Math.floor(Math.random() * chosenplaylist.trackCount);
        showResult(`[MOCK MODE] Playlist: ${chosenplaylist.name}, Track #${randomIndex + 1}`);
        console.log(`Bypassing Spotify API for non-Spotify Playlist: ${chosenplaylist.id}`);
        return; // STOP HERE: Do not call getTrackAtIndex or playTrack
    }

    // real Spotify playback...
    const token = localStorage.getItem('access_token');
    const track = await getTrackAtIndex(token, chosenplaylist.id, index)
    
    if (track === "NETWORK_ERROR"){
        console.log("playFromSpecificPlaylist: NETWORK_ERROR, stopping loop")
            // SEND THE LOG
            logEvent("ERROR", `playFromSpecificPlaylist - NETWORK_ERROR, stopping loop`, {
                step: "playFromSpecificPlaylist",
                error: `NETWORK_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return; // Stop the loop immediately!
    }
    
    // 4. RATE LIMIT CHECK: Stop if safeSpotifyFetch triggered a 429
    if (track === "RATE_LIMIT_HIT") {
        console.log("playFromSpecificPlaylist: RATE_LIMIT_HIT, stopping loop");
            // SEND THE LOG
            logEvent("ERROR", `playFromSpecificPlaylist - RATE_LIMIT_HIT, stopping loop`, {
                step: "playFromSpecificPlaylist",
                error: `RATE_LIMIT_HIT`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return;
    }

    if (track === null) {
        if (isSoftLocked) {
            console.log("playFromSpecificPlaylist: Mixer is soft-locked. Waiting for recovery...");
            // SEND THE LOG
            logEvent("WARN", `playFromSpecificPlaylist - Mixer is soft-locked. Waiting for recovery...`, {
                step: "playFromSpecificPlaylist",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return; // Don't even attempt a retry loop
        }
        // ... normal restricted track retry logic ...
    }

    // Safety check: only call playTrack if we actually got a track back
    if (track && track.uri) {
        console.log("Playing:", track.name);
        nowPlayingText = `%c Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`
        showResult(`%c Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`, "color: #0004ff;")
        visualLog(`%c Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`, "color: #0004ff;")
            // SEND THE LOG
            logEvent("INFO", `playFromSpecificPlaylist - Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`, {
                step: "playFromSpecificPlaylist",
                error: `GETTRACK_SUCCESS`,
                track: track.name,
                track_artist: track.artists[0].name,
                playlist: chosenplaylist.name,
                track_id: track.id,
                track_id_isrc: track.id,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        
        let trackISRC

        trackISRC = track.id

        queuePlaylistsMap.set(trackISRC, {
            name: chosenplaylist.name,
            playlist: chosenplaylist.id
        });

        const playTrackReturn = await playTrack(track.uri, false); //retry false

            if(playTrackReturn !== "SUCCESS"){
                console.warn("playFromSpecificPlaylist playTrack - safeSpotifyFetch - FAIL:", playTrackReturn)
            // SEND THE LOG
            logEvent("ERROR", `playFromSpecificPlaylist playTrack - safeSpotifyFetch - FAIL: ${playTrackReturn}`, {
                step: "playFromSpecificPlaylist",
                error: `PLAYTRACK_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                return("FAIL")
            }

            // To keep the music playing when the screen goes off, Android requires a "Foreground Service." Browsers can't do this easily, but there is a hack: The Media Session API. If you "tell" Android that media is playing, it’s less likely to kill the tab.
            // Add this whenever a song starts:
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track.name,
                    artist: `${track.artists[0].name} - ${chosenplaylist.name}`,
                    album: chosenplaylist.name,
                    chapterTitle: chosenplaylist.name,
                    artwork: [{ src: track.album.images[0].url }]
                });

                // Update the playback state so the play/pause button looks right
                navigator.mediaSession.playbackState = "playing";
            }

        incrementPlaylistCount(chosenplaylist.id)

        // --- ADD TO HISTORY ---
        addToHistory(track, chosenplaylist.name);

        // If the song that just started is the one at the top of our queue, remove it
        if (internalQueue.length > 0 && internalQueue[0].id === lastTrackId) {
            internalQueue.shift(); 
            renderQueue();
        }

        lastTrackId = trackISRC
        console.warn("lastTrackId - playFromSpecificPlaylist:", lastTrackId, track.name)
    } 
    else {
        console.log("Could not fetch that specific track. Try again!");
            // SEND THE LOG
            logEvent("WARN", `playFromSpecificPlaylist - Could not fetch that specific track. Try again!`, {
                step: "playFromSpecificPlaylist",
                error: `TRACKFETCH_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

        // If track was null (failed safety checks), try again!
        // console.log("Track was restricted or null. Retrying pick attempt " + (attempt + 1) + "...");
        // safeTimeout(() => pickRandomSong(attempt + 1), 1000) //setTimeout ensures you never make more than one retry per second 
    }

}

// The Context URI uses the /v1/me/player/play endpoing with a 'PUT' request
// This is a state-modifying API call like we use for playTrack() resumeOnThisDevice()
// As such, they don't operate well when a phone screen turns OFF
async function syncSpotifyContext(targetPlaylistUri, trackUri, currentProgress) {
    if(playlistContextChanging){
        console.log(`Already playlistContextChanging`)
        return
    }

    playlistContextChanging = true
    
    // Add a 1000ms buffer to account for API latency
    const paddedProgress = currentProgress + 2500;

    const accessToken = localStorage.getItem('access_token');
    try {
        await safeSpotifyFetch('https://api.spotify.com/v1/me/player/play', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                context_uri: targetPlaylistUri,
                offset: { uri: trackUri }, // This is the secret sauce
                position_ms: paddedProgress
            })
        });
        console.log("Context Synced to Playlist");
        contextSyncedForCurrentTrack = true;
        updateSyncIndicator(true)
    } catch (err) {
        console.error("Context sync failed", err);
    }
    
    playlistContextChanging = false
}

function updateSyncIndicator(isSynced) {
    const dot = document.getElementById('sync-dot');
    if (isSynced) {
        dot.classList.add('active');
    } else {
        dot.classList.remove('active');
    }
}

// Example usage within your existing playback logic:
// const contextSyncedForCurrentTrack = true; // or false based on app state
// updateSyncIndicator(contextSyncedForCurrentTrack);


async function prepareNextQueueItem(attempt = 0) {

    // Safety: Don't get stuck in an infinite loop if a playlist is 100% unplayable
    if (attempt > 5) {
        showResult(`%c Error: Finding next item for Queue failed too many times. Waiting for spotify to be re-authenticated.`, "color: #ff0000;")
        visualLog(`%c Error: Finding next item for Queue failed too many times. Waiting for spotify to be re-authenticated.`, "color: #ff0000;")
        console.log("Error: Finding next item for Queue failed too many times. Waiting for spotify to be re-authenticated.");
            // SEND THE LOG
            logEvent("WARN", `prepareNextQueueItem - Error: Finding next item for Queue failed too many times. Waiting for spotify to be re-authenticated.`, {
                step: "prepareNextQueueItem",
                error: `RESTRICTED_TRACKS_LIMIT`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return;
    }

            const token = await getStoredToken('access_token');

        // This is basically a "Silent" version of pickRandomSong
        const chosenplaylist = pickPlaylistByMode();
        if (!chosenplaylist) {
            console.warn("No playlist selected for auto-pick.");
            return; // Don't alert here, just stop
        }
        const playlistIndex = playlists.findIndex(p => p.id === chosenplaylist.id);

        const randomIndex = Math.floor(Math.random() * chosenplaylist.trackCount);

    // --- NEW: SPOTIFY ID VALIDATION ---
    // If the ID is just a name like "A" or "MyMix", we only do "Mock" mode
    const isSpotifyId = /^[a-zA-Z0-9]{22}$/.test(chosenplaylist.id);

    if (!isSpotifyId) {
        showResult(`[MOCK MODE] Playlist: ${chosenplaylist.name}, Track #${randomIndex + 1}`);
        console.log(`Bypassing Spotify API for non-Spotify Playlist: ${chosenplaylist.id}`);
        return; // STOP HERE: Do not call getTrackAtIndex or playTrack
    }

        console.log(`--------------- Queue Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${randomIndex + 1}`)
        //visualLog(`%c --------------- Queue Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${randomIndex + 1}`, "color: #0004ff;")
            // SEND THE LOG
            logEvent("TRACE", `prepareNextQueueItem - Queue Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${randomIndex + 1}`, {
                step: "prepareNextQueueItem",
                error: `QUEUE_TRACK`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        
    await refreshPlaylistCount(chosenplaylist.id, playlistIndex);
    const nextTrack = await getTrackAtIndex(token, chosenplaylist.id, randomIndex);


    if (nextTrack === "NETWORK_ERROR"){
        console.warn("prepareNextQueueItem - getTrackAtIndex - NETWORK_ERROR, stopping loop")
            // SEND THE LOG
            logEvent("ERROR", `prepareNextQueueItem - getTrackAtIndex - NETWORK_ERROR, stopping loop`, {
                step: "prepareNextQueueItem",
                error: `NETWORK_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return; // Stop the loop immediately!
    }
    
    // 4. RATE LIMIT CHECK: Stop if safeSpotifyFetch triggered a 429
    if (nextTrack === "RATE_LIMIT_HIT") {
        console.warn("prepareNextQueueItem - getTrackAtIndex - RATE_LIMIT_HIT, stopping loop");
            // SEND THE LOG
            logEvent("ERROR", `prepareNextQueueItem - getTrackAtIndex - RATE_LIMIT_HIT, stopping loop`, {
                step: "prepareNextQueueItem",
                error: `RATE_LIMIT_HIT`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return;
    }

    if (nextTrack === null) {
        if (isSoftLocked) {
            console.warn("prepareNextQueueItem - getTrackAtIndex: Mixer is soft-locked. Waiting for recovery...");
            // SEND THE LOG
            logEvent("WARN", `prepareNextQueueItem - getTrackAtIndex: Mixer is soft-locked. Waiting for recovery...`, {
                step: "prepareNextQueueItem",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return; // Don't even attempt a retry loop
        }
        // ... normal restricted track retry logic ...
    }


    if (nextTrack && nextTrack.uri) {

        console.log(`Queued up: ${nextTrack.name} by ${nextTrack.artists[0].name} -  ${chosenplaylist.name} for later.`);
        visualLog(`%c Queued up: ${nextTrack.name} by ${nextTrack.artists[0].name} -  ${chosenplaylist.name} for later.`, "color: #0004ff;")
            // SEND THE LOG
            logEvent("INFO", `prepareNextQueueItem - getTrackAtIndex: Queued up: [${nextTrack.name}  by ${nextTrack.artists[0].name} - ${chosenplaylist.name}] for later.`, {
                step: "prepareNextQueueItem",
                error: `QUEUE_TRACK`,
                track: nextTrack.name,
                track_artist: nextTrack.artists[0].name,
                playlist: chosenplaylist.name,
                track_id: nextTrack.id,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

        const returnAddToQueue = await addToQueue(nextTrack.uri);

        if(returnAddToQueue !== "SUCCESS"){
            console.warn("prepareNextQueueItem - addToQueue FAIL:", returnAddToQueue)
            // SEND THE LOG
            logEvent("ERROR", `prepareNextQueueItem - addToQueue FAIL: ${returnAddToQueue}`, {
                step: "prepareNextQueueItem",
                error: `QUEUE_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return("FAIL")
        }

        incrementPlaylistCount(chosenplaylist.id)

        let trackISRC
        trackISRC = nextTrack.id
        
        queuePlaylistsMap.set(trackISRC, {
            name: chosenplaylist.name,
            playlist: chosenplaylist.id
        });

        // 2. Add to our visual internal queue
        internalQueue.push({
            id: trackISRC,
            uri: nextTrack.uri,
            name: nextTrack.name,
            artist: nextTrack.artists[0].name,
            playlist: chosenplaylist.name
        });

        renderQueue();            
    } 
    else {
        console.log("Could not fetch that specific track. Try again!");
        // If track was null (failed safety checks), try again!
        console.log("Track was restricted or null. Retrying pick attempt " + (attempt + 1) + "...");
            // SEND THE LOG
            logEvent("WARN", `prepareNextQueueItem - getTrackAtIndex - Track was restricted or null. Retrying pick attempt ${attempt +1}...`, {
                step: "prepareNextQueueItem",
                error: `QUEUE_GETTRACK_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        safeTimeout(() => prepareNextQueueItem(attempt + 1), 1000) //setTimeout ensures you never make more than one retry per second 
    }
}

async function addToQueue(trackUri, isRetry = false) {
    const token = await getStoredToken('access_token'); // Using the retry helper
    const url = `https://api.spotify.com/v1/me/player/queue?uri=${trackUri}&device_id=${device_id}`;

    try {
        const response = await safeSpotifyFetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if(response && response.status){
            console.debug(`addToQueue - safeSpotifyFetch - response.status: ${response.status}`)
            // SEND THE LOG
            logEvent("INFO", `addToQueue - safeSpotifyFetch - response.status: ${response.status}`, {
                step: "addToQueue",
                error: `ADDTOQUEUE_RESTPONSE_STATUS`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        if(response === "MAX_CALLS_PER_MINUTE"){
            console.warn("addToQueue - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "addToQueue",
                error: `MAX_CALLS_PER_MINUTE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "SOFT_LOCKED"){
            console.warn("addToQueue - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "addToQueue",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "429_MAX_STRIKES"){
            console.warn("addToQueue - safeSpotifyFetch - 429_MAX_STRIKES")
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "addToQueue",
                error: `429_MAX_STRIKES`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "429_STRIKE"){
            console.warn("addToQueue - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - safeSpotifyFetch - 429_STRIKE`, {
                step: "addToQueue",
                error: `429_STRIKE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "401_TOKEN_EXPIRED"){
            console.warn("addToQueue - safeSpotifyFetch - 401_TOKEN_EXPIRED")
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - safeSpotifyFetch - 401_TOKEN_EXPIRED`, {
                step: "addToQueue",
                error: "401_TOKEN_EXPIRED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        if (response.status === 404) {
            console.warn("addToQueue Device ID not found. Attempting to refresh device list...");
            showResult(`%c Re-syncing with Spotify...`, "color: #ff8800;")
            visualLog(`%c Re-syncing with Spotify...`, "color: #ff8800;")

            // Check if the token is likely the problem
            const expiry = localStorage.getItem('token_expiry');
            if (Date.now() > expiry) {
                showResult(`%c 404 Session expired. Refreshing...`, "color: #ff0000;")
                visualLog(`%c 404 Session expired. Refreshing...`, "color: #ff0000;")
                console.warn("addToQueue 404 Session expired. Refreshing...");
            // SEND THE LOG
            logEvent("WARN", `addToQueue - safeSpotifyFetch - 404 Session expired. Refreshing...`, {
                step: "addToQueue",
                error: "404_SESSION_EXPIRED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                //await refreshAccessToken();
            }

            if(!isRetry){

                await refreshAccessToken();

                // Logic to re-fetch devices or re-initialize player
                // 1. Tell the SDK to re-announce itself to Spotify
                if(player){
                    // The SDK will try to reconnect itself, but we can nudge it:
                    await player.connect().then(success => {
                        if (success) {
                            visualLog(`%c Queueing song - Player reconnected successfully`, "color: #2d8a02")
                            showResult(`%c Queueing song - Player reconnected successfully`, "color: #2d8a02")
                            console.warn(`%c Queueing song - Player reconnected successfully`, "color: #2d8a02")
                            // SEND THE LOG
                            logEvent("WARN", `playTrack - Player reconnect SUCCESS`, {
                                step: "addToQueue",
                                error: `ADDTOQUEUE_RECONNECT_SUCCESS`,
                                stack_trace: new Error().stack, // Auto-trace errors
                                strikeCount: rateLimitStrikes,
                                activeMix: activeMixId
                            });
                        } 
                        else {
                            visualLog(`%c Queueing song - Player Re-Connection failed.`, "color: #ff0000;");
                            showResult(`%c Queueing song - Player Re-Connection failed.`, "color: #ff0000;");
                            console.error(`%c Queueing song - Player Re-Connection failed.`, "color: #ff0000;");
                            // SEND THE LOG
                            logEvent("WARN", `playTrack - Player reconnect FAIL`, {
                                step: "addToQueue",
                                error: `ADDTOQUEUE_RECONNECT_FAIL`,
                                stack_trace: new Error().stack, // Auto-trace errors
                                strikeCount: rateLimitStrikes,
                                activeMix: activeMixId
                            });
                        }
                    });
                }
                
                // 2. Wait a split second for the 'ready' event to update the device_id
                setTimeout(async () => {
                    console.warn("addToQueue - 404 Retrying playback with refreshed device...");
                    const returnAddToQueue = await addToQueue(trackUri, true); // retry = true to prevent infinite loops
                    if(returnAddToQueue === "SUCCESS"){
                        return "SUCCESS"
                    }
                    else{
                        console.warn("returnAddToQueue - 404 retry playback fail:", returnAddToQueue)
            // SEND THE LOG
            logEvent("WARN", `returnAddToQueue - safeSpotifyFetch - 404 retry playback fail: ${returnAddToQueue}`, {
                step: "returnAddToQueue",
                error: "404_DEVICE_ID_NOT_FOUND.RETRY.FAIL",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                        return "404_DEVICE_ID_NOT_FOUND.RETRY.FAIL"
                    }
                }, 1000);
            } else {
                console.warn("returnAddToQueue - 404 persisted after retry. Stopping loop.");
                showResult(`%c Queue attempt - Connection lost. Please Power Off and On again.`, "color: #ff0000;")
                visualLog(`%c Queue attempt - 404 persisted - Connection lost. Please Power Off and On again.`, "color: #ff0000;")
            // SEND THE LOG
            logEvent("WARN", `returnAddToQueue - safeSpotifyFetch - 404 persisted after retry. Stopping loop.`, {
                step: "returnAddToQueue",
                error: "404_DEVICE_NOT_FOUND",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                // EXIT HERE. No more setTimeouts.
            }
//            if(!response.ok){
                console.error("Error: returnAddToQueue - safeSpotifyFetch blocked")
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                }              //throw new Error(errorBody.error.message || "Forbidden or Not Found");
//            }
            return("404_DEVICE_NOT_FOUND");
        }

        if (response && (response.status === 200 || response.status === 202 || response.status === 204))  {
            console.log("Successfully added next song to Spotify Queue.");
            // SEND THE LOG
            logEvent("INFO", `addToQueue - safeSpotifyFetch - 200_202_204_SUCCESS - Successfully added next song to Spotify Queue.`, {
                step: "addToQueue",
                error: `200_202_204_SUCCESS`,
                track_uri: trackUri, 
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return("SUCCESS")
        }
        if(!response.ok){
            console.error("Error: addToQueue - safeSpotifyFetch blocked")
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - safeSpotifyFetch - BLOCKED`, {
                step: "addToQueue",
                error: `QUEUE_FETCH_BLOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                             //throw new Error(errorBody.error.message || "Forbidden or Not Found");
        throw new Error(errorData?.error?.message || "Forbidden or Not Found");
                }
        }
        else{
            console.error("Something else happened:", response)
        }

    } 
    catch (err) {
        console.error("Queue error:", err);
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - Queue error: ${err}`, {
                step: "addToQueue",
                error: `QUEUE_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return response
    }
}

function renderQueue() {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = internalQueue.map(track => `
        <li class="queue-item">
            <span class="track-info"><strong>${track.name}</strong> - ${track.artist}</span>
            <span class="source-playlist"; style="color: #8352f5; -webkit-text-stroke: 0.2px #c7c7c7;">- ${track.playlist}
            </span>
        </li>
    `).join('');
}

async function getSpotifyQueue() {
    const token = localStorage.getItem('access_token');

    try {
        const response = await fetch("https://api.spotify.com/v1/me/player/queue", {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });

        if (!response.ok) {
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyQueue - safeSpotifyFetch - Fetch Error`, {
                step: "getSpotifyQueue",
                error: `GET_SPOTIFY_QUEUE_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            throw new Error(`Failed to fetch queue: ${response.status}`);
        }

        const data = await response.json();
        
        // data.currently_playing: The track currently being played
        // data.queue: An array of upcoming tracks
        return data;
    } catch (error) {
        console.error("Error retrieving Spotify queue:", error);
        return null;
    }
}

function addToHistory(track, playlistName) {
    //console.warn("addToHistory")

    if(buttonPreviousNext){
        buttonPreviousNext = false
        return
    }

    // 1. Add to the beginning of our array
    playbackHistory.unshift(track);
    // Every time a NEW song starts from the mixer, 
    // we reset our position to the most recent track.
    historyIndex = 0;

    const historyList = document.getElementById('history-list');

    if (!historyList) return;

    // Remove the "No songs played yet" placeholder on first play
    if (historyList.innerHTML.includes("No songs played yet")) {
        historyList.innerHTML = "";
    }

    const entry = document.createElement('div');
    entry.className = 'history-item'
    entry.style.padding = "5px 0";
    entry.style.borderBottom = "1px solid #282828";
    
    // Format: Song Name - Artist (from Playlist Name)
    entry.innerHTML = `
        <div class="history-info">
            <button class="history-play-btn" data-uri="${track.uri}" style="background: #008cffff; border: none; cursor: pointer;">▶️</button>
            <strong style="color: #1DB954;">${track.name}</strong> 
            by ${track.artists[0].name} 
            <span style="font-size: 0.8em; color: #8352f5; -webkit-text-stroke: 0.2px #c7c7c7;">— ${playlistName}</span>
        </div>
    `;

    // Add to the top of the list
    historyList.prepend(entry);

    // // Keep only the last 10 entries
    // if (historyList.children.length > 10) {
    //     historyList.removeChild(historyList.lastChild);
    // }
    updateHistoryHighlight();
}

function updateHistoryHighlight() {
    const items = document.querySelectorAll('.history-item');
    items.forEach((item, idx) => {
        if (idx === historyIndex) {
            item.style.opacity = "1";
            item.style.borderLeft = "8px solid #1DB954"; // Spotify Green
            item.style.borderBottom = "4px solid #1DB954";
        } else {
            item.style.opacity = "0.9";
            item.style.borderLeft = "8px solid #000000";
            item.style.borderBottom = "none";
        }
    });
}

function visualLog(message, ...styles) {
    const id = logCounter++;
    const parts = message.split('%c');
    let logHTML = '';
    let currentStyleIndex = 0;

    //console.log(`visual parts`, parts)

    // 1. Start with only the FIRST segment (before any %c)
    // Using parts instead of the whole 'parts' array prevents comma injection
    logHTML += parts[0];

    // 2. Loop through subsequent segments, applying the next available style
    for (let i = 1; i < parts.length; i++) {
        const style = styles[currentStyleIndex] || '';
        parts[i] = parts[i].trim()
        logHTML += `<span style="${style}">${parts[i]}</span>`;
        currentStyleIndex++;
    }

    logMap.set(id, {
        text: logHTML,
        timestamp: new Date().toLocaleTimeString(),
        raw: message
    });
    
    renderLog();
}


function renderLog() {
    const logContainer = document.getElementById('visual-log-container');
    logContainer.innerHTML = ''; // Clear for fresh render

    logMap.forEach((entry, id) => {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.innerHTML = `<small>[${entry.timestamp}]</small> ${entry.text}`;
        //line.innerHTML = `${entry.text}`;
        logContainer.appendChild(line);
    });

    // Auto-scroll to bottom as new logs arrive
    logContainer.scrollTop = logContainer.scrollHeight;
}

function toggleLogExpansion() {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    const logContainer = document.getElementById('visual-log-container');
    const toggleBtn = document.getElementById('toggle-log-view');
    
    // Toggle the .expanded class
    const isExpanded = logContainer.classList.toggle('expanded');
    
    // Update button text based on the new state
    toggleBtn.textContent = isExpanded ? 'Collapse' : 'Show All';
    
    // Optional: Auto-scroll to the bottom when expanding to show latest logs
    // if (isExpanded) {
    //     logContainer.scrollTop = logContainer.scrollHeight;
    // }
    // Wait for the next browser paint cycle so the height is registered correctly
    requestAnimationFrame(() => {
        logContainer.scrollTop = logContainer.scrollHeight;
    });

    // For mobile browsers (which can be slower), a small timeout is a safer fallback
    setTimeout(() => {
        logContainer.scrollTop = logContainer.scrollHeight;
    }, 50); 

    if (isExpanded) {
        // EXPAND
        //max-height vs height: Using max-height: 1000px (or none) allows the box to grow only as large as the content inside it.
        logContainer.style.maxHeight = "none"; // Set to a height larger than your list
        logContainer.style.maxWidth = "none"
        logContainer.style.overflowY = "hidden";
        //btn.textContent = "▲ Show Less";
    } else {
        // COLLAPSE
        logContainer.style.maxHeight = "100px";
        logContainer.style.overflowY = "auto";
        //logContainer.textContent = "▼ Show All";
    }
}


// 2. Drag to Seek
const progressBar = document.getElementById('progress-bar');
// 1. Detect when the user starts dragging
progressBar.oninput = () => {
    isDraggingProgress = true;
    // Optional: Update the time label live as you drag
    document.getElementById('current-time').textContent = formatTime(progressBar.value);
};
progressBar.onchange = (e) => {
    const newPosition = e.target.value;
    player.seek(newPosition).then(() => {
        isDraggingProgress = false;
        console.log(`Seeked to ${newPosition}ms`);
    });
};

// 3. Skip 15s Logic
function seekRelative(offset) {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    player.getCurrentState().then(state => {
        if (!state) return;
        const newPos = Math.max(0, Math.min(state.duration, state.position + offset));
        player.seek(newPos);
        console.log(`Manual seek: ${offset > 0 ? '+' : ''}${offset/1000}s`);
    });
}

// 4. Volume Control
const volumeBar = document.getElementById('volume-bar');
volumeBar.oninput = (e) => {
    const volume = e.target.value / 100;
    player.setVolume(volume);
};

// Helper: Format ms to M:SS
function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

//To securely integrate your app, you should use the Authorization Code Flow with PKCE. This is the modern standard for client-side apps that cannot hide a "Client Secret".
// --- AUTHENTICATION CONFIG ---
//const clientId = 'YOUR_SPOTIFY_CLIENT_ID'; // Replace with your actual Client ID
let clientId = '3bb9a06bf9a24bc09260891c9d153abd'; // Replace with your actual Client ID
const client_secret = ''
//const redirectUri = 'http://127.0.0.1:8000/'; // Must match your Dashboard EXACTLY
//const redirectUri = 'http://192.168.1.141:8000/'; // Must match your Dashboard EXACTLY
//const redirectUri = 'https://benburtspotifyapp.netlify.app/'; // Must match your Dashboard EXACTLY
//const redirectUri = 'netlifylocation';
let  redirectUri = window.location.origin + '/'; 
// This automatically picks http://127.0.0.1 locally 
// AND https://your-app.netlify.app once hosted!
const scope = 'user-read-private user-read-email streaming user-modify-playback-state playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative user-read-playback-state user-read-currently-playing';

// Helper: Generate a random string for PKCE
const generateRandomString = (length) => {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = crypto.getRandomValues(new Uint8Array(length));
    return values.reduce((acc, x) => acc + possible[x % possible.length], "");
};

// Helper: SHA-256 hashing for the code challenge
const sha256 = async (plain) => {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return window.crypto.subtle.digest('SHA-256', data);
};

// Helper: Base64 encoding the hash
const base64encode = (input) => {
    return btoa(String.fromCharCode(...new Uint8Array(input)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

const generateCodeChallenge = async (verifier) => {
    const hashed = await sha256(verifier);
    return base64encode(hashed);
};

// This function starts the process by redirecting the user to Spotify’s secure login page.
async function redirectToSpotifyAuth() {
    const codeVerifier = generateRandomString(64);
    const hashed = await sha256(codeVerifier);
    const codeChallenge = base64encode(hashed);

            logEvent("WARN", `redirectToSpotifyAutH`, {
                step: "redirectToSpotifyAuth",
                error: "REDIRECT_TO_SPOTIFY_AUTH",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

    // Store verifier locally to verify the response later
    window.localStorage.setItem('code_verifier', codeVerifier);

    const params = {
        response_type: 'code',
        client_id: clientId,
        scope: scope,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
        show_dialog: true
    };

    const authUrl = new URL("https://accounts.spotify.com/authorize");
    authUrl.search = new URLSearchParams(params).toString();
    alert("Redirecting to: " + authUrl.toString());
    window.location.href = authUrl.toString(); // Redirects the entire page
}

async function loginWithSpotify() {
    clientId = localStorage.getItem('spotify_client_id');
    redirectUri = window.location.origin + '/';
    
    if (!clientId){
        //Show settings menu automatically
        document.getElementById('settings-menu').classList.remove('hidden')
        return alert("Please set your Client ID in the settings menu.");
    }

    // Generate PKCE parameters and save the verifier
    const codeVerifier = generateRandomString(128);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    localStorage.setItem('code_verifier', codeVerifier);

    // Redirect to Spotify Authorization URL with PKCE parameters
    const args = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: scope,
        redirect_uri: redirectUri,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge
    });

    //alert(`window.location: ${'https://accounts.spotify.com/authorize?' + args}`)
    window.location = 'https://accounts.spotify.com/authorize?' + args;
}

async function getAccessToken() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const codeVerifier = localStorage.getItem('code_verifier');
    const clientId = localStorage.getItem('spotify_client_id');
    console.log(`getAccessToken`)

    // POST request to exchange code and verifier for access token
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier
    });

    const response = await safeSpotifyFetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body
    });

    if(response === "MAX_CALLS_PER_MINUTE"){
        console.warn("getToken - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `getToken - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "getToken",
                error: `MAX_CALLS_PER_MINUTE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
    if(response === "SOFT_LOCKED"){
        console.warn("getToken - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("ERROR", `getToken - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "getToken",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
    if(response === "429_MAX_STRIKES"){
        console.warn("getToken - safeSpotifyFetch - 429_MAX_STRIKES")
            // SEND THE LOG
            logEvent("ERROR", `getToken - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "getToken",
                error: `429_MAX_STRIKES`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
    if(response === "429_STRIKE"){
        console.warn("getToken - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `getToken - safeSpotifyFetch - 429_STRIKE`, {
                step: "getToken",
                error: `429_STRIKE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }

    if(response.status) console.log(`getAccessToken ressponse.status: ${response.status}`)

    if(response.status === 400){
        console.warn(`getAccessToken - fetch PAYLOAD mismatch`)
        return
    }

    if(!response.ok){
        // Log the actual error message from Spotify (e.g., "invalid_grant")
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                }              //throw new Error(errorBody.error.message || "Forbidden or Not Found");
        //throw new Error(errorBody.error.message || "Forbidden or Not Found");
    }

    const data = await response.json();

    if (data.access_token) {
        window.localStorage.setItem('access_token', data.access_token);
        
        // --- ADD THIS LINE ---
        // Record exactly when this token will die (current time + 3600 seconds)
        const expiryTime = Date.now() + (3600 * 1000); 
        // Calculate absolute expiry: current time + (seconds from Spotify * 1000)
        const expiresAt = Date.now() + (data.expires_in * 1000);
        //window.localStorage.setItem('token_expiry', expiryTime);            
        window.localStorage.setItem('token_expiry', expiresAt);            

        // --- NEW: Store the refresh token ---
        if (data.refresh_token) {
            window.localStorage.setItem('refresh_token', data.refresh_token);
            console.warn("Refresh token saved for continuous play!");
        }
    }

}


async function getToken(code) {
    const codeVerifier = window.localStorage.getItem('code_verifier');

    const payload = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        }),
    };

    const response = await safeSpotifyFetch("https://accounts.spotify.com/api/token", payload);

    if(response === "MAX_CALLS_PER_MINUTE"){
        console.warn("getToken - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `getToken - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "getToken",
                error: `MAX_CALLS_PER_MINUTE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
    if(response === "SOFT_LOCKED"){
        console.warn("getToken - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("ERROR", `getToken - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "getToken",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
    if(response === "429_MAX_STRIKES"){
        console.warn("getToken - safeSpotifyFetch - 429_MAX_STRIKES")
            // SEND THE LOG
            logEvent("ERROR", `getToken - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "getToken",
                error: `429_MAX_STRIKES`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
    if(response === "429_STRIKE"){
        console.warn("getToken - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `getToken - safeSpotifyFetch - 429_STRIKE`, {
                step: "getToken",
                error: `429_STRIKE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }


    if(!response.ok){
        // Log the actual error message from Spotify (e.g., "invalid_grant")
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                }              //throw new Error(errorBody.error.message || "Forbidden or Not Found");
        //throw new Error(errorBody.error.message || "Forbidden or Not Found");
    }
    
    const data = await response.json();

    if (response.ok) {
        window.localStorage.setItem('access_token', data.access_token);
        // Clean the URL so the code isn't reused on refresh
        window.history.replaceState({}, document.title, "/");
    }

    if (data.access_token) {
        window.localStorage.setItem('access_token', data.access_token);
        
        // --- ADD THIS LINE ---
        // Record exactly when this token will die (current time + 3600 seconds)
        const expiryTime = Date.now() + (3600 * 1000); 
        // Calculate absolute expiry: current time + (seconds from Spotify * 1000)
        const expiresAt = Date.now() + (data.expires_in * 1000);
        //window.localStorage.setItem('token_expiry', expiryTime);            
        window.localStorage.setItem('token_expiry', expiresAt);            

        // --- NEW: Store the refresh token ---
        if (data.refresh_token) {
            window.localStorage.setItem('refresh_token', data.refresh_token);
            console.warn("Refresh token saved for continuous play!");
        }
    }
    // if (data.access_token) {
    //     window.localStorage.setItem('access_token', data.access_token);
    //     // Optional: setup a 'refresh_token' to keep the user logged in longer
    // }
}

async function getStoredToken(key, retries = 5) {
    for (let i = 0; i < retries; i++) {
        const val = localStorage.getItem(key);
        if (val) return val;
        await new Promise(r => setTimeout(r, 200)); // Wait 200ms for storage to mount
    }
    return null;
}

async function refreshAccessToken(refreshRetry = false) {

    console.warn(`refreshAccessToken CALL`)

    if (refreshStrikes > MAX_STRIKES_10MIN_REFRESH) {

        emergencyStop(); // Kill everything
        refreshStrikes = 0; // Reset for next Power On
        refreshTokenCallCounter = 0;

        showResult(`%c Refreshing Token -Slow down! Too many requests.`, "color: #ff7300;")
        console.warn("Slow down! Too many requests.");
        visualLog(`%c Refreshing Token -Slow down! Too many requests.`, "color: #ff7300;")
        console.warn("refreshAccessToken - MAX_STRIKES_10MIN_REFRESH")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - MAX_STRIKES_10MIN_REFRESH - Strike: ${refreshStrikes} - Slow down! Too many requests`, {
                step: "refreshAccessToken",
                error: "MAX_STRIKES_10MIN_REFRESH",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: refreshStrikes,
                activeMix: activeMixId
            });
        return
    }

    if (refreshTokenCallCounter > MAX_CALLS_PER_MINUTE_REFRESH) {

        refreshStrikes++;
        safeTimeout(() => refreshStrikes--, 600000); // Reset count after 10 min

        showResult(`%c Refreshing Token -Slow down! Too many requests.`, "color: #ffd000;")
        console.warn("Slow down! Too many requests.");
        visualLog(`%c Refreshing Token -Slow down! Too many requests.`, "color: #ffd000;")
        console.warn("refreshAccessToken - MAX_CALLS_PER_MINUTE_REFRESH")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - MAX_CALLS_PER_MINUTE_REFRESH - Strike: ${refreshStrikes} - Slow down! Too many requests`, {
                step: "refreshAccessToken",
                error: "MAX_CALLS_PER_MINUTE_REFRESH",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: refreshStrikes,
                activeMix: activeMixId
            });
        return
    }

    refreshTokenCallCounter++;
    safeTimeout(() => refreshTokenCallCounter--, 60000); // Reset count after 1 min
    
    if (isRefreshing && !refreshRetry){
        return; // Exit if a refresh is already in progress
    }

    isRefreshing = true;

    //const refreshToken = localStorage.getItem('refresh_token');
    const refreshToken = await getStoredToken('refresh_token');
    
    // CHANGE THIS:
    if (!refreshToken) {
        console.warn("No refresh token found. User needs to log in manually.");
        visualLog(`%c Unable to refresh. User needs to log in`, "color: #ff8800; background: #ffffff;")
            // SEND THE LOG
            logEvent("WARN", `refreshAccessToken - No refresh token found. User needs to log in manually.`, {
                step: "refreshAccessToken",
                error: `NO_REFRESH_TOKEN`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        alert("No refresh token found. User needs to log in manually.");
        // Change button text to show user is logged in
        document.getElementById('login-button').textContent = "Login with Spotify";
        document.getElementById('login-button').disabled = false;
        document.getElementById('login-button').style.background = "#ff0000";
        // REMOVE THIS: redirectToSpotifyAuth();
        // The Issue: When Chrome Android "hiccups" or puts a tab to sleep, it can sometimes lose access to the in-memory state. If your refreshAccessToken triggers before the storage is ready, it returns null.
        // The Fix: You must ensure refresh_token is explicitly pulled from localStorage every single time, and add a "Guard" to your refreshAccessToken so it doesn't redirect to login just because of a temporary glitch.        
        isRefreshing = false;
        return; // Just exit, don't redirect!
    }

    const payload = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
        }),
    };

    try {
        const response = await safeSpotifyFetchRaw("https://accounts.spotify.com/api/token", payload);

        if(response === "MAX_CALLS_PER_MINUTE"){
            console.warn("refreshAccessToken - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "refreshAccessToken",
                error: `MAX_CALLS_PER_MINUTE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "SOFT_LOCKED"){
            console.warn("refreshAccessToken - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "refreshAccessToken",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "429_MAX_STRIKES"){
            console.warn("refreshAccessToken - safeSpotifyFetch - 429_MAX_STRIKES")
                        // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "refreshAccessToken",
                error: `429_MAX_STRIKES`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "429_STRIKE"){
            console.warn("refreshAccessToken - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - safeSpotifyFetch - 429_STRIKE`, {
                step: "refreshAccessToken",
                error: `429_STRIKE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "401_TOKEN_EXPIRED"){
            console.warn("refreshAccessToken - safeSpotifyFetch - 401_TOKEN_EXPIRED")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - safeSpotifyFetch - 401_TOKEN_EXPIRED`, {
                step: "refreshAccessToken",
                error: "401_TOKEN_EXPIRED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            console.warn("Session actually expired. Clearing tokens.");
        //visualLog(`%c Session actually expired. Please re-login.`, "color: #ff8800; background: #ffffff;")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - Refresh failed, but staying on page, LOGIN NEEDED:`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_ERROR_LOGIN_NEEDED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');

            // ... update button to red ...
            // Don't redirect here! Just let the user click 'Login' manually if they need to.
            //localStorage.removeItem('access_token');
            //localStorage.removeItem('refresh_token');
            showResult(`%c Session expired. Please log in again.`, "color: #ff0000;")
            visualLog(`%c Session expired. Please log in again.`, "color: #ff0000;")
            alert("Session expired. Please log in again.");
            
            // Change button text to show user is logged in
            document.getElementById('login-button').textContent = "Login with Spotify";
            document.getElementById('login-button').disabled = false;
            document.getElementById('login-button').style.background = "#ff0000";
            return false
        }

        if(response.status){
            console.log(`refreshaccesstoken response.status: ${response.status}`)
            if((response.status === 401) || (response.status === 400)){ //messed up tokens
            console.warn("Session actually expired. Clearing tokens.");
        //visualLog(`%c Session actually expired. Please re-login.`, "color: #ff8800; background: #ffffff;")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - Refresh failed, but staying on page, LOGIN NEEDED:`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_ERROR_LOGIN_NEEDED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');

            // ... update button to red ...
            // Don't redirect here! Just let the user click 'Login' manually if they need to.
            //localStorage.removeItem('access_token');
            //localStorage.removeItem('refresh_token');
            showResult(`%c Session expired. Please log in again.`, "color: #ff0000;")
            visualLog(`%c Session expired. Please log in again.`, "color: #ff0000;")
            alert("Session expired. Please log in again.");
            
            // Change button text to show user is logged in
            document.getElementById('login-button').textContent = "Login with Spotify";
            document.getElementById('login-button').disabled = false;
            document.getElementById('login-button').style.background = "#ff0000";
            return false
            }
        }

        if(!response.ok){
            console.error("Error: refreshAccessToken - safeSpotifyFetch blocked")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - safeSpotifyFetch - BLOCKED`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_FETCH_BLOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                              //throw new Error(errorBody.error.message || "Forbidden or Not Found");

            throw response;
                }
        }

        const data = await response.json();

        if (data.access_token) {
            localStorage.setItem('access_token', data.access_token);
            
            // --- ADD THIS LINE ---
            // Record exactly when this token will die (current time + 3600 seconds)
            const expiryTime = Date.now() + (3600 * 1000); 
            // Calculate absolute expiry: current time + (seconds from Spotify * 1000)
            const expiresAt = Date.now() + (data.expires_in * 1000);
            //localStorage.setItem('token_expiry', expiryTime);
            localStorage.setItem('token_expiry', expiresAt);
            if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);

            console.warn("Token Refreshed Successfully!");
            visualLog(`%c Token Refreshed Successfully!`, "color: #27d18a")
            console.log(`%c refreshAccessToken - Token Refreshed Successfully! ${data.expires_in} ${expiresAt}`, "color: #27d18a")
            
            // SEND THE LOG
            logEvent("WARN", `refreshAccessToken - Token Refreshed Successfully! ${data.expires_in} ${expiresAt}`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_SUCCESS`,
                stack_trace: new Error().stack, // Auto-trace errors
                expires: `${data.expires_in} ${expiresAt}`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            // Change button text to show user is logged in
            document.getElementById('login-button').textContent = "Logged In";
            document.getElementById('login-button').disabled = false;
            document.getElementById('login-button').style.background = "#1DB954";
            isRefreshing = false;
            return true;
        }
    } 
    catch (err) {
        console.error("refreshAccessToken - Refresh failed, but staying on page:", err.status);

        // ONLY clear tokens if it's a definitive "Unauthorized" error from Spotify
        // If 'err' is a TypeError (Network Request Failed), we KEEP the tokens.
        if (err.status === 400 || err.status === 401) {
            console.warn("Session actually expired. Clearing tokens.");
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - Refresh failed, but staying on page, LOGIN NEEDED: ${err}`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_ERROR_LOGIN_NEEDED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');

            // ... update button to red ...
            // Don't redirect here! Just let the user click 'Login' manually if they need to.
            //localStorage.removeItem('access_token');
            //localStorage.removeItem('refresh_token');
            showResult(`%c Session expired. Please log in again.`, "color: #ff0000;")
            visualLog(`%c Session expired. Please log in again.`, "color: #ff0000;")
            
            // Change button text to show user is logged in
            document.getElementById('login-button').textContent = "Login with Spotify";
            document.getElementById('login-button').disabled = false;
            document.getElementById('login-button').style.background = "#ff0000";
        } 
        else {
            // It's likely a network flicker. DO NOT DELETE TOKENS.
            console.log("Network flicker detected. Keeping tokens for retry.");
            console.log(`err.status: ${err.status}`)
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - Refresh failed, Network flicker detected. Keeping tokens for retry: ${err}`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_ERROR_RETRY`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        isRefreshing = false;
    }
    isRefreshing = false;
}

async function getAvailableDevices() {
    const token = localStorage.getItem('access_token');
    const url = 'https://api.spotify.com/v1/me/player/devices';

    try {
        const response = await safeSpotifyFetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const data = await response.json();
            console.log("Found devices:", data.devices);
            return data.devices;
        }
        return;
    } catch (error) {
        console.error("Error fetching devices:", error);
        return;
    }
}

/**
 * Polling helper to ensure the device is not just ready, but ACTIVE on Spotify's servers.
 * @param {string} targetDeviceId - The ID from your player.addListener('ready')
 * @param {number} maxAttempts - How many times to check (default 5)
 * @param {number} interval - Delay between checks in ms (default 2000)
 */
async function waitForActiveDevice(targetDeviceId, maxAttempts = 5, interval = 2000) {
    console.log(`%c 🔍 Starting polling for active state on device: ${targetDeviceId}`, "color: #00d1ec;");
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`%c 📡 Checking device list (Attempt ${attempt}/${maxAttempts})...`);
        
        const devices = await getAvailableDevices();
        if (!devices) continue;

        // Find your specific device in the list
        // Your player name is "Ben's Mixer Lab"
        const myDevice = devices.find(d => d.name === "Ben's Mixer Lab" || d.id === targetDeviceId);

        if (myDevice) {
            // Update your global device_id if Spotify assigned a different one internally
            if (myDevice.id !== targetDeviceId) {
                console.log(`%c ⚠️ ID Mismatch! SDK said ${targetDeviceId}, but API sees ${myDevice.id}. Updating...`, "color: #ffa500;");
                device_id = myDevice.id; 
            }

            if (myDevice.is_active) {
                console.log(`%c ✅ Device is ACTIVE and verified by Spotify API.`, "color: #1DB954;");
                return true;
            } 
            else {
                console.log(`%c ⏳ Device found but is_active is false. Sending transfer command...`);
                if(!isRecoveringFromBackground) return true
                //await activateThisDevice(myDevice.id);
                //await resumeOnThisDevice(false) //caught in ready listener
                return true
            }
        } 
        else {
            console.log(`%c ❌ Device "Ben's Mixer Lab" not found in Spotify list yet.`, "color: #ff4444;");
        }

        // Wait before next poll
        await new Promise(resolve => safeTimeout(resolve, interval));
    }
    
    console.log(`%c 🛑 Polling timed out. Device never became active.`, "color: #ff0000; font-weight: bold;");
    return false;
}

let readyPollInterval = null;

// The function that handles the polling logic
function pollForReadyState() {
    // Clear any existing poll to prevent duplicates
    if (readyPollInterval) clearInterval(readyPollInterval);

    isPlayerReady = false

    const startTime = Date.now();
    const timeout = 5000; // 5 seconds max

    readyPollInterval = setInterval(async () => {
        const timeElapsed = Date.now() - startTime;

        // Check 1: Did the 'ready' listener fire?
        // Check 2: Even if listener didn't fire, does the SDK now have a state?
        const state = await player.getCurrentState();
        
        if (isPlayerReady || state !== null) {
            console.log(`%c Player reconnected successfully.`, "color: #1DB954; font-weight: bold;");
            visualLog(`%c Player reconnected successfully.`, "color: #1DB954; font-weight: bold;");
            showResult(`%c Player reconnected successfully.`, "color: #1DB954; font-weight: bold;");
                // SEND THE LOG
                logEvent("WARN", `pollForReadyState - Player reconnected successfully.`, {
                    step: "pollForReadyState",
                    error: "POLL_FOR_READY_PLAYER_SUCCESS",
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
            clearInterval(readyPollInterval);
            //recoverFromBackground(); // Your recovery logic
            return;
        }

        // Check 3: Have we timed out?
        if (timeElapsed >= timeout) {
            console.warn(`%c Ready poll timed out. Forcing recovery fallback.`, "color: #00c3ffff;");
            visualLog(`%c Ready poll timed out. Forcing recovery fallback.`, "color: #00c3ffff;");
            showResult(`%c Ready poll timed out. Forcing recovery fallback.`, "color: #00c3ffff;");
                // SEND THE LOG
                logEvent("WARN", `pollForReadyState - Ready poll timed out. Forcing recovery fallback.`, {
                    step: "pollForReadyState",
                    error: "POLL_FOR_READY_PLAYER_TIMEOUT",
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
            clearInterval(readyPollInterval);
            
            // Fallback: Manually trigger recovery even if isPlayerReady is false
            // This covers the case where the SDK is connected but 'silent'
            recoverFromBackground(); 
        }
    }, 500); // Check every 500ms
}

async function recoverFromBackground(){
    //If we haven't started music yet (first initialization) OR power OFF or disconnect
    if(!musicStartedOnDevice || isRecoveringFromBackground){
        isPlayerReady = device_ready = await waitForActiveDevice(device_id)
        if (device_ready) {
            visualLog(`%c 🚀 Mixer is fully synchronized. Ready for music.`, "color: #1DB954; font-weight: bold;");
            console.log(`%c 🚀 Mixer is fully synchronized. Ready for music.`, "color: #1DB954; font-weight: bold;");
            // Now it's safe to resume your queue refill or pick a random song


            devicePoweredOn = true; 
        }
        else{
            console.log(`%c 🛑 Device never became active.`, "color: #ff0000; font-weight: bold;");
            visualLog(`%c 🛑 Device never became active.`, "color: #ff0000; font-weight: bold;");
        }
    }

    // Check if we just reconnected specifically because of a background timeout
    if (isRecoveringFromBackground && device_ready){
        
        if(!musicPlayingOnDevice) {
            console.log(`Player Ready - isRecoveringFromBackground - MUSIC not playing - resumeOnThisDevice()`)
            await resumeOnThisDevice(false); //this still plays it, oh well
        }
        else{
            console.log(`Player Ready - isRecoveringFromBackground - but MUSIC ALREDY PLAYING - don't resume on device - HOPEFULLY NEVER CALLED`)
            await resumeOnThisDevice(true);
        }

        const newstate = await player.getCurrentState();
        // if there's a state, then spotify queue api, returns actual queue number
        // if there's no state, then spotify queue qpi, returns OPPOSITE of queue populated
        let current_track = null
        let next_track = null
        let next_tracks_length = null
        if(newstate){
            console.log(`player connected`)

            current_track = newstate.track_window.current_track;
            next_track = newstate.track_window.next_tracks;
            next_tracks_length = newstate.track_window.next_tracks.length;

            console.log('Currently Playing:', current_track.name);
            console.log(`Playing Next: ${next_track.name ? next_track.name : 'Queue is empty.'} next_tracks_length: ${next_tracks_length ? next_tracks_length : "next_tracks_length undefined"}`);
        }
        else{
            console.log(`player still not reconnected`)
        }


        await refreshAccessToken()

        let spotifyQueueEmpty = false
        // Example usage to check if the queue is empty
        await getSpotifyQueue().then(data => {
            if(data) console.log(`data.queue.length: ${data.queue.length}`)
            if(newstate) console.error(`(newstate) next_tracks_length: ${next_tracks_length ? next_tracks_length : "next_tracks_length undefined"}`)
        // if there's a state, then spotify queue api, returns actual queue number
        // if there's no state, then spotify queue qpi, returns OPPOSITE of queue populated
            if(newstate) data.queue.lenth = next_tracks_length ? next_tracks_length : 0
            if (data && data.queue.length === 0) {
                console.warn(`visibilitychange - VISIBILITY_CHANGE_SPOTIFY_QUEUE_POPULATED - There are ${data.queue.length} songs in the queue.`);
                // SEND THE LOG
                logEvent("WARN", `visibilitychange - VISIBILITY_CHANGE_SPOTIFY_QUEUE_POPULATED - There are ${data.queue.length} songs in the queue.`, {
                    step: "visibilitychange",
                    error: `VISIBILITY_CHANGE_SPOTIFY_QUEUE_POPULATED`,
                    stack_trace: new Error().stack, // Auto-trace errors
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
            } else if (data) {
                spotifyQueueEmpty = true
                console.warn("visibilitychange - VISIBILITY_CHANGE_SPOTIFY_QUEUE_EMPTY - The Spotify queue is currently empty.");
                visualLog(`%c 🔌 Player reconnected - The Spotify queue is currently empty.`, "color: #ff8800; background: #ffffff;")
                // SEND THE LOG
                logEvent("WARN", `visibilitychange - VISIBILITY_CHANGE_SPOTIFY_QUEUE_EMPTY - The Spotify queue is currently empty.`, {
                    step: "visibilitychange",
                    error: `VISIBILITY_CHANGE_SPOTIFY_QUEUE_EMPTY`,
                    stack_trace: new Error().stack, // Auto-trace errors
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
            }
        });

        if(spotifyQueueEmpty){
            console.log(`spotifyQueueEmpty`)
            // Refill the Spotify queue from the internal local queue
            if(internalQueue && internalQueue.length === 1){
                const track = internalQueue[0]
                        logEvent("WARN", `visibilitychange | Re-queued track: [${track.name} - ${track.artist} - ${track.playlist}] ${track.uri}`, {
                            step: "visibilitychange",
                            error: "VISIBILITY_CHANGE_REFILL_QUEUE",
                            track_id: track.id,
                            track_uri: track.uri,
                            track: track.name,
                            track_artist: track.artist,
                            playlist: track.playlist,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                        addToQueue(track.uri);
                        console.log(`%c Re-queued track: [${track.name} - ${track.artist} - ${track.playlist}] ${track.uri}`, "color: #9333e2ff");
            }
            if (internalQueue && internalQueue.length > 1) { //account for now playing in queue
                    internalQueue.slice(1).forEach((track, index) => {
                    // index here will start at 0, but 'track' will be the 2nd item

                    // Calculate wait time: increases by 10 seconds (10000ms) for each track
                    const waitincrement = index * 10;
                    
                    // track_uri must be a valid Spotify track URI (e.g., spotify:track:...)
                    safeTimeout(() => {
                        // SEND THE LOG
                        logEvent("WARN", `visibilitychange | Re-queued track: [${track.name} - ${track.artist} - ${track.playlist}] ${track.uri} after ${waitincrement}s`, {
                            step: "visibilitychange",
                            error: "VISIBILITY_CHANGE_REFILL_QUEUE",
                            track_id: track.id,
                            track_uri: track.uri,
                            track: track.name,
                            track_artist: track.artist,
                            playlist: track.playlist,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                        addToQueue(track.uri);
                        console.log(`Re-queued track: [${track.name} - ${track.artist} - ${track.playlist}] ${track.uri} after ${waitincrement}s`);
                    }, waitincrement * 1000);
                });
            }
        }
        else{
            console.log(`Didn't enter queue section`)
        }
    }
}

async function resumeOnThisDevice(resumePlay = false) {
    console.warn(`Attempting to reclaim playback resumeplay:${resumePlay} session with device_id: ${device_id}`);
    showResumeOverlay(false);
    
    try {
        // 1. Re-prime the browser's audio (Required for mobile)
        await player.activateElement();
        
        // 2. Tell Spotify to move the active session to this device_id
        const token = localStorage.getItem('access_token');
        const res = await safeSpotifyFetch(`https://api.spotify.com/v1/me/player?device_id=${device_id}`, {
            method: 'PUT',
            body: JSON.stringify({ device_ids: [device_id], play: resumePlay }),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        if(res === "MAX_CALLS_PER_MINUTE"){
            console.warn("resumeOnThisDevice - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
        }
        if(res === "SOFT_LOCKED"){
            console.warn("resumeOnThisDevice - safeSpotifyFetch - SOFT_LOCKED")
        }
        if(res === "429_MAX_STRIKES"){
            console.warn("resumeOnThisDevice - safeSpotifyFetch - 429_MAX_STRIKES")
        }
        if(res === "429_STRIKE"){
            console.warn("resumeOnThisDevice - safeSpotifyFetch - 429_STRIKE")
        }
        if(res === "401_TOKEN_EXPIRED"){
            console.warn("resumeOnThisDevice - safeSpotifyFetch - 401_TOKEN_EXPIRED")
        }

        if(!res.ok){
            console.error("Error: resumeOnThisDevice - safeSpotifyFetch blocked")
                if (res && typeof res.text === 'function') {
                const text = await res.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                            //throw new Error(errorBody.error.message || "Forbidden or Not Found");

            throw new Error(errorData?.error?.message || "Forbidden or Not Found");
                }
        }
        // The SDK will try to reconnect itself, but we can nudge it:
        if(player){
            // The SDK will try to reconnect itself, but we can nudge it:
            player.connect().then(success => {
                if (success) {
                    visualLog(`%c Reclaiming playback session - Player reconnected successfully`, "color: #2d8a02")
                    showResult(`%c Reclaiming playback session - Player reconnected successfully`, "color: #2d8a02")
                    console.log(`%c App RESUMING - Player reconnected successfully`, "color: #2d8a02")
                    // SEND THE LOG
                    logEvent("WARN", `Reclaim playback session - Player reconnect SUCCESS`, {
                        step: "resumeEvent",
                        error: `RESUMEONDEVICE_EVENT_RECONNECT_SUCCESS`,
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        activeMix: activeMixId
                    });
                } 
                else {
                    visualLog(`%c Reclaiming playback session - Player Re-Connection failed.`, "color: #ff0000;");
                    showResult(`%c Reclaiming playback session - Player Re-Connection failed.`, "color: #ff0000;");
                    console.error(`%c Reclaiming playback session - Player Re-Connection failed.`, "color: #ff0000;");
                    // SEND THE LOG
                    logEvent("WARN", `Reclaim playback session - Player reconnect FAIL`, {
                        step: "resumeEvent",
                        error: `RESUMEONDEVICE_EVENT_RECONNECT_FAIL`,
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        activeMix: activeMixId
                    });
                }
            });
        }

        showResult(`%c Mixer resumed on this phone / web broswer.`, "color: #2d8a02;")
        visualLog(`%c Mixer resumed on this phone / web broswer.`, "color: #2d8a02;")
        console.warn("Mixer resumed on this phone.");
    } catch (err) {
        console.error("resumeOnThisDevice - Failed to resume session:", err);
    }
}

function showResumeOverlay(visible) {
    const overlay = document.getElementById('resume-overlay');
    if (overlay) {
        overlay.style.display = visible ? 'flex' : 'none';
    }
}

async function getCurrentUserId() {
    const token = localStorage.getItem('access_token');
    const response = await safeSpotifyFetch('https://api.spotify.com/v1/me', {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if(response === "MAX_CALLS_PER_MINUTE"){
        console.warn("getCurrentUserId - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
    }
    if(response === "SOFT_LOCKED"){
        console.warn("getCurrentUserId - safeSpotifyFetch - SOFT_LOCKED")
    }
    if(response === "429_MAX_STRIKES"){
        console.warn("getCurrentUserId - safeSpotifyFetch - 429_MAX_STRIKES")
    }
    if(response === "429_STRIKE"){
        console.warn("getCurrentUserId - safeSpotifyFetch - 429_STRIKE")
    }
    if(response === "401_TOKEN_EXPIRED"){
        console.warn("getCurrentUserId - safeSpotifyFetch - 401_TOKEN_EXPIRED")
    }

    if(!response.ok){
        console.error("Error: getCurrentUserId - safeSpotifyFetch blocked")
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                       throw new Error(errorData?.error?.message || "Forbidden or Not Found");
                }
    }
    const data = await response.json();
    localStorage.setItem('spotify_user_id', data.id);
    return data.id;
}

let apiCallCounter = 0;
const MAX_CALLS_PER_MINUTE = 30; // Safe threshold for Dev Mode
const MAX_STRIKES = 3; // 3 strikes and you're out (Emergency Stop)

let refreshTokenCallCounter = 0;
const MAX_CALLS_PER_MINUTE_REFRESH = 5; // Safe threshold for Dev Mode
let refreshStrikes = 0;
const MAX_STRIKES_10MIN_REFRESH = 5; // Safe threshold for Dev Mode

let fetchUserProfileCallCounter = 0;
const MAX_CALLS_PER_MINUTE_FETCHUSER = 5; // Safe threshold for Dev Mode
let fetchUserStrikes = 0;
const MAX_STRIKES_10MIN_FETCHUSER = 5; // Safe threshold for Dev Mode

let isSoftLocked = false;
let fetch401 = false;
let loggingLocked = false;
let isSoftLockedISRC = false
let rateLimitStrikes = 0;
let rateLimitStrikesISRC = 0;

// Define this at the top of your script (Global Scope)
let spotifyFetchLock = Promise.resolve(); 

let isRefreshing = false;

async function safeSpotifyFetch(url, options) {

    // Add this new request to the existing queue
    spotifyFetchLock = spotifyFetchLock.then(async () => {
        try {            

            // Check for network connectivity (window.navigator.onLine)
            if (!window.navigator.onLine) {
                console.error(`%c safeSpotifyFetch - Network offline !navigator.onLine - skipping fetch`, "color: #ff0000");
                showResult(`%c App Network offline`, "color: #ff0000");
                visualLog(`%c safeSpotifyFetch - Network offline !navigator.onLine - skipping fetch`, "color: #ff0000");
            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetch - Network offline !navigator.onLine - skipping fetch`, {
                step: "safeSpotifyFetch",
                error: "SAFESPOTIFYFETCH_OFFLINE",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
                return; 
            }

            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetch - CALL`, {
                step: "safeSpotifyFetch",
                error: "SAFESPOTIFYFETCH_CALL",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetch - CALL_TOTAL`, {
                step: "safeSpotifyFetch",
                error: "SAFESPOTIFYFETCH_CALL_TOTAL",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
            if (apiCallCounter > MAX_CALLS_PER_MINUTE) {
                showResult(`%c Spotify Operation - Slow down! Too many requests.`, "color: #ff0000;")
                console.warn("Slow down! Too many requests.");
                visualLog(`%c Spotify Operation - Slow down! Too many requests.`, "color: #ff0000;")
                console.warn("safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
                    // SEND THE LOG
                    logEvent("WARN", `safeSpotifyFetch - MAX_CALLS_PER_MINUTE - Slow down! Too many requests`, {
                        step: "safeSpotifyFetch",
                        error: "MAX_CALLS_PER_MINUTE",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });
                return "MAX_CALLS_PER_MINUTE";
            }
    
            apiCallCounter++;
            safeTimeout(() => apiCallCounter--, 60000); // Reset count after 1 min

            if (isSoftLocked) {
                console.warn("Fetch blocked: Soft Lock active.");
                console.warn("safeSpotifyFetch - SOFT_LOCKED")
                    // SEND THE LOG
                    logEvent("WARN", `safeSpotifyFetch - SOFT_LOCKED - Fetch blocked: Soft Lock active.`, {
                        step: "safeSpotifyFetch",
                        error: "SOFT_LOCKED",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });

                return "SOFT_LOCKED";
            }

            const res = await fetch(url, options);

            if(res.status) console.log(`safespotifyfetch res.status: ${res.status}`)
            
            if (res.status === 429) {
                rateLimitStrikes++;
                // Soft Lock Logic
                isSoftLocked = true;

                // The Issue: In JavaScript, once a request body stream is read and sent by the first fetch(url, 
                // options), the browser marks that stream data as consumed/used.
                // The Fix: If you try to pass that same options object into a second fetch immediately after, 
                // the browser will throw a native TypeError: Failed to execute 'fetch' on 'Window': 
                // Cannot dupe/re-use a consumed stream body. To bypass this, you must clone or reconstruct the options if a body is present:
                let retryAfterOptions = { ...options}
                    if (options.body) {
                        retryOptions.body = options.body.toString();
                    }

                // Paste this directly into your F12 browser console to force the loop into action:
                const mockRes = { status: 9429 };

                // Simulate what happens when a standard fetch hits a 429
                if (mockRes.status === 429) {
                    console.log("🚀 Starting Rate Limit Simulation...");
                    
                    // This executes your exact client-side if-block logic
                    // Replace 'https://spotify.com' with whatever valid URL your function accepts
                    safeSpotifyFetch("https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent("https://spotify.com") + "&test429=true", { method: 'GET' });
                }
                //const response_retryAfter = await fetch("https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent(url) + "&test429=true", options)

                let response_retryAfter
                if(url.includes("test429=true")){
                    response_retryAfter = await fetch("https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent(url) + "&test429=true", options)
                }
                else{
                    response_retryAfter = await fetch("https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent(url), options)
                }
                // The primary reason response.headers.get("Retry-After") fails in a browser context is that Spotify's API does not currently include Access-Control-Expose-Headers: Retry-After in its response. 
                let retryAfter = response_retryAfter.headers.get("Retry-After") || 5;

                const hours = Math.floor(retryAfter /  3600000);
                const minutes = Math.floor((retryAfter % 3600000) / 60000);
                const seconds = Math.floor((retryAfter % 60000) / 1000);

                // Calculate delay: 2^attempt * 1000ms (1s, 2s, 4s, 8s...)
                // Add 'jitter' (randomness) to prevent synchronized retries
                //retryAfter = (Math.pow(2, (rateLimitStrikes-1)) + Math.random()) * 10; // 10s, 20s, 40s, 80s

                showResult(`%c Rate limited. Waiting ${retryAfter}s... Hours:${hours}:${minutes}:${seconds}`, "color: #ff0000;")
                visualLog(`%c Rate limited. Waiting ${retryAfter}s... Hours:${hours}:${minutes}:${seconds}`, "color: #ff0000;")
                console.warn(`Rate limited. (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s... Hours:${hours}:${minutes}:${seconds}`);
                //showResult(`Rate limit hit (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`);
                console.warn(`Rate limit hit (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s... Hours:${hours}:${minutes}:${seconds}`);
                // You MUST wait this long before trying again
                
                if (rateLimitStrikes >= MAX_STRIKES) {
                    showResult(`%c CRITICAL: Repeated rate limits. Hard-resetting mixer.`, "color: #ff0000;")
                    visualLog(`%c CRITICAL: Repeated rate limits. Hard-resetting mixer.`, "color: #ff0000;")
                    console.warn("CRITICAL: Repeated rate limits. Hard-resetting mixer.");
                    emergencyStop(); // Kill everything
                    rateLimitStrikes = 0; // Reset for next Power On
                    isSoftLocked = false;
                    console.log("Soft Lock lifted.");

                    // SEND THE LOG
                    logEvent("ERROR", `safeSpotifyFetch - CRITICAL: Repeated rate limits. Hard-resetting mixer. (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s... Hours:${hours}:${minutes}:${seconds}`, {
                        step: "safeSpotifyFetch",
                        error: "429_MAX_STRIKES",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        calculatedWaitSeconds: retryAfter,
                        activeMix: activeMixId
                    });

                    return "429_MAX_STRIKES";
                }


                // Soft Lock: Just wait, don't kill the player
                setTimeout(() => {
                    isSoftLocked = false;
                    showResult(`%c Soft Lock ${rateLimitStrikes} lifted.`, "color: #00d9ff;")
                    visualLog(`%c Soft Lock ${rateLimitStrikes} lifted.`, "color: #00d9ff;")
                    console.log(`Soft Lock ${rateLimitStrikes} lifted.`);
                    // If we go 2 minutes without another 429, clear a strike
                    setTimeout(() => { if(rateLimitStrikes > 0) rateLimitStrikes--; }, 120000);
                //}, retryAfter * 1000);
                }, retryAfter);
        //        if(!res.ok){
                    console.error("Error: safeSpotifyFetch - safeSpotifyFetch blocked")
                        if (res && typeof res.text === 'function') {
                        const text = await res.text(); // Get raw text first (never crashes)
                        const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                        console.error(errorData?.error?.message || "Forbidden or Not Found");  
                        }
                    //throw new Error(errorBody.error.message || "Forbidden or Not Found");
        //        }

                    // SEND THE LOG
                    logEvent("ERROR", `safeSpotifyFetch - Rate limit hit (Strike ${rateLimitStrikesISRC}). Pausing ${retryAfter}s... Hours:${hours}:${minutes}:${seconds}`, {
                        step: "safeSpotifyFetch",
                        error: "429_STRIKE",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        calculatedWaitSeconds: retryAfter,
                        activeMix: activeMixId
                    });

                return "429_STRIKE";
            }
            if (res.status === 401) { //Handle expired token
                if(fetch401){ //refresh didn't work - don't have endless loop
                    fetch401 = false
                    console.warn("🔐 401 Token Fetch Retry - 2nd 401 detected: Token really expired. Ending retry loop");
                    visualLog(`%c 🔐 401 Token Fetch Retry - 2nd 401 detected: Token really expired.`, "color: #ff0000; background: #ffffff;")
                    // SEND THE LOG
                    logEvent("ERROR", `safeSpotifyFetch - 401 Token Fetch Retry - 2nd 401 detected: Token really expired. Ending retry loop`, {
                        step: "safeSpotifyFetch",
                        error: "401_TOKEN_EXPIRED_RETRY_FAIL",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });
                    return "401_TOKEN_EXPIRED"
                }

                fetch401 = true

                console.warn("🔐 401 detected: Token expired. Refreshing now...");
                visualLog(`%c 🔐 401 detected: Token expired. Refreshing now...`, "color: #ff8800; background: #ffffff;")
                    // SEND THE LOG
                    logEvent("ERROR", `safeSpotifyFetch - 401 detected: Token expired. Refreshing token now. And retrying original url fetch...`, {
                        step: "safeSpotifyFetch",
                        error: "401_TOKEN_EXPIRED_RETRY",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });
                // If your enqueuing logic hits a 401/429 while the screen is locked, 
                // your "Exponential Backoff" might be keeping the CPU awake too long, which triggers the OS "Auto-Kill."
                // It is better to have the music stay paused than to have the whole app crash and reload.
                // if (document.visibilityState === 'hidden') { console.log('Silent fail'); return; }

                // Wait for the refresh to complete
                //console.log(`refreshAccessToken`)
                if(isRefreshing){
                    await refreshAccessToken(true);
                }
                else{
                    await refreshAccessToken();
                }
                //console.log(`refreshAccessToken done`)
                
                //if (success) {
                    // Update the Authorization header with the fresh token
                    const newToken = localStorage.getItem('access_token');
                    options.headers = {
                        ...options.headers,
                        'Authorization': `Bearer ${newToken}`
                    };
                    
                    // Retry the EXACT same request one more time
                    console.log("🔄 Retrying original request with new token...");
                    // SEND THE LOG
                    logEvent("WARN", `safeSpotifyFetch - Retrying original request with new token...`, {
                        step: "safeSpotifyFetch",
                        error: "SAFESPOTIFYFETCH_RETRY",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });

                    // To this:
                    const retryRes = await safeSpotifyFetchRaw(url, options);
                    return retryRes;                // } else {
                //     logEvent("ERROR", "Automatic token refresh failed");
                //     return null;
                // }
            }
    
            return res;
        } catch (error) {
            console.error("Fetch failed (possible background throttle):", error.message);
        }
    }).catch(err => {
        console.error("Queue process error:", err);
    });

    // Wait for this specific task in the queue to finish
    return spotifyFetchLock;
}
async function safeSpotifyFetchRaw(url, options) { // THIS IS USED ONLY FOR REFRESHING ACCESS TOKENS - TO ALLOW A RETRY

            // Check for network connectivity (window.navigator.onLine)
            if (!window.navigator.onLine) {
                console.error(`%c safeSpotifyFetchRaw - Network offline !navigator.onLine - skipping fetch`, "color: #ff0000");
                showResult(`%c App Network offline`, "color: #ff0000");
                visualLog(`%c safeSpotifyFetchRaw - Network offline !navigator.onLine - skipping fetch`, "color: #ff0000");
            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetchRaw - Network offline !navigator.onLine - skipping fetch`, {
                step: "safeSpotifyFetchRaw",
                error: "SAFESPOTIFYFETCH_RAW_OFFLINE",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
                return; 
            }

            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetchRaw - CALL`, {
                step: "safeSpotifyFetchRaw",
                error: "SAFESPOTIFYFETCH_RAW_CALL",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetchRaw - CALL_TOTAL`, {
                step: "safeSpotifyFetchRaw",
                error: "SAFESPOTIFYFETCH_RAW_CALL_TOTAL",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
            if (apiCallCounter > MAX_CALLS_PER_MINUTE) {
                showResult(`%c Spotify Operation - Slow down! Too many requests.`, "color: #ff0000;")
                console.warn("Slow down! Too many requests.");
                visualLog(`%c Spotify Operation - Slow down! Too many requests.`, "color: #ff0000;")
                console.warn("safeSpotifyFetchRaw - MAX_CALLS_PER_MINUTE")
                    // SEND THE LOG
                    logEvent("WARN", `safeSpotifyFetchRaw - MAX_CALLS_PER_MINUTE - Slow down! Too many requests`, {
                        step: "safeSpotifyFetchRaw",
                        error: "MAX_CALLS_PER_MINUTE_RAW",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });
                return "MAX_CALLS_PER_MINUTE";
            }
    
            apiCallCounter++;
            safeTimeout(() => apiCallCounter--, 60000); // Reset count after 1 min

            if (isSoftLocked) {
                console.warn("Fetch blocked: Soft Lock active.");
                console.warn("safeSpotifyFetchRaw - SOFT_LOCKED")
                    // SEND THE LOG
                    logEvent("WARN", `safeSpotifyFetchRaw - SOFT_LOCKED - Fetch blocked: Soft Lock active.`, {
                        step: "safeSpotifyFetchRaw",
                        error: "SOFT_LOCKED_RAW",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });

                return "SOFT_LOCKED";
            }

            const res = await fetch(url, options);

            if(res.status) console.log(`safeSpotifyFetchRaw res.status: ${res.status}`)
            
            if (res.status === 429) {
                rateLimitStrikes++;
                // Soft Lock Logic
                isSoftLocked = true;

                // The primary reason response.headers.get("Retry-After") fails in a browser context is that Spotify's API does not currently include Access-Control-Expose-Headers: Retry-After in its response. 
                let retryAfter = res.headers.get("Retry-After") || 5;
                
                // Calculate delay: 2^attempt * 1000ms (1s, 2s, 4s, 8s...)
                // Add 'jitter' (randomness) to prevent synchronized retries
                retryAfter = (Math.pow(2, (rateLimitStrikes-1)) + Math.random()) * 10; // 10s, 20s, 40s, 80s

                showResult(`%c Rate limited. Waiting ${retryAfter}s...`, "color: #ff0000;")
                visualLog(`%c Rate limited. Waiting ${retryAfter}s...`, "color: #ff0000;")
                console.warn(`Rate limited. (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`);
                //showResult(`Rate limit hit (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`);
                console.warn(`Rate limit hit (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`);
                // You MUST wait this long before trying again
                
                if (rateLimitStrikes >= MAX_STRIKES) {
                    showResult(`%c CRITICAL: Repeated rate limits. Hard-resetting mixer.`, "color: #ff0000;")
                    visualLog(`%c CRITICAL: Repeated rate limits. Hard-resetting mixer.`, "color: #ff0000;")
                    console.warn("CRITICAL: Repeated rate limits. Hard-resetting mixer.");
                    emergencyStop(); // Kill everything
                    rateLimitStrikes = 0; // Reset for next Power On
                    isSoftLocked = false;
                    console.log("Soft Lock lifted.");

                    // SEND THE LOG
                    logEvent("ERROR", `safeSpotifyFetchRaw - CRITICAL: Repeated rate limits. Hard-resetting mixer. (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`, {
                        step: "safeSpotifyFetchRaw",
                        error: "429_MAX_STRIKES_RAW",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        calculatedWaitSeconds: retryAfter,
                        activeMix: activeMixId
                    });

                    return "429_MAX_STRIKES";
                }


                // Soft Lock: Just wait, don't kill the player
                setTimeout(() => {
                    isSoftLocked = false;
                    showResult(`%c Soft Lock ${rateLimitStrikes} lifted.`, "color: #00d9ff;")
                    visualLog(`%c Soft Lock ${rateLimitStrikes} lifted.`, "color: #00d9ff;")
                    console.log(`Soft Lock ${rateLimitStrikes} lifted.`);
                    // If we go 2 minutes without another 429, clear a strike
                    setTimeout(() => { if(rateLimitStrikes > 0) rateLimitStrikes--; }, 120000);
                }, retryAfter * 1000);
        //        if(!res.ok){
                    console.error("Error: safeSpotifyFetchRaw - safeSpotifyFetch blocked")
                        if (res && typeof res.text === 'function') {
                        const text = await res.text(); // Get raw text first (never crashes)
                        const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                        console.error(errorData?.error?.message || "Forbidden or Not Found");  
                        }
                    //throw new Error(errorBody.error.message || "Forbidden or Not Found");
        //        }

                    // SEND THE LOG
                    logEvent("ERROR", `safeSpotifyFetchRaw - Rate limit hit (Strike ${rateLimitStrikesISRC}). Pausing ${retryAfter}s...`, {
                        step: "safeSpotifyFetchRaw",
                        error: "429_STRIKE_RAW",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        calculatedWaitSeconds: retryAfter,
                        activeMix: activeMixId
                    });

                return "429_STRIKE";
            }
            if (res.status === 401) { //Handle expired token
                if(fetch401){ //refresh didn't work - don't have endless loop
                    fetch401 = false
                    console.warn("🔐 401 Token Fetch Retry - 2nd 401 detected: Token really expired. Ending retry loop");
                    visualLog(`%c 🔐 401 Token Fetch Retry - 2nd 401 detected: Token really expired.`, "color: #ff0000; background: #ffffff;")
                    // SEND THE LOG
                    logEvent("ERROR", `safeSpotifyFetchRaw - 401 Token Fetch Retry - 2nd 401 detected: Token really expired. Ending retry loop`, {
                        step: "safeSpotifyFetchRaw",
                        error: "401_TOKEN_EXPIRED_RETRY_FAIL_RAW",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });
                    return "401_TOKEN_EXPIRED"
                }

                fetch401 = true

                console.warn("🔐 401 detected: Token expired. Refreshing now...");
                visualLog(`%c 🔐 401 detected: Token expired. Refreshing now...`, "color: #ff8800; background: #ffffff;")
                    // SEND THE LOG
                    logEvent("ERROR", `safeSpotifyFetchRaw - 401 detected: Token expired. Refreshing token now. And retrying original url fetch...`, {
                        step: "safeSpotifyFetchRaw",
                        error: "401_TOKEN_EXPIRED_RETRY_RAW",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });
                // If your enqueuing logic hits a 401/429 while the screen is locked, 
                // your "Exponential Backoff" might be keeping the CPU awake too long, which triggers the OS "Auto-Kill."
                // It is better to have the music stay paused than to have the whole app crash and reload.
                // if (document.visibilityState === 'hidden') { console.log('Silent fail'); return; }

                // Wait for the refresh to complete
                //console.log(`refreshAccessToken`)
                if(isRefreshing){
                    await refreshAccessToken(true);
                }
                else{
                    await refreshAccessToken();
                }
                //console.log(`refreshAccessToken done`)
                
                //if (success) {
                    // Update the Authorization header with the fresh token
                    const newToken = localStorage.getItem('access_token');
                    options.headers = {
                        ...options.headers,
                        'Authorization': `Bearer ${newToken}`
                    };
                    
                    // Retry the EXACT same request one more time
                    console.log("🔄 Retrying original request with new token...");
                    // SEND THE LOG
                    logEvent("WARN", `safeSpotifyFetchRaw - Retrying original request with new token...`, {
                        step: "safeSpotifyFetchRaw",
                        error: "SAFESPOTIFYFETCH_RETRY_RAW",
                        stack_trace: new Error().stack, // Auto-trace errors
                        strikeCount: rateLimitStrikes,
                        endpoint: url,
                        activeMix: activeMixId
                    });

                    // To this:
                    const retryRes = await safeSpotifyFetchRaw(url, options);
                    return retryRes;                // } else {
                //     logEvent("ERROR", "Automatic token refresh failed");
                //     return null;
                // }
            }
    
            return res;
}
async function safeSpotifyFetchISRC(url, options) {
            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetch ISRC - CALL`, {
                step: "safeSpotifyFetchISRC",
                error: "SAFESPOTIFYFETCH_ISRC_CALL",
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetch ISRC - CALL_TOTAL`, {
                step: "safeSpotifyFetchISRC",
                error: "SAFESPOTIFYFETCH_CALL_TOTAL",
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
    if (apiCallCounter > MAX_CALLS_PER_MINUTE) {
        showResult("Slow down! Too many requests.");
        console.warn("Slow down! Too many requests.");
        console.warn("safeSpotifyFetchISRC - MAX_CALLS_PER_MINUTE")
        return "MAX_CALLS_PER_MINUTE";
    }
    
    apiCallCounter++;
    safeTimeout(() => apiCallCounter--, 60000); // Reset count after 1 min

    if (isSoftLockedISRC) {
        console.warn("Fetch blocked: Soft Lock active.");
        console.warn("safeSpotifyFetchISRC - SOFT_LOCKED")
        return "SOFT_LOCKED";
    }

    const res = await fetch(url, options);

    if(res.status) console.log(`safespotifyfetch res.status: ${res.status}`)
    
    if (res.status === 429) {
        rateLimitStrikesISRC++;
        // Soft Lock Logic
        isSoftLockedISRC = true;

        // The primary reason response.headers.get("Retry-After") fails in a browser context is that Spotify's API does not currently include Access-Control-Expose-Headers: Retry-After in its response. 
        let retryAfter = res.headers.get("Retry-After") || 5;
        
        // Calculate delay: 2^attempt * 1000ms (1s, 2s, 4s, 8s...)
        // Add 'jitter' (randomness) to prevent synchronized retries
        retryAfter = (Math.pow(2, attempt) + Math.random()) * 10; // 10s, 20s, 40s, 80s

        showResult(`Rate limited. Waiting ${retryAfter}s...`);
        console.warn(`Rate limited. Waiting ${retryAfter}s...`);
        showResult(`Rate limit hit (Strike ${rateLimitStrikesISRC}). Pausing ${retryAfter}s...`);
        console.warn(`Rate limit hit (Strike ${rateLimitStrikesISRC}). Pausing ${retryAfter}s...`);

        // You MUST wait this long before trying again
        
        if (rateLimitStrikesISRC >= MAX_STRIKES) {
            showResult("CRITICAL: Repeated rate limits. Hard-resetting mixer.");
            console.warn("CRITICAL: Repeated rate limits. Hard-resetting mixer.");
            emergencyStop(); // Kill everything
            rateLimitStrikesISRC = 0; // Reset for next Power On
            isSoftLockedISRC = false;
            console.log("Soft Lock lifted.");

            // SEND THE LOG
            logEvent("ERROR", `safeSpotifyFetchISRC - CRITICAL: Repeated rate limits. Hard-resetting mixer. (Strike ${rateLimitStrikesISRC}). Pausing ${retryAfter}s...`, {
                step: "safeSpotifyFetchISRC",
                error: "429_MAX_STRIKES",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikesISRC,
                endpoint: url,
                calculatedWaitSeconds: retryAfter,
                activeMix: activeMixId
            });

            return "429_MAX_STRIKES";
        }


        // Soft Lock: Just wait, don't kill the player
        setTimeout(() => {
            isSoftLockedISRC = false;
            showResult(`Soft Lock ${rateLimitStrikes} lifted.`);
            console.log(`Soft Lock ${rateLimitStrikes} lifted.`);
            // If we go 2 minutes without another 429, clear a strike
            setTimeout(() => { if(rateLimitStrikesISRC > 0) rateLimitStrikesISRC--; }, 120000);
        }, retryAfter * 1000);
//        if(!res.ok){
            console.error("Error: safeSpotifyFetchISRC - safeSpotifyFetchISRC blocked")
                if (res && typeof res.text === 'function') {
                const text = await res.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                }
            //throw new Error(errorBody.error.message || "Forbidden or Not Found");
//        }

            // SEND THE LOG
            logEvent("ERROR", `safeSpotifyFetch - Rate limit hit (Strike ${rateLimitStrikesISRC}). Pausing ${retryAfter}s...`, {
                step: "safeSpotifyFetchISRC",
                error: "429_STRIKE",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikesISRC,
                endpoint: url,
                calculatedWaitSeconds: retryAfter,
                activeMix: activeMixId
            });

        return "429_STRIKE";
    }
    
    return res;
}

async function retrieveISRCid (track){
        console.error("pickRandomSong - checking ISRC")
        const token = localStorage.getItem('access_token');
        let trackISRC
        const url = `https://api.spotify.com/v1/tracks/${track.id}`
        try {
            let returnCode = "NONE"
            const response = await safeSpotifyFetchISRC(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if(response === "MAX_CALLS_PER_MINUTE"){
                console.warn("pickRandomSong ISRC - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong ISRC - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "pickRandomSong",
                error: `MAX_CALLS_PER_MINUTE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            }
            if(response === "SOFT_LOCKED"){
                console.warn("pickRandomSong ISRC - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong ISRC - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "pickRandomSong",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            }
            if(response === "429_MAX_STRIKES"){
                console.warn("pickRandomSong ISRC - safeSpotifyFetch - 429_MAX_STRIKES")
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong ISRC - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "pickRandomSong",
                error: `429_MAX_STRIKES`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            }
            if(response === "429_STRIKE"){
                console.warn("pickRandomSong ISRC - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong ISRC - safeSpotifyFetch - 429_STRIKE`, {
                step: "pickRandomSong",
                error: `429_STRIKE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            }

            if (!response.ok) {
                console.error("Error: pickRandomSong trackid.isrc - safeSpotifyFetch blocked")
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong ISRC - safeSpotifyFetch - BLOCKED`, {
                step: "pickRandomSong",
                error: `PICKRANDOM_ISRC_FETCH_BLOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                }
                // throw new Error(errorData.error.message || "Playlist not found");

                //Use existing current_id instead of trackISRC

                trackISRC = track.id
            } else{
                const fullTrackData = await response.json();
                
                // NOW you have access to the ISRC!
                trackISRC = fullTrackData.external_ids?.isrc;
                console.log("Verified ISRC:", trackISRC, track.name);
            // SEND THE LOG
            logEvent("TRACE", `pickRandomSong ISRC - Verified ISRC: ${trackISRC} ${track.name}`, {
                step: "pickRandomSong",
                error: `ISRC_VERIFIED`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            }
        } 
        catch (err) {
            console.error("Failed to fetch ISRC:", err);
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong ISRC - Failed to fetch ISRC: ${err}`, {
                step: "pickRandomSong",
                error: `ISRC_FAILURE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return "ISRC_FAILURE"
        }
}


const MOCK_MODE = false

let playlists = [
    {id: "0eWgOpuQl2sXTGpomp6UG2", enabled: true, name: "Cover Very Good", trackCount: 10},
    {id: "0eWgOpuQl2sXTGpomp6UG2", enabled: true, name: "Cover Very Good", trackCount: 1},
    {id: "0eWgOpuQl2sXTGpomp6UG2", enabled: true, name: "Cover Very Good", trackCount: 1}
]

const playlistColorPalette = [
    "#fde2e4", //pink
    "#e2f0cb", //green
    "#dbe7fd", //blue
    "#fff1c1", //yellow
    "#e7d9ff", //lavender
    "#ffd6a5", //orange
    "#caffbf", //mint
    "#fc4f4f", //pink
    "#6c962a", //green
    "#4b88f8", //blue
    "#fffc40", //yellow
    "#9a62fc", //lavender
    "#ff991b", //orange
    "#2bff00",  //mint
    "#ff6f6f", //pink
    "#6c962a", //green
    "#45fcfc", //blue
    "#c7c400", //yellow
    "#4d05ca", //lavender
    "#d87804", //orange
    "#025f57"  //mint
]

//Not used anymore
// function generatePlaylistColor() {
//     const color = playlistColorPalette[nextColorIndex % playlistColorPalette.length]
//     nextColorIndex++
//     return color
// }

let mixes = {}
let activeMixId = null
let selectionMode = "balanced" // normal | balanced | percentage (mix) | relative (weight)
let isProgrammaticSliderUpdate = false //to prevent infinite loops when sliders rebalance

// Example array definition for your main configuration loop
let currentMixConfiguration = {
    mixName: "My Custom Blend",
    nodes: [] // This will store both individual playlists and folder nodes
};

// This is your safe, updated mix configuration object layout
let activeMixProfile = {
    id: "my-mix-123",
    name: "Prog Rock Mix",
    playlists: [
        // Your existing playlist arrays stay EXACTLY like this
        { id: "37i9dQZF1DX", name: "Classic Rock", sliderValue: 20, parentFolderId: null }
    ],
    folders: [
        // 🟢 New folders array layer added safely adjacent to your data
    ]
};

const multipliers = [0.25, 0.5, 0.75, 1.0, 1.25, 1.75, 2.5];

let SessionPlaylistTrackCountUpdated = {}
// SessionPlaylistTrackCountUpdated["000"] = {
//     updated: false
// }

function getWeight(sliderValue, playlist) {

    if(sliderValue <= 0) return 0

    const divisions = multipliers.length;
    const divisionSize = 100 / divisions; // ~14.285
    let division = Math.floor((sliderValue - 1) / divisionSize); // subtract 1 to avoid 0 snapping
    if (division >= divisions) division = divisions - 1;

    console.log(`value: ${sliderValue} division: ${division} multiplier: ${multipliers[division]}`)
    return multipliers[division];
}

//DELETED THESE
//loadAppState()
//setSelectionMode(selectionMode)

//renderMixSelector()
//renderPlaylists() //called in setSelectionMode initial above



// Define your sequential execution tracking grid mapping text slugs to Spotify playlist targets
const stationNetwork = [
    { id: "KBZN",                   playlistId: "5IJKK7NDMB0RauocZUd1jp" }, // * 97.9 FM - Now 97.9 KBZN
    { id: "7346_48k",               playlistId: "3HPDlPwGtZi5bxBYOGLEWd" }, // * X96
    { id: "7164_48k",               playlistId: "7nMQh4vmn567gapArxDiLQ" }, // * BOB FM
    //{ id: "7155_48k",             playlistId: "3ZrUs8aPnGwj0XohRQpcvh" }, // The Mix
    { id: "7169_48k",               playlistId: "5oe5s6xIGEITr0YHzlc0Ey" }, // * Hank FM
    { id: "7923_96k",               playlistId: "6fGCdcJZDyahG2OTSUJrvo" }, // * KCUA 92.5 Jack FM - Adult Hits and Rock - Playing what we want
    { id: "a24346",                 playlistId: "3JxHp5IPpxLqSV1fuGuuji" }, // * KCUT 102.9 Moab Rocks
    { id: "KJMY",                   playlistId: "3TgPFiTu70rAKTpO9Ve0ie" }, // * KJMY My 99.5 - Utah's Variety From The 90s To Today
    { id: "KSOP",                   playlistId: "7srykcAmGSnU35lJ3LMyVQ" }, // * KSOP 104.3 Country
    { id: "KODJ",                   playlistId: "1Ly0OjovU7Eqo9zTKpeBXg" }, // * KODJ 94.1 Classic Hits & Classic Rock
    { id: "WDJO",                   playlistId: "3DfAWT6iCcTBYUDu0ai5qq" }, // * WDJO - Oldies - 1480, 99.5 & 107.9 Cincinnati's Oldies Network
    { id: "BUZZ",                   playlistId: "16bDFbNspDZfzAJ0nRGC9a" }, // * The Buzz 94.9 - Rock
    { id: "KZHT",                   playlistId: "2oSr3X6I2yDpgP01GCWDvI" }, // * 97.1 ZHT KZHT - Utah's #1 Hit Music Station - Top 40
    { id: "KAAZ",                   playlistId: "5Jfll0b1dD9f2gkawiQiHA" }, // * Rock 106.7 KAAZ - Anything That Rocks!
    { id: "KBEE",                   playlistId: "4ibUu6VybTigEEnrVwp8aD" }, // * B98.7 KBEE - Today's Hits and Yesterday's Favorites
    { id: "KENZ",                   playlistId: "7tqPljSsVmh2q3SQM6PoKW" }, // * KENZ 94.9 Provo - Utah's New Hit Music - Top 40
    { id: "IHEARTCOUNTRY",          playlistId: "1Wu9NMHonCDjCPg8rnZubn" }, // iHeartCountry IHEARTCOUNTRY - New Country
    { id: "IHEARTCOUNTRYFAVORITES", playlistId: "49rXaAf8N3X5sZPDjUMEcq" }, // iHeart Country Favorites IHEARTCOUNTRYFAVORITES - 90s to Now Country
    { id: "IHEARTCOUNTRYCLASSICS",  playlistId: "4ElxODcIOgtRMnkCUxL86z" }, // iHeart Country Classics IHEARTCOUNTRYCLASSICS - Classic Country - but not old country it seems
    { id: "IHEARTCOUNTRY70S",       playlistId: "0ard1KtZpdSV17hJhJWAJU" }, // iHeart Country 70s IHEARTCOUNTRY70S - 70s Country Hits
    { id: "IHEARTBLUEGRASS",        playlistId: "6BpQD1kaOaHx4UjPndIZ2E" }, // iHeartBluegrass IHEARTBLUEGRASS - Bluegrass Hits
    { id: "IHEARTALTRADIO",         playlistId: "3zvKhEkgsC3LtpbmFbUFsk" }, // iHeart Alt Radio IHEARTALTRADIO - Alternative Hits
    { id: "IHEARTALTTOP20",         playlistId: "5ofb8Je1Dq2QOrujQAbbR5" }, // iHeart Alt Top 20 IHEARTALTTOP20 - This Week's Top 20
    { id: "IHEARTSMELLS90S",        playlistId: "6FTYdIosZcWlc8GvyZdBkc" }, // iHeart Smells Like the 90s IHEARTSMELLS90S - 90s Alt Hits
    { id: "IHEARTALTX",             playlistId: "25WaK2bS1PA7EGKHMChym8" }, // iHeart AltX IHEARTALTX - 90s/00s ALT Hits
    { id: "IHEARTALT2K",            playlistId: "4gtzLuP3O7jZEut5wZ20Aw" }, // iHeart Alt2K IHEARTALT2K - 2000s ALT Hits
    { id: "IHEARTFREEFORM",         playlistId: "6p88rMY6c6ZPA4pji9Amiw" }, // iHeart Freeform Radio IHEARTFREEFORM - ALT Mix for Music Fans
    { id: "IHEARTROCKNATION",       playlistId: "1HaAXTc4L50VwKhl5Dbij7" }, // iHeart Rock Nation IHEARTROCKNATION - America's Rock Station
    { id: "IHEARTROCKTOP20",        playlistId: "57KRM39ijC6P04O5LmVrLO" }, // iHeart Rock Top 20 IHEARTROCKTOP20 - This Week's Top 20
    { id: "IHEARTPOPHITS",          playlistId: "43BM0F3ZuyOCVyKih5yu4e" }, // iHeart Pop Hits IHEARTPOPHITS - New Hit Music
    { id: "IHEARTSTAR1013",         playlistId: "7lKNq4Cq0Gf0tItuME3mhr" }, // iHeart Star 101.3 IHEARTSTAR1013 - 2000's, 90's & Today!
    { id: "IHEARTSTAR1057",         playlistId: "52Mo8OnP4TH09kdpyGnt6m" }, // iHeart Star 105.7 Grand Rapids' 80s to Now IHEARTSTAR1057
    { id: "IHEARTSTARMIX1007",      playlistId: "3bAjfNMfzDjmbc92kmGHO9" }, // iHeart Star Mix 100.7 Tampa IHEARTSTARMIX1007
    { id: "IHEARTSTARMIX945",       playlistId: "5cdRpz8szVx8wzCziYXMuP" }, // iHeart Star Mix 94.5 Lexington's 80s, 90s & Today IHEARTSTARMIX945
    { id: "IHEARTCOALTERNATIVE",    playlistId: "5gbWKQNTq7W7X9FihHU2Q2" }, // iHeart Colorado Adult Alternative 93.3 IHEARTCOALTERNATIVE
    { id: "IHEARTCHRISTMAS",        playlistId: "7rQyR8AupwZyuDXOxjbZnz" }, // iHeart Christmas IHEARTCHRISTMAS - Christmas Hits
    { id: "IHEARTHOLIDAYSAEASON",   playlistId: "7aNbpTzV6zFptJefnkwZIi" }, // iHeart Holiday Season IHEARTHOLIDAYSAEASON - Holiday Mix
    { id: "IHEARTCOUNTRYCHRISTMAS", playlistId: "1cy95KhxhmTu5rpQDHX3A8" }, // iHeart Country Christmas IHEARTCOUNTRYCHRISTMAS - Country Christmas Hits
    { id: "IHEARTCHRISTMASROCK",    playlistId: "22Zr2jSdug6B8QDQmSYnZz" }, // iHeart Christmas Rock IHEARTCHRISTMASROCK - Rockin' Christmas
    { id: "IHEARTSACREDCHRISTMAS",  playlistId: "56P0hPs9s2XiFvkGWY6YkH" }, // iHeart Sacred Christmas IHEARTSACREDCHRISTMAS - Traditional Carols
    { id: "IHEARTKLOVECHRISTMAS",   playlistId: "28I3JtaHVe6Ibrkm149dJR" }, // iHeart K-Love Christmas IHEARTKLOVECHRISTMAS - Positive, Encouraging Christmas
    { id: "IHEARTCHRISTMASPOP",     playlistId: "0MR5NLDKA1XTR3MCqG7n8l" }, // iHeart Christmas Pop IHEARTCHRISTMASPOP - Holiday Pop Hits
    { id: "KBLQ",                   playlistId: "757OVZ8V0JdzE8eA05qaLa" }, // * KBLQ Q92
    { id: "KLGN",                   playlistId: "40rg8M41WvZ4OD3SIqxvTz" }, // KLGN 103.3 Lite FM - Yesterday's Lite Hits
    { id: "KCLS",                   playlistId: "4sIUUZpT7DjhZolusj5dom" }, // KCLS 101.5 Sunny 101.5 - The Greatest Hits of the 70’s, 80’s, and 90’s
    { id: "KKEX",                   playlistId: "5MAmtTO9pE9DpOC1YwN45C" }, // * Kix 96 KKEX Country
    { id: "KKEX3",                  playlistId: "7cnOzxNR0bwi531jE1SjA4" }, // * KKEX3 104.5 The Ranch
    { id: "KGNT",                   playlistId: "2EIK73lP43RH5LbO4XUh4I" }, // * KOOL 103.9 KGNT  Your Greatest Hits
    { id: "KLZX",                   playlistId: "5qoWmLVvZyMcHXEpkxDWT2" }, // * 95.0 KLZX Classic Rock
    { id: "KVFX",                   playlistId: "7iyYX42dtmd82tuMIIetlL" }, // * 94.5 KVFX VFX Top 40
    { id: "KRQX",                   playlistId: "2qOxntF5tFR5UlXIk79FRp" }, // KRQX KOOL 98.9 Classic Hits
    { id: "KBERFM",                 playlistId: "0zMyia0KzbLTi0pEse7i0c" }, // * KBER 101
    { id: "KUBLFMAAC",              playlistId: "2nDRY8T9SruY4U0Dy4OkTS" }, // * KUBL - KBULL 93 The Bull Country
    { id: "XM_octane",              playlistId: "0p50gUG6ST0n37PYtEjEq6" }, // * XM Octane Ch. 37 - Hard Rock 
    { id: "XM_bluegrassjunction",   playlistId: "0yDtWHSgoMeqicg3ZDubf3" }, // * XM Bluegrass Junction  Ch. 77
    { id: "XM_thepulse",            playlistId: "3dGDQkqGftK9CrXeMmxtIE" }, // * XM The Pulse Ch. 5 - Today's pop
    { id: "XM_siriusxmhits1",       playlistId: "27yiTJGKwlRaXHBrV35TeE" }, // * XM SiriusXM Hits 1 Ch. 2 - pop - Today's hits
    { id: "XM_poprocks",            playlistId: "1kIlP87uYebdUWici4BDon" }, // * XM PopRocks Ch. 6 - pop - The greatest pop/rock anthems from the 90s and 2000s
    { id: "XM_thebridge",           playlistId: "1gOsdinyLpSjNGCdwqsnvC" }, // * XM The Bridge Ch. 14 - Cross the bridge to the mellow side of classic rock and 70s folk rock.
    { id: "XM_theblend",            playlistId: "2yBlKOrxYIkY7UUqTObxI9" }, // * XM The Blend Ch. 16 - Blending nice & easy pop
    { id: "XM_alt2k",               playlistId: "7xF8OvyRYxWu4U0AZc975f" }, // * XM Alt2K Ch. 27 - Alt Rock
    { id: "XM_1stwave",             playlistId: "5U6gy40PLZaBLoy2IHvlQq" }, // * XM 1st Wave Ch. 33 - Alt Rock - The First Wave of alternative music
    { id: "XM_lithium",             playlistId: "75jLeew4WERen7gpuFe6nn" }, // * XM Lithium Ch. 34 90s Rock - 90s alternative & grunge rock
    { id: "XM_kidzbopradio",        playlistId: "53xrNLm1O5r8Th417Gy9Yq" }, // * XM KIDZ BOP Radio Ch. 135 - kids
    { id: "XM_altnation",           playlistId: "2815SuqCB3fUK18yiiOhzy" }, // * XM Alt Nation Ch. 36 - Modern Alternative
    { id: "XM_siriusxmturbo",       playlistId: "5m0nEzUNccNny2fBuSNIql" }, // * XM Turbo Ch. 41 - 90s and 2000s Hard Rock
    { id: "XM_thespectrum",         playlistId: "4zSWjbhuXi0ftS3UfOS8q4" }, // XM The Spectrum Ch. 28 - The Spectrum of Rock, spanning more than six decades
    { id: "XM_thehighway",          playlistId: "5WqhR1StD0Vgem8C5irJBP" }, // * XM The Highway Ch. 56 - New Country
    { id: "XM_y2kountry",           playlistId: "258caFaEZgidIIkvWD483x" }, // * XM Y2Kountry Ch. 57 - 2000s Country
    { id: "XM_primecountry",        playlistId: "1iOdWIsvlM5eqV5i0M8CoH" }, // * XM Prime Country Ch. 58 - 80s 90s Country
    { id: "XM_disneyhits",          playlistId: "2RY27XjagmNRt6prVhYCtp" }, // * XM Disney Hits Ch. 133
    { id: "XM_greendaysidiotnation",playlistId: "0ARuyKZekSZXbGsksxn5sU" }, // * XM Green Day's Idiot Nation Ch. 314 - Punk Rock
    { id: "XM_williesroadhouse",    playlistId: "0tVP4r4DJjQYK2Hqlz3sSr" }, // * XM Willie's Roadhouse Ch. 61 - Classic Country
    { id: "XM_classicrewind",       playlistId: "7g1nHljfI6pntWQ1waW6YX" }, // * XM Classic Rewind Ch. 25 - Classic Rock
    { id: "XM_ozzysboneyard",       playlistId: "2FWAPY5HEguJPFGFOhrd30" }, // * XM Ozzy's Boneyard Ch. 38 - Heavy Classic Rock
    { id: "XM_hairnation",          playlistId: "64OtGKw7LPSzfGJyYtvT6Y" }, // * XM XM Hair Nation Ch. 39 - Classic Rock
    { id: "XM_redwhitebooze",       playlistId: "4JdLLCLUOyj39fUCRwMqdl" }, // * XM Red White & Booze Ch. 350 - Country & Rock - Country/Rock-themed bars and honky tonks
    { id: "XM_holidaytraditions",   playlistId: "6QdbwKDkjBaqHTAWWAp6cc" }, // * XM Holiday Traditions Ch. 602 - Sing-along holiday favorites
];

//This will round down to the nearest whole integer
let currentStationNetworkAllowed = Math.floor(Math.random() * stationNetwork.length);
currentStationNetworkAllowed = 1 //used for Spotify Search
// Used for downloading actual playlist history - used to be tied to currentStationNetworkAllowed for 
// spotify search, it is no longer
let beginningStationNetworkAllowed = Math.floor(Math.random() * stationNetwork.length); //Used for downloading actual playlist history
let deDuplicateStationAllowed = Math.floor(Math.random() * stationNetwork.length); //used for playlist deduplication
let currentRadioPlaylistUpdateAllowed = 0; // used for pushing URIs to playlist
    currentRadioPlaylistUpdateAllowed = currentRadioPlaylistUpdateAllowed = Math.floor(Math.random() * stationNetwork.length);

let lastSyncTime = 0
let lastPollTime = 0
let lastPollStartTime = 0

let spotifyRadioSleepTime = 2 //min
// --- MASTER TRACKING CONFIGURATION ---
const REQ_COOLDOWN_MS = 3.5 * 60 * 60 * 1000; // Hard 3-hour cooldown
const GLOBAL_SEARCH_CAP = 50;              // Global session search limit
let globalSearchesPerformed = 0;             // Shared counter across all stations

async function beginSyncAllRadiosToSpotify(){
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            // 2. ✅ Run the startup pull-and-merge sequence instantly!
            await pullAndMergeCaches(currentSpotifyUser);
            
            // 3. ✅ Activate the 15-minute background backup checker wheel
            initializeAutomaticCloudBackupLoop(currentSpotifyUser);

    syncRadioSpotifyRateLimit = false
    totalSpotifyRateLimit = false

    //spotifyPlaylistDownloadAllowed = false
    setInterval(async () => {
        spotifyPlaylistDownloadAllowed = true //reset by whichever station runs that process
        console.log(`✅ spotifyPlaylistDownloadAllowed.`);
    }, 200 * 60 * 1000); //every 120 min
    setInterval(async () => {
        spotifyPlaylistDownloadSmallAllowed = true //reset by whichever station runs that process
        console.log(`✅ spotifyPlaylistDownloadSmallAllowed.`);
    }, 45 * 60 * 1000); //every 30 min
    
    setInterval(async () => {
        spotifyPlaylistDeDuplicateAllowed = true //reset by whichever station runs that process
        console.log(`✅ Duplicate spotifyPlaylistDeDuplicateAllowed.`);
    }, 120 * 60 * 1000); //every 40 min

    startLiveRadioAccumulator("KBZN", "5IJKK7NDMB0RauocZUd1jp")
    await sleep(1 * 60 * 1000)
    // startLiveRadioAccumulator("KENZ", "7tqPljSsVmh2q3SQM6PoKW")
    // await sleep(1 * 60 * 1000)

    let spotifyRadioInterval = 15 //min
    while(1){
        lastPollStartTime = Date.now()
        console.log("⏰ Session Changes Only Starting scheduled multi-station playlist sync sequence...");
        await syncAllRadiosToSpotify()
        let pollSleepTime = (lastPollStartTime + (spotifyRadioInterval * 60 * 1000)) - Date.now()
        let nextPollTime = new Date(lastPollStartTime + (spotifyRadioInterval * 60 * 1000));
        console.log(`✅ Session Changes Only All stations synced successfully. Next master cycle in ${spotifyRadioInterval} minutes. pollSleepTime: ${(pollSleepTime / 60000).toFixed(1)} ${nextPollTime.toLocaleString()}.`);
        console.log(`lastPollStartTime: ${lastPollStartTime} pollSleepTime: ${(pollSleepTime / 60000).toFixed(1)}`)
        //await sleep(spotifyRadioInterval * 60 * 1000);
        await sleep(pollSleepTime);
    }
}

async function syncAllRadiosToSpotify(){
    // ⏳ Helper utility to pause execution for a set number of milliseconds
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        console.log("⏰ Starting scheduled multi-station playlist sync sequence...");

    currentStationNetworkAllowed = 1 //used for Spotify Search
    //beginningStationNetworkAllowed = currentStationNetworkAllowed
    beginningStationNetworkAllowed = Math.floor(Math.random() * stationNetwork.length);
    deDuplicateStationAllowed = ((beginningStationNetworkAllowed + 30) % stationNetwork.length)
    if(spotifyPlaylistDownloadAllowed) console.log(`✅ spotifyPlaylistDownloadAllowed - ${stationNetwork[beginningStationNetworkAllowed].id}.`);
    if(spotifyPlaylistDownloadSmallAllowed) console.log(`✅ spotifyPlaylistDownloadSmallAllowed - ${stationNetwork[beginningStationNetworkAllowed].id}.`);
    if(spotifyPlaylistDeDuplicateAllowed) console.log(`✅ DeDuplicate spotifyPlaylistDeDuplicateAllowed - ${stationNetwork[beginningStationNetworkAllowed].id}.`);
    //currentRadioPlaylistUpdateAllowed = Math.floor(Math.random() * stationNetwork.length);
    currentRadioPlaylistUpdateAllowed = (currentRadioPlaylistUpdateAllowed + 5) % stationNetwork.length;

    try {

        //globalSongCache = JSON.parse(localStorage.getItem('spotify_global_song_cache')) || {};
        // ✅ Ensure runtime cache has data before starting lookups
        //if (!globalSongCache || Object.keys(globalSongCache).length === 0) {
            globalSongCache = await loadIndexedDbToRuntimeCache();
        //}


        lastSyncTime = parseInt(localStorage.getItem(pacingKey)) || 0;
        // console.log(`lastSyncTime: ${lastSyncTime}`)
        const timeElapsed = Date.now() - lastSyncTime;
        // console.log(`timeElapsed: ${timeElapsed}`)
        // Change 60 to whatever minute interval you want to allow (e.g., 30, 60, 120)
        const requiredWaitTime = REQ_COOLDOWN_MS
        // console.log(`requiredWaitTime: ${requiredWaitTime}`)
        // console.log(`requiredWaitTime - timeElapsed: ${requiredWaitTime - timeElapsed}`)
        spotifySyncMinutesRemaining = (requiredWaitTime - timeElapsed) / 60000
        if(timeElapsed < requiredWaitTime) {
            console.log(`%c ⏳ Spotify Search Gate Locked. Skipping API calls for another ${spotifySyncMinutesRemaining} minutes. Accumulating items in LocalStorage.`, "color: #83621aff;");
            spotifySyncAllowed = false
            spotifySyncAllowedStart = false
        }
        else {
            console.log(`%c 🔓 Spotify Search Gate Open! Proceeding with live track queries...`, "color: #d9ff00ff; background: #005f00;");
            spotifySyncAllowed = true
            spotifySyncAllowedStart = true
            globalSearchesPerformed = 0
            // Update the timestamp only when a full search run is allowed to start
            localStorage.setItem(pacingKey, Date.now().toString());
        }
        if(syncRadioSpotifyRateLimit || !spotifySyncAllowed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }


        await refreshAccessToken()

        let whichStationId = "NONE"
        let whichStationIdIndex = 0 //will increment to 1 - bypassing kbzn

        // 1. X96 Sync
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "3HPDlPwGtZi5bxBYOGLEWd");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // 2. BOB FM Sync
        // 100.7 / 105.5 BOB FM (KYMV): Playing Adult Hits across the Wasatch Front.
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "7nMQh4vmn567gapArxDiLQ");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // // 3. The Mix Sync - Actually this is spiritual/worship
        // await syncRadioToSpotify("7155_48k", "3ZrUs8aPnGwj0XohRQpcvh");
        // console.log("⏸️ Sleeping for 1 minute...");
        // await sleep(spotifyRadioSleepTime * 60 * 1000);

        // //KUDDMix 105.1
        // await syncRadioToSpotify("7168_48k","3ZrUs8aPnGwj0XohRQpcvh"); //KUDDMix 105.1
        // console.log("⏸️ Sleeping for 1 minute...");
        // await sleep(spotifyRadioSleepTime * 60 * 1000);

        // 4. Hank FM Sync
        // 101.5 Hank FM (KNAH) Classic & Modern Country music.
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "5oe5s6xIGEITr0YHzlc0Ey");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // KCUA 92.5 Jack FM - Adult Hits and Rock - Playing what we want
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "6fGCdcJZDyahG2OTSUJrvo");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // KCUT 102.9 Moab Rocks
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "3JxHp5IPpxLqSV1fuGuuji");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // KJMY My 99.5 - Utah's Variety From The 90s To Today
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "3TgPFiTu70rAKTpO9Ve0ie");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // KSOP 104.3 Country
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "7srykcAmGSnU35lJ3LMyVQ");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // KODJ 94.1 Classic Hits & Classic Rock
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "1Ly0OjovU7Eqo9zTKpeBXg");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // WDJO - Oldies - 1480, 99.5 & 107.9 Cincinnati's Oldies Network
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "3DfAWT6iCcTBYUDu0ai5qq");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // The Buzz 94.9 - Rock
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "16bDFbNspDZfzAJ0nRGC9a");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // 97.1 ZHT KZHT - Utah's #1 Hit Music Station - Top 40
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "2oSr3X6I2yDpgP01GCWDvI");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // Rock 106.7 KAAZ - Anything That Rocks!
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "5Jfll0b1dD9f2gkawiQiHA");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // B98.7 KBEE - Today's Hits and Yesterday's Favorites
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "4ibUu6VybTigEEnrVwp8aD");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // KENZ 94.9 Provo - Utah's New Hit Music - Top 40
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "7tqPljSsVmh2q3SQM6PoKW");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeartCountry IHEARTCOUNTRY - New Country
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "1Wu9NMHonCDjCPg8rnZubn");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Country Favorites IHEARTCOUNTRYFAVORITES - 90s to Now Country
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "49rXaAf8N3X5sZPDjUMEcq");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Country Classics IHEARTCOUNTRYCLASSICS - Classic Country - but not old country it seems
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "4ElxODcIOgtRMnkCUxL86z");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Country 70s IHEARTCOUNTRY70S - 70s Country Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "0ard1KtZpdSV17hJhJWAJU");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeartBluegrass IHEARTBLUEGRASS - Bluegrass Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "6BpQD1kaOaHx4UjPndIZ2E");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Alt Radio IHEARTALTRADIO - Alternative Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "3zvKhEkgsC3LtpbmFbUFsk");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Alt Top 20 IHEARTALTTOP20 - This Week's Top 20
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "5ofb8Je1Dq2QOrujQAbbR5");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Smells Like the 90s IHEARTSMELLS90S - 90s Alt Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "6FTYdIosZcWlc8GvyZdBkc");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart AltX IHEARTALTX - 90s/00s ALT Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "25WaK2bS1PA7EGKHMChym8");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Alt2K IHEARTALT2K - 2000s ALT Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "4gtzLuP3O7jZEut5wZ20Aw");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Freeform Radio IHEARTFREEFORM - ALT Mix for Music Fans
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "6p88rMY6c6ZPA4pji9Amiw");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Rock Nation IHEARTROCKNATION - America's Rock Station
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "1HaAXTc4L50VwKhl5Dbij7");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Rock Top 20 IHEARTROCKTOP20 - This Week's Top 20
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "57KRM39ijC6P04O5LmVrLO");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Pop Hits IHEARTPOPHITS - New Hit Music
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "43BM0F3ZuyOCVyKih5yu4e");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Star 101.3 IHEARTSTAR1013 - 2000's, 90's & Today!
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "7lKNq4Cq0Gf0tItuME3mhr");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Star 105.7 Grand Rapids' 80s to Now IHEARTSTAR1057
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "52Mo8OnP4TH09kdpyGnt6m");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Star Mix 100.7 Tampa IHEARTSTARMIX1007
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "3bAjfNMfzDjmbc92kmGHO9");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Star Mix 94.5 Lexington's 80s, 90s & Today IHEARTSTARMIX945
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "5cdRpz8szVx8wzCziYXMuP");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Colorado Adult Alternative 93.3 IHEARTCOALTERNATIVE
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "5gbWKQNTq7W7X9FihHU2Q2");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Christmas IHEARTCHRISTMAS - Christmas Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "7rQyR8AupwZyuDXOxjbZnz");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Holiday Season IHEARTHOLIDAYSAEASON - Holiday Mix
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "7aNbpTzV6zFptJefnkwZIi");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Country Christmas IHEARTCOUNTRYCHRISTMAS - Country Christmas Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "1cy95KhxhmTu5rpQDHX3A8");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Christmas Rock IHEARTCHRISTMASROCK - Rockin' Christmas
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "22Zr2jSdug6B8QDQmSYnZz");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Sacred Christmas IHEARTSACREDCHRISTMAS - Traditional Carols
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "56P0hPs9s2XiFvkGWY6YkH");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart K-Love Christmas IHEARTKLOVECHRISTMAS - Positive, Encouraging Christmas
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "28I3JtaHVe6Ibrkm149dJR");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // iHeart Christmas Pop IHEARTCHRISTMASPOP - Holiday Pop Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncRadioToSpotify(whichStationId, "0MR5NLDKA1XTR3MCqG7n8l");
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // ✅ NEW SEED TRACKING: Sync Q92 cleanly from their Cirrus streaming host
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"757OVZ8V0JdzE8eA05qaLa"); // KBLQ Q92
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // ✅ KLGN 103.3 Lite FM - Yesterday's Lite Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"40rg8M41WvZ4OD3SIqxvTz"); // KLGN 103.3 Lite FM - Yesterday's Lite Hits
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // ✅ KCLS 101.5 Sunny 101.5 - The Greatest Hits of the 70’s, 80’s, and 90’s
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"4sIUUZpT7DjhZolusj5dom"); // KCLS 101.5 Sunny 101.5 - The Greatest Hits of the 70’s, 80’s, and 90’s
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // ✅ Kix 96 KKEX Country
        // streamdb7web + "KKEX": Connects to 94.5 K-EX (KKEX) in Oregon. 
        // They play mainstream Modern Country (Luke Combs, Morgan Wallen, Lainey Wilson).
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"5MAmtTO9pE9DpOC1YwN45C"); // Kix 96 KKEX Country
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // streamdb5web + "KKEX3": Connects to 101.9 HD3 The Ranch (KKEX-HD3) in Utah. 
        // They play Texas/Red Dirt & Classic Country (Cody Jinks, Aaron Watson, George Strait).
        // ✅ KKEX3 104.5 The Ranch - S cleanly from their Cirrus streaming host
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"7cnOzxNR0bwi531jE1SjA4"); // KKEX3 104.5 The Ranch
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // KOOL 103.9 KGNT  Your Greatest Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"2EIK73lP43RH5LbO4XUh4I"); // KOOL 103.9 KGNT  Your Greatest Hits
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // 95.0 KLZX Classic Rock
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"5qoWmLVvZyMcHXEpkxDWT2"); // 95.0 KLZX Classic Rock
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // 94.5 KVFX VFX Top 40
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"7iyYX42dtmd82tuMIIetlL"); // 94.5 KVFX VFX Top 40
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // KRQX KOOL 98.9 Classic Hits
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBLQToSpotify(whichStationId,"2qOxntF5tFR5UlXIk79FRp"); // 94.5 KVFX VFX Top 40
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        //KBER 101
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBERToSpotify(whichStationId,"0zMyia0KzbLTi0pEse7i0c") // KBER 101
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        //KBUL 93
        whichStationId = stationNetwork[(++whichStationIdIndex) % stationNetwork.length].id
        await syncKBERToSpotify(whichStationId,"2nDRY8T9SruY4U0Dy4OkTS") // KUBL - KBULL 93 The Bull Country
        console.log("⏸️ Sleeping for 1 minute...");
        //if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        if(!spotifySearchPeformed){
            spotifyRadioSleepTime = 0
        }
        else{
            spotifyRadioSleepTime = 2
        }
        //await sleep(spotifyRadioSleepTime * 60 * 1000);

        // // 97.9 FM - Now 97.9 KBZN
        // await syncKBERToSpotify("2283_96", "5IJKK7NDMB0RauocZUd1jp");
        // console.log("⏸️ Sleeping for 1 minute...");
        // if((stationNetwork[currentStationNetworkAllowed].id !== whichStationId && stationNetwork[(currentStationNetworkAllowed -1 + stationNetwork.length) % stationNetwork.length].id !== whichStationId) || syncRadioSpotifyRateLimit || !spotifySyncAllowed){
        //     spotifyRadioSleepTime = 0
        // }
        // else{
        //     spotifyRadioSleepTime = 2
        // }
        // await sleep(spotifyRadioSleepTime * 60 * 1000);

        await syncXMstationsToSpotify()

        // // ✅ NEW IHEART LIVE TRACKER ACCUMULATOR
        // await gatherIHeartStationTrack("KAAZ-FM", "Rock1067"); 

        // // await syncRadioToSpotify("7170_48k","2nDRY8T9SruY4U0Dy4OkTS"); //KUUU U92 Hip Hop
        // //         console.log("⏸️ Sleeping for 1 minute...");
        // //         //await sleep(2 * 60 * 1000);
        // nope

        if(spotifySyncAllowedStart){
            localStorage.setItem(pacingKey, Date.now().toString());
            lastSyncTime = Date.now()
        }

        // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
        // Save the updated object map right after this station finishes its loop logic pass
        // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
        // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
        // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
        await flushRuntimeCacheToIndexedDb(globalSongCache);

        console.log("✅ All stations synced successfully. Next master cycle in 10 minutes.");
    } catch (error) {
        console.error("⚠️ Scheduled loop encountered an error:", error);
    }
    lastPollTime = Date.now()
}
async function syncXMstationsToSpotify(){
            // XM Octane Ch. 37 - Hard Rock 
            await syncRadioToSpotify("XM_octane", "0p50gUG6ST0n37PYtEjEq6") // XM Octane Ch. 37 - Hard Rock 

            // XM Bluegrass Junction  Ch. 77
            await syncRadioToSpotify("XM_bluegrassjunction", "0yDtWHSgoMeqicg3ZDubf3") // XM Bluegrass Junction  Ch. 77

            // XM The Pulse Ch. 5 - Today's pop
            await syncRadioToSpotify("XM_thepulse", "3dGDQkqGftK9CrXeMmxtIE") // XM The Pulse Ch. 5 - Today's pop

            // XM SiriusXM Hits 1 Ch. 2 - pop - Today's hits
            await syncRadioToSpotify("XM_siriusxmhits1", "27yiTJGKwlRaXHBrV35TeE") // XM SiriusXM Hits 1 Ch. 2 - pop - Today's hits

            // XM PopRocks Ch. 6 - pop - The greatest pop/rock anthems from the 90s and 2000s
            await syncRadioToSpotify("XM_poprocks", "1kIlP87uYebdUWici4BDon") // XM PopRocks Ch. 6 - pop - The greatest pop/rock anthems from the 90s and 2000s

            // XM The Bridge Ch. 14 - Cross the bridge to the mellow side of classic rock and 70s folk rock.
            await syncRadioToSpotify("XM_thebridge", "1gOsdinyLpSjNGCdwqsnvC") // XM The Bridge Ch. 14 - Cross the bridge to the mellow side of classic rock and 70s folk rock.XXM PopRocks Ch. 6 - pop - The greatest pop/rock anthems from the 90s and 2000s

            // XM The Blend Ch. 16 - Blending nice & easy pop
            await syncRadioToSpotify("XM_theblend", "2yBlKOrxYIkY7UUqTObxI9") // XM The Blend Ch. 16 - Blending nice & easy pop

            // XM Alt2K Ch. 27 - Alt Rock
            await syncRadioToSpotify("XM_alt2k", "7xF8OvyRYxWu4U0AZc975f") // XM Alt2K Ch. 27 - Alt Rock

            // XM 1st Wave Ch. 33 - Alt Rock - The First Wave of alternative music
            await syncRadioToSpotify("XM_1stwave", "5U6gy40PLZaBLoy2IHvlQq") // XM 1st Wave Ch. 33 - Alt Rock - The First Wave of alternative music

            // XM Lithium Ch. 34 90s Rock - 90s alternative & grunge rock
            await syncRadioToSpotify("XM_lithium", "75jLeew4WERen7gpuFe6nn") // XM Lithium Ch. 34 90s Rock - 90s alternative & grunge rock

            // XM KIDZ BOP Radio Ch. 135 - kids
            await syncRadioToSpotify("XM_kidzbopradio", "53xrNLm1O5r8Th417Gy9Yq") // XM KIDZ BOP Radio Ch. 135 - kids

            // XM Alt Nation Ch. 36 - Modern Alternative
            await syncRadioToSpotify("XM_altnation", "2815SuqCB3fUK18yiiOhzy") // XM Alt Nation Ch. 36 - Modern Alternative

            // XM Turbo Ch. 41 - 90s and 2000s Hard Rock
            await syncRadioToSpotify("XM_siriusxmturbo", "5m0nEzUNccNny2fBuSNIql") // XM Turbo Ch. 41 - 90s and 2000s Hard Rock

            // XM The Spectrum Ch. 28 - The Spectrum of Rock, spanning more than six decades
            await syncRadioToSpotify("XM_thespectrum", "4zSWjbhuXi0ftS3UfOS8q4") // XM The Spectrum Ch. 28 - The Spectrum of Rock, spanning more than six decades

            // XM The Highway Ch. 56 - New Country
            await syncRadioToSpotify("XM_thehighway", "5WqhR1StD0Vgem8C5irJBP") // XM The Highway Ch. 56 - New Country

            // XM Y2Kountry Ch. 57 - 2000s Country
            await syncRadioToSpotify("XM_y2kountry", "258caFaEZgidIIkvWD483x") // XM Y2Kountry Ch. 57 - 2000s Country

            // XM Prime Country Ch. 58 - 80s 90s Country
            await syncRadioToSpotify("XM_primecountry", "1iOdWIsvlM5eqV5i0M8CoH") // XM Prime Country Ch. 58 - 80s 90s Country

            // XM Disney Hits Ch. 133
            await syncRadioToSpotify("XM_disneyhits", "2RY27XjagmNRt6prVhYCtp") // XM Disney Hits Ch. 133

            // XM Green Day's Idiot Nation Ch. 314 - Punk Rock
            await syncRadioToSpotify("XM_greendaysidiotnation", "0ARuyKZekSZXbGsksxn5sU") // XM Green Day's Idiot Nation Ch. 314 - Punk Rock

            // XM Willie's Roadhouse Ch. 61 - Classic Country
            await syncRadioToSpotify("XM_williesroadhouse", "0tVP4r4DJjQYK2Hqlz3sSr") // XM Willie's Roadhouse Ch. 61 - Classic Country

            // XM Classic Rewind Ch. 25 - Classic Rock
            await syncRadioToSpotify("XM_classicrewind", "7g1nHljfI6pntWQ1waW6YX") // XM Classic Rewind Ch. 25 - Classic Rock

            // XM Ozzy's Boneyard Ch. 38 - Heavy Classic Rock
            await syncRadioToSpotify("XM_ozzysboneyard", "2FWAPY5HEguJPFGFOhrd30") // XM Ozzy's Boneyard Ch. 38 - Heavy Classic Rock

            // XM Hair Nation Ch. 39 - Classic Rock
            await syncRadioToSpotify("XM_hairnation", "64OtGKw7LPSzfGJyYtvT6Y") // XM Hair Nation Ch. 39 - Classic Rock

            // XM Red White & Booze Ch. 350 - Country & Rock - Country/Rock-themed bars and honky tonks
            await syncRadioToSpotify("XM_redwhitebooze", "4JdLLCLUOyj39fUCRwMqdl") // XM Red White & Booze Ch. 350 - Country & Rock - Country/Rock-themed bars and honky tonks

            // XM Holiday Traditions Ch. 602 - Sing-along holiday favorites
            await syncRadioToSpotify("XM_holidaytraditions", "6QdbwKDkjBaqHTAWWAp6cc") // XM Holiday Traditions Ch. 602 - Sing-along holiday favorites
}

/**
 * Fetches KXRK history from StreamOn and updates a specified Spotify playlist.
 * @param {string} accessToken - Your active Spotify Web API access token.
 * @param {string} playlistId - The target Spotify Playlist ID.
 */
let syncRadioSpotifyRateLimit = false
let totalSpotifyRateLimit = false
// Session-level cache for searches (Cleared on page refresh)
let globalSongCache = {}
let pendingCloudCacheUploads = {}
//let globalSongCache = JSON.parse(localStorage.getItem('spotify_global_song_cache')) || {};
//globalSongCache = JSON.parse(localStorage.getItem('spotify_global_song_cache')) || {};
// ✅ Ensure runtime cache has data before starting lookups
//if (!globalSongCache || Object.keys(globalSongCache).length === 0) {
// globalSongCache = await loadIndexedDbToRuntimeCache();
//}

// ⏱️ TIMEOUT GATE: Check if 1 hour (3600000 ms) has passed since the last Spotify search
const pacingKey = `last_spotify_sync_time`;
let spotifySyncAllowed = true;
let spotifySyncAllowedStart = true
let spotifySearchPeformed = false
let spotifyPlaylistDownloadAllowed = false
let spotifyPlaylistDownloadSmallAllowed = false
let spotifyPlaylistDeDuplicateAllowed = true
let spotifySyncInProgress = false;
let spotifySyncMinutesRemaining = 0
async function syncRadioToSpotify(stationID= 9999, playlistId = 9999, sequenceNumber = 196158) {

    const token = localStorage.getItem('access_token');

    console.log(`%cFetching live history from StreamOn folder: ${stationID}...`, "color: #13c703; background: #000000;");

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // --- STEP 0: Load Pending Tracks from LocalStorage ---
    let pendingStorageKey = `pending_tracks_${stationID}`;
    const mirrorKey = `playlist_mirror_${stationID}`;


    // 🚨 CONDITION A: Global cap reached or gate is locked -> Defer immediately
    if(syncRadioSpotifyRateLimit || !spotifySyncAllowed || (stationNetwork[currentStationNetworkAllowed].id !== stationID) || globalSearchesPerformed >= GLOBAL_SEARCH_CAP ){
        if (globalSearchesPerformed >= GLOBAL_SEARCH_CAP) {
            console.warn(`🛑 Global Session Cap of ${GLOBAL_SEARCH_CAP} reached mid-run! Deferring remaining tracks.`);
        }
        if(stationNetwork[currentStationNetworkAllowed].id !== stationID){
            console.log(`Current station ${stationID} not granted Spotify Search Gate`)
            console.log(`stationNetwork[currentStationNetworkAllowed].id: ${stationNetwork[currentStationNetworkAllowed].id}`)
            //console.log(`currentStationNetworkAllowed: ${currentStationNetworkAllowed}`)
            //console.log(`currentStationNetworkAllowed: ${currentStationNetworkAllowed}`)
        }
    }



    // Example: Sync everything played on X96 exactly 1 hour ago
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const oneHourAgo = nowInSeconds - 3600;

    let startTimestamp = oneHourAgo
    let endTimestamp = nowInSeconds

    // 🛡️ Guard rail: Validate Futuri's strict 3600-second (1 hour) constraint
    const duration = endTimestamp - startTimestamp;
    if (duration > 3600) {
        console.warn("⚠️ StreamOn duration limited to 3600 seconds. Truncating range to 1 hour from start.");
        endTimestamp = startTimestamp + 3600;
    }
    if (duration <= 0) {
        console.error("❌ Invalid time range: End timestamp must be greater than start timestamp.");
        return;
    }
    console.log(`⏰ Fetching range block: ${startTimestamp} to ${endTimestamp} (${Math.round(duration/60)} mins)`);
    
    // const streamOnUrl = "https://corsproxy.io/?url=https://cdnstream1.com/metadata/7346_48k/last/10.json";
    // const streamOnUrl = "https://allorigins.win/?url=https://cdnstream1.com/metadata/7346_48k/last/10.json";
    // const streamOnUrl = "https://api.allorigins.win/get?url=https://cdnstream1.com/metadata/7346_48k/last/10.json";
    const streamOnUrl = `https://api.allorigins.win/get?url=http%3A%2F%2Fyp.cdnstream1.com%2Fmetadata%2F${stationID}%2Flast%2F10.json`;
    // 1. Setup primary proxy and high-speed backup proxy paths
    //const targetUrl = `https://yp.cdnstream1.com/metadata/${stationID}/last/10.json`;
    
    
    //const targetUrl = `https://yp.cdnstream1.com/metadata/${stationID}/range/${startTimestamp}-${endTimestamp}.json`;

    let targetUrl = "";

    // ✅ NEW SECTOR ROUTER: Dynamically maps the Aiir Network for KSOP
    if (stationID === "wjfesic70c6uv" || stationID === "KSOPBAD") {
        const cleanID = "ksop"; 
        //targetUrl = `https://metadata.aiir.com/${cleanID}/history.json`;
        //targetUrl = "https://" + "public.aiir.net" + "/playlist/" + "ksop" + "?cb=" + Date.now();
        //targetUrl = "https://" + "embed.aiir.net" + "/playlist" + "?stationId=220&cb=" + Date.now();
        //targetUrl = "https://" + "api.aiir.net" + "/v1/playlist" + "?station=ksop&limit=10&cb=" + Date.now();
        //targetUrl = "https://" + "public.aiir.net" + "/v2/playlist/" + "470" + "?cb=" + Date.now();
        //targetUrl = "https://" + "live.mystreamplayer.com" + "/streamdata.php" + "?h=ais-sa3.cdnstream1.com&p=5130&i=autodj&https=0&f=ice"
        //targetUrl = "https://" + "public.aiir.net" + "/v2/playlist/" + "wjfesic70c6uv" + "?cb=" + Date.now();
        //targetUrl = "https://" + "nowplaying.aiir.com" + "/stream/" + "wjfesic70c6uv" + "?cb=" + Date.now();
        //targetUrl = "https://" + "stream.aiir.com" + "/7.html" + "?stream=wjfesic70c6uv&cb=" + Date.now();
        //targetUrl = "https://" + "aiircdn.com" + "/stream/" + "wjfesic70c6uv" + "/metadata.json?cb=" + Date.now();
        //targetUrl = "https://" + "stream-01.aiir.com" + "/status-json.xsl" + "?mount=/stream/" + "wjfesic70c6uv"
        //targetUrl = "https://" + "stream-01" + ".aiir.com" + "/" + "wjfesic70c6uv" + "/nextplaying.json" + "?cb=" + Date.now();
        targetUrl = "https://" + "stream-01" + ".aiir.com" + "/" + "wjfesic70c6uv" + "/playlist.json" + "?cb=" + Date.now();
    }
    // ✅ NEW SECTOR ROUTER: Direct connection to the open XM Playlist Archive
    else if (stationID.startsWith("XM_")) {
        // Strip out the "XM_" prefix to get the clean channel slug (e.g., "octane", "lithium")
        const channelSlug = stationID.replace("XM_", "").toLowerCase().trim();
        
        // This endpoint returns a clean historical array of the most recent tracks!
        targetUrl = `https://xmplaylist-mirror.deno.dev/api/station/${channelSlug}`;
        // // ✅ NEW BACK-END PATHWAY: 100% open mirror file feed that completely bypasses Cloudflare security blocks!
        // targetUrl = `https://raw.githubusercontent.com/siriusxm-playlists/archive/main/channels/${channelSlug}.json`;    
        // ✅ CORRECTED: Wide-open public endpoint mirror that bypasses Cloudflare security layers completely!
        //targetUrl = `https://xmplaylist-api.curt.workers.dev/station/${channelSlug}`;
    }
    else if (stationID === "KBZN") {
        // ✅ NEW SECTOR: Point KBZN to the dynamic server data endpoint you captured!
        targetUrl = `https://live.mystreamplayer.com/streamdata.php?h=janus.cdnstream.com&p=5143&i=autodj&https=0&f=ice`;
        //targetUrl = `https://yp.cdnstream1.com/metadata/2283_96/last/10.json`;
        //targetUrl = "https://" + "streamdb8web" + ".securenetsystems.net" + "/player_status_update/" + "196158" + ".xml";
        //targetUrl = "https://" + "streamdb6web" + ".securenetsystems.net" + "/player_status_update/" + "KBZNFM" + "_history.xml";
        //targetUrl = `https://live.mystreamplayer.com/config/2283_96.json`;
    }
    else if (stationID === "a24346") {
        targetUrl = "https://" + "api.live365.com" + "/station/" + stationID;
    }
    else if(stationID === "KCINFM"){
        //targetUrl = "https://" + "v7.player" + ".townsquaremedia.com" + "/api/v1/nowplaying/" + stationID.toLowerCase();
        // Points directly to Townsquare's dedicated, unblocked player API domain
        targetUrl = "https://" + "tsm-player-api" + ".com" + "/api/v1/nowplaying/" + stationID.toLowerCase();    }
    // else if (stationID === "KENZ") {
    //     // Direct, unblocked JSON tracker payload from OnlineRadioBox cache
    //     targetUrl = "https://" + "scraper2" + ".onlineradiobox.com" + "/us." + stationID.toLowerCase();
    // }
    // else if (stationID === "KAAZ") {
    //     // Direct, unblocked JSON tracker payload from OnlineRadioBox cache
    //     targetUrl = "https://" + "scraper2" + ".onlineradiobox.com" + "/us." + stationID.toLowerCase();
    // }
    else if(stationID === "KJMY"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 2385 + "/trackHistory?limit=100";
    }
    else if(stationID === "KODJ"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 2393 + "/trackHistory?limit=100";
    }
    else if(stationID === "WDJO"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 9733 + "/trackHistory?limit=100";
    }
    else if(stationID === "BUZZ"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 2281 + "/trackHistory?limit=100";
    }
    else if(stationID === "KZHT"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 2405 + "/trackHistory?limit=100";
    }
    else if(stationID === "KAAZ"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 2397 + "/trackHistory?limit=100";
    }
    else if(stationID === "KBEE"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 5337 + "/trackHistory?limit=100";
    }
    else if(stationID === "KENZ"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 5395 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCOUNTRY"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 4418 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCOUNTRYFAVORITES"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 8625 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCOUNTRYCLASSICS"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 4435 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCOUNTRY70S"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 10764 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTBLUEGRASS"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 6892 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTALTRADIO"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 4447 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTALTTOP20"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 9759 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTSMELLS90S"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 6437 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTALTX"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 10098 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTALT2K"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 7727 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTFREEFORM"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 9719 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTROCKNATION"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 4443 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTROCKTOP20"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 4932 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTPOPHITS"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 8830 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTSTAR1013"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 281 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTSTAR1057"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 1169 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTSTARMIX1007"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 689 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTSTARMIX945"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 3552 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCOALTERNATIVE"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 397 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCHRISTMAS"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 4596 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTHOLIDAYSAEASON"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 9608 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCOUNTRYCHRISTMAS"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 4601 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCHRISTMASROCK"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 6410 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTSACREDCHRISTMAS"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 6410 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTKLOVECHRISTMAS"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 8551 + "/trackHistory?limit=100";
    }
    else if(stationID === "IHEARTCHRISTMASPOP"){
        targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + 10050 + "/trackHistory?limit=100";
    }
    else if(stationID === "KSOP"){
        targetUrl = "https://" + "api.ldrhub.com" + "/2/?key=KSOP&method=Station.Engage.NowPlaying";
    }
    else if (stationID === "CFMP") {
        // Direct, unblocked HTTPS aggregator endpoint tracking Oldies 107.7
        //targetUrl = "https://" + "api.radio.de" + "/stations/now-playing?stationIds=" + "cfmp-oldies-1077";
        targetUrl = "https://" + "publicapi" + ".streamb.live" + "/nowplaying/" + "SB00307";
    }
    else {
        // Default StreamOn format rule
        targetUrl = `https://yp.cdnstream1.com/metadata/${stationID}/range/${startTimestamp}-${endTimestamp}.json`;
    }

    const proxyList = [
        "https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent(targetUrl),
        //`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,
        //`https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`,
        //`https://thingproxy.freeboard.io/fetch/${targetUrl}`,
        //"https://" + "cors-proxy" + ".htmldriven.com" + "/?url=" + encodeURIComponent(targetUrl),
        //"https://" + "jsonp" + ".afeld.me" + "/?url=" + encodeURIComponent(targetUrl),
        //"https://" + "cors-proxy-bypass" + ".herokuapp.com" + "/" + targetUrl,
        //"https://" + "is-it-cors" + ".herokuapp.com" + "/" + targetUrl,
        //"https://" + "shcors" + ".p.rapidapi.com" + "/" + targetUrl,
        //`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
        //`https://cors-anywhere.herokuapp.com/${targetUrl}`,
        //`https://proxy.cors.sh/${targetUrl}`
    ]

    //Because cors-anywhere.herokuapp.com is a free public resource, 
    // it requires a one-time activation to stop spam.
    //Before running your automated script loop, open a new tab in your web browser, 
    // https://www.cors-anywhere.com/
    // https://cors-anywhere.herokuapp.com/corsdemo
    // go to this URL: https://herokuapp.com and click the big button that says 
    // "Request temporary access to the demo server" 
    // Once you click that button, your browser console will have full permission to 
    // bypass CORS restrictions using that backup link. 
    const backupUrl = `https://cors-anywhere.herokuapp.com/${targetUrl}`;
    const backupUrl2 = `https://proxy.cors.sh/${targetUrl}`; // Alternative high-speed gateway

    let rawContent = "";

    try {

        // 🔄 Loop through available proxy servers until one responds with valid data
        // --- 1. PREPARE TRACKS: Combine Pending & New History ---
        let history = [];
        let freshHistorySize = 0;
        let trackUrisToAdd = [];
        let tracksToSaveForLater = [];
        let changesMade = false

        // Load pending tracks (stored as {TIT2, TPE1, TXXX_category})
        const savedPending = JSON.parse(localStorage.getItem(pendingStorageKey)) || [];
        const savedPendingLength = savedPending.length
        if (savedPendingLength > 0) {
            console.log(`%c Retrying ${savedPendingLength} pending tracks from previous run.`, "color: #0099ffff");
            history = [...savedPending];
        }

        const pendingUrisKey = `pending_uris_${stationID}`;
        const savedPendingUris = JSON.parse(localStorage.getItem(pendingUrisKey)) || [];

        const mirrorKey = `playlist_mirror_${stationID}`;

        // ✅ 100% Network-free startup pull!
        //let existingCachedTrackUris = new Set(JSON.parse(localStorage.getItem(mirrorKey)) || []);
        // 🚀 New IndexedDB layout (Make sure the enclosing function is marked as 'async'):
        let existingCachedTrackUris = new Set(await getPlaylistMirrorIndexedDB(mirrorKey) || []);

        
        if (existingCachedTrackUris.size === 0) {
            console.log(`📡 Mirror miss! Fetching playlist catalog from Spotify servers for ${stationID}...`);
            
            // Execute your standard full-playlist pagination loop here to fetch from Spotify
            // ... (Your existing code to populate existingTrackUris from Spotify) ...
            
            // Save it to localStorage so you never have to make this API fetch again!
            //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
            await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!
        }
        else {
            console.log(`🎯 Mirror hit! Instantly loaded ${existingCachedTrackUris.size} tracks locally for ${stationID}. Zero API cost.`);
        }


        let newStationSearchAllowed = true;
        // if(history.length > 150){
        //     newStationSearchAllowed = false;
        //     console.log(`%c Pending queue > 150 tracks - skipping Station Play History Search.`, "color: #0000; backround: #ff7300ff;")
        // }

    if(newStationSearchAllowed){
        let fetchSuccessful = false


        // =========================================================================
        // 📂 DEPLOYED REPOSITORY TEXT-STREAM LOCAL FETCH INTERCEPTOR
        // =========================================================================
        if (stationID.startsWith("XM_")) {
            // Extract the clean channel file identifier slug name (e.g., "XM_octane")
            const fileName = stationID.trim();
            
            // ✅ Relative File Resolution Route path inside your deployed repository environment
            // Change the folder path directory mapping below to match your structure exactly
            // ✅ Fix: Appends a dynamic timestamp parameter to force a fresh disk read every execution cycle
            const localRepositoryPath = `./xm.channels/${fileName}.json?t=` + Date.now();

            console.log(`📂 [Local Repo Mode] Resolved file target route mapping -> ${localRepositoryPath}`);

            try {
                // Natively request the text asset file directly from your repository's server space
                // This will NEVER trigger CORS or Cloudflare errors because it is an internal same-origin call!
                const fileResponse = await fetch(localRepositoryPath);
                
                if (!fileResponse.ok) {
                    console.error(`❌ Deployed repository error: Failed to locate file asset path at "${localRepositoryPath}" (Status: ${fileResponse.status})`);
                    return;
                }

                const rawFileText = await fileResponse.text();
                
                if (!rawFileText.trim()) {
                    console.warn(`⚠️ The data file asset located at "${localRepositoryPath}" is completely empty.`);
                    return;
                }

                let compiledMasterTrackQueue = [];


                // 🔍 IMPROVED BALANCED EXTRACTOR: 
                // Matches content between { and } while ensuring it handles nested arrays/objects.
                // This regex specifically targets the individual track records within your long line.
                const functionalJsonBlocks = rawFileText.match(/\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g) || [];
                console.log(`📦 Identified ${functionalJsonBlocks.length} track candidates in the repository stream.`);                

                for (let i = 0; i < functionalJsonBlocks.length; i++) {
                    try {
                        const parsedTrackRecord = JSON.parse(functionalJsonBlocks[i].trim());
                        
                        // ✅ VALIDATION: Ensure it's a real track object with title/artists
                        if (parsedTrackRecord.track && parsedTrackRecord.track.title) {
                            compiledMasterTrackQueue.push(parsedTrackRecord);
                        }
                    }
                    catch (singleBlockErr) {
                        // Silent pass for individual corrupted records (like the Ramones snippet earlier)
                    }
                }

                console.log(`🎉 Unified a master list of ${compiledMasterTrackQueue.length} raw historical tracks.`);
                
                // Wrap back into legacy results format so the rest of your app stays unchanged
                rawContent = JSON.stringify({ results: compiledMasterTrackQueue });
                fetchSuccessful = true;

            } catch (masterRepositoryException) {
                console.error("❌ Exception during repository parse loop:", masterRepositoryException);
                return;
            }
        }
        
        // =========================================================================
        // 🌍 STANDARD NETWORK SECTOR (FOR YOUR REGULAR LIVE LOCAL RADIO STATIONS)
        // =========================================================================
        else{
        let proxyUrl
        for (proxyUrl of proxyList) {
            try {
                // Safe URL parsing for clean logging strings
                // const domainLabel = proxyUrl.includes("allorigins") ? "api.allorigins.win" : 
                // proxyUrl.includes("thingproxy") ? "thingproxy.freeboard.io" : "api.codetabs.com";

                // if (stationID === "KBZN") {
                //     proxyUrl = proxyList[Math.floor(Math.random() * proxyList.length) - 1]
                // }

                if(stationID === "KCINFM"){
                    proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`
                }

                console.log(`%c ${stationID}  Attempting connection via: ${proxyUrl.split('/')[2]}...`, "color: #00c020;");
                console.log(`proxyUrl: ${proxyUrl}`)
                const response = await fetch(proxyUrl);
                if (!response.ok){
                    console.log(`${stationID} Proxy failed ${proxyUrl}`)
                    continue; // If this proxy errors, loop immediately to the next one
                }
                
                // Extract the body string based on the proxy's specific output layout
                if (proxyUrl.includes("allorigins")) {
                    const proxyData = await response.json();
                    rawContent = proxyData.contents;
                } 
                else {
                    rawContent = await response.text();
                }
            // 🔍 ADD THIS LOGGING LINE HERE:
            console.log(`[DEBUG] Raw proxy payload length: ${rawContent ? rawContent.length : 0}. First 3000 chars:`, rawContent ? rawContent.substring(0, 3000) : "EMPTY");

                // if (rawContent && !rawContent.trim().startsWith("<!DOCTYPE")) {
                //     fetchSuccessful = true;
                //     console.log(`🎉 Connection established via ${proxyUrl.split('/')}!`);
                //     break; // Exit the loop early because we got clean metadata
                // }
                // if (rawContent && rawContent.trim().startsWith("{") && !rawContent.trim().toLowerCase().startsWith("<!doctype")) {
                //     fetchSuccessful = true;
                //     console.log("🎉 Direct connection established flawlessly with XMPlaylist servers!");
                //     break;
                // }
                // ✅ Fix: Check if the text starts with an open array bracket [ or an open curly brace {
                const trimmed = rawContent ? rawContent.trim() : "";
                const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
                const isHtml = trimmed.toLowerCase().startsWith("<!doctype") || trimmed.toLowerCase().startsWith("<html");

                if (trimmed && isJson && !isHtml) {
                    fetchSuccessful = true;
                    console.log(`🎉 Connection established safely via proxy!`);
                    break; 
                }
                else{
                    console.log(`${stationID} unable to parse rawContent`)
                }
            }
            catch (e) {
                console.warn(`⚠️ Proxy gateway ${proxyUrl.split('/')[2]} failed or timed out: ${e}`);
            }
        }
        }
        if (!fetchSuccessful || !rawContent) {
            console.error("❌ Critical: All fallback proxy servers timed out. Skipping this sync cycle.");
            //return;
        }

        if(fetchSuccessful && rawContent){

        // Safe to parse now!
        const data = JSON.parse(rawContent);
        let freshHistory = [];

        // 🅰️ IF PROCESSING THE AIIR NETWORK (KSOP Z104)
        if (targetUrl.includes("aiir.com")) {
            // Aiir outputs tracks inside a direct rolling array root or history key
            const aiirTracks = data.tracks || data.history || (Array.isArray(data) ? data : []);
            
            for (const t of aiirTracks) {
                const title = t.title || t.name;
                const artist = t.artist || t.artist_name || t.artistName;
                
                if (title && artist && title.toLowerCase() !== "advertisement" && title.toLowerCase() !== "radio from hell show") {
                    // Map to your unified internal dictionary schema format
                    freshHistory.push({ TIT2: title.trim(), TPE1: artist.trim(), TXXX_category: 'music' });
                }
            }
        } 
        // 🅰️ IF PROCESSING SIRIUSXM ARCHIVE METADATA
        else if (stationID.startsWith("XM_")) {
            // ✅ XMPlaylist wraps the tracks inside an array target key named 'results'
            const xmTracks = data.results || [];

            //freshHistorySize = xmTracks.length
            
            for (const t of xmTracks) {
                // Extract using the exact schema paths visible in your payload check
                const title = t.track?.title;
                
                // XM handles multiple artists in an array; map the primary first element string safely
                const artist = Array.isArray(t.track?.artists) ? t.track.artists[0] : "";
                
                //console.log(`XM song: artist: ${artist} title: ${title}`)

                // 🧬 GET THE DIRECT SPOTIFY URI INSTANTLY (Bypasses the search counter!)
                const spotifyId = t.spotify?.id;

                if (title && artist && title.toLowerCase() !== "advertisement") {
                    if (spotifyId) {
                        const compiledUri = `spotify:track:${spotifyId.trim()}`;

                        //console.log(`spotifyId: ${spotifyId}`)
                        
                        let cachedTrack
                        let foundUri
                        let alternates = []
                        let isAnyVariantOnPlaylist

                        // Hydrate your persistent global cache layer at the exact same time
                        const cacheKey = `${cleanMetadataString(artist)}|${cleanMetadataString(title)}`;
                        if (!globalSongCache[cacheKey]) {

                            const trackPayload = {
                                found: true,
                                uri: compiledUri,
                                alternate_uris: [],
                                resolved_title: title,
                                resolved_artist: artist,
                                stations_synced: [stationID]
                            }

                            globalSongCache[cacheKey] = trackPayload
                            pendingCloudCacheUploads[cacheKey] = trackPayload
                        }
                        else{
                            cachedTrack = globalSongCache[cacheKey];
                            alternates = cachedTrack.alternate_uris || []
                            
                            if(!cachedTrack.found) cachedTrack.found = true

                            if(!cachedTrack.uri) cachedTrack.uri = compiledUri

                            cachedTrack.stations_synced = cachedTrack.stations_synced || []
                            if (!cachedTrack.stations_synced.includes(stationID)) {
                                cachedTrack.stations_synced.push(stationID);
                            }


                            // 🛡️ CANONICAL CROSS-REFERENCE CHECK: Does the playlist contain ANY known version of this song?
                            if(alternates.some(altUri => existingCachedTrackUris.has(altUri))){
                                console.log(`Original track not in playlist, but alternate track is.`)
                                isAnyVariantOnPlaylist = true
                            }
                        }
                        // Push straight to your trackUrisToAdd batch loop!
                        if (!existingCachedTrackUris.has(compiledUri) && !isAnyVariantOnPlaylist && !trackUrisToAdd.includes(compiledUri)) {
                            trackUrisToAdd.push(compiledUri);
                            console.log(`🎯 [XM Direct Mapping Hit]: "${artist}-${title}" -> Loaded URI via payload link: ${compiledUri}`);

                            changesMade = changesMade || !savedPendingUris.includes(compiledUri)
                        }
                        
                    }
                    else {
                        console.log(`XM song - No Spotify ID: artist: ${artist} title: ${title}`)

                        // Rare fallback check: If an entry has no Spotify ID on their server, 
                        // pass the text attributes down so your regular search engine can attempt it later
                        freshHistory.push({ TIT2: title.trim(), TPE1: artist.trim(), TXXX_category: 'music' });
                    }
                }
            }
        }
        // 🅰️ EXTRACT THE LIVE MYSTREAMPLAYER JSON PROPERTIES (KBZN)
        if (targetUrl.includes("streamdata.php")) {
            const jsonPayload = JSON.parse(rawContent.trim());
            
            const title = jsonPayload.title || jsonPayload.song || "";
            const artist = jsonPayload.artist || "";

            if (title && artist && title.toLowerCase() !== "advertisement") {
                console.log(`📡 [Now 97.9 Live Hit]: "${title}" by "${artist}"`);
                
                // Route metadata straight into your standard execution queue
                freshHistory.push({ 
                    TIT2: title.trim(), 
                    TPE1: artist.trim(), 
                    TXXX_category: 'music' 
                });
            }
        }
        // 🅳 EXTRACT LIVE365 HISTORICAL TRACK ARRAYS (a24346)
        if (targetUrl.includes("api.live365.com")) {
            const jsonPayload = JSON.parse(rawContent.trim());
            
            // Extract the list of recently completed songs
            const live365Tracks = jsonPayload["last-played"] || [];
            
            for (const t of live365Tracks) {
                const title = t.title || "";
                const artist = t.artist || "";
                
                // Keep corporate station imaging files out of the sync loop
                if (title && artist && title.toLowerCase() !== "advertisement") {
                    freshHistory.push({ 
                        TIT2: title.trim(), 
                        TPE1: artist.trim(), 
                        TXXX_category: 'music' 
                    });
                }
            }
            
            // Optional: Grab the active live track as well so you don't miss it!
            if (jsonPayload["current-track"]) {
                const liveTitle = jsonPayload["current-track"].title || "";
                const liveArtist = jsonPayload["current-track"].artist || "";
                
                if (liveTitle && liveArtist) {
                    freshHistory.push({ 
                        TIT2: liveTitle.trim(), 
                        TPE1: liveArtist.trim(), 
                        TXXX_category: 'music' 
                    });
                }
            }

            console.log(`📡 [Live365 API]: Processed tracks for station: ${stationID}`);
        }

        // 🅲 EXTRACT TOWNSQUARE MEDIA TRACK HISTORY (KCIN / Cat Country)
        if (targetUrl.includes("townsquaremedia.com")) {
            const jsonPayload = JSON.parse(rawContent.trim());
            
            // Access the history array safely out of the data wrapper
            const townsquareTracks = jsonPayload.data && jsonPayload.data.history ? jsonPayload.data.history : [];
            
            for (const t of townsquareTracks) {
                const title = t.title || "";
                const artist = t.artist || "";
                
                // Avoid empty properties or common radio ads/promos disguised as tracks
                if (title && artist && title.toLowerCase() !== "advertisement" && artist.toLowerCase() !== "station id") {
                    
                    freshHistory.push({ 
                        TIT2: title.trim(), 
                        TPE1: artist.trim(), 
                        TXXX_category: 'music' 
                    });
                }
            }
            
            console.log(`📡 [Townsquare API]: Extracted ${townsquareTracks.length} historical tracks.`);
        }
        // 🅴 EXTRACT ONLINERADIOBOX CACHE PAYLOADS (KENZ)
        if (targetUrl.includes("onlineradiobox.com")) {
            const jsonPayload = JSON.parse(rawContent.trim());
            
            // Extract the pre-split track fields explicitly
            let title = jsonPayload.iName || "";
            let artist = jsonPayload.iArtist || "";

            if(!title) title = jsonPayload.title || ""
            if(!artist) artist = jsonPayload.title || ""
            if(title && artist && title === artist) title = "song"

            // Prevent empty tags or standard station imaging from breaking the sync layout
            if (title && artist && title.toLowerCase() !== "advertisement") {
                console.log(`📡 [OnlineRadioBox Hit]: "${title}" by "${artist}"`);
                
                freshHistory.push({ 
                    TIT2: title.trim(), 
                    TPE1: artist.trim(), 
                    TXXX_category: 'music' 
                });
            }
        }
        // 🅵 EXTRACT IHEART MEDIA STATION HISTORY ARRAYS (KJMY / 2385)
        if (targetUrl.includes("api.iheart.com") && targetUrl.includes("trackHistory")) {
            const jsonPayload = JSON.parse(rawContent.trim());
            
            // Extract the history array out of the top-level "data" property block
            const iHeartTracks = jsonPayload.data || [];
            
            for (const t of iHeartTracks) {
                const title = t.title || "";
                const artist = t.artist || ""; // Uses the plain 'artist' key from your log
                
                // Avoid logging commercial breaks or tracking artifacts
                if (title && artist && title.toLowerCase() !== "advertisement" && artist.toLowerCase() !== "iheartradio") {
                    freshHistory.push({ 
                        TIT2: title.trim(), 
                        TPE1: artist.trim(), 
                        TXXX_category: 'music' 
                    });
                }
            }
            
            console.log(`📡 [iHeart API]: Successfully parsed ${freshHistory.length} songs out of the rolling history window.`);
        }
        // 🅶 EXTRACT LDRHUB DATA PAIRS (KSOP / Z104 Country)
        if (targetUrl.includes("api.ldrhub.com")) {
            const jsonPayload = JSON.parse(rawContent.trim());
            
            // Navigate past the top-level method wrapper object key safely
            const mainNode = jsonPayload["Station.Engage.NowPlaying"] || {};
            
            // 1. Process the active "Now Playing" live track hit
            if (mainNode.now_playing) {
                const liveTitle = mainNode.now_playing.title || "";
                const liveArtist = mainNode.now_playing.artist || "";
                
                if (liveTitle && liveArtist && liveTitle.toLowerCase() !== "advertisement") {
                    console.log(`🤠 [KSOP Live Hit]: "${liveTitle}" by "${liveArtist}"`);
                    
                    freshHistory.push({ 
                        TIT2: liveTitle.trim(), 
                        TPE1: liveArtist.trim(), 
                        TXXX_category: 'music' 
                    });
                }
            }
            
            // 2. Optional: Process the "Future Songs" array if you want to preload upcoming matches
            const futureTracks = mainNode.future_songs || [];
            for (const t of futureTracks) {
                const futTitle = t.title || "";
                const futArtist = t.artist || "";
                
                if (futTitle && futArtist && futTitle.toLowerCase() !== "advertisement") {
                    freshHistory.push({ 
                        TIT2: futTitle.trim(), 
                        TPE1: futArtist.trim(), 
                        TXXX_category: 'music' 
                    });
                }
            }
            
            console.log(`📡 [LDRHub Parser]: Checked active layout tracks for KSOP.`);
        }
        // 🅱️ IF PROCESSING STANDARD STREAMON STATIONS
        else {
            const streamOnTracks = data.tracks || data.history || (Array.isArray(data) ? data : []);
            for (const t of streamOnTracks) {
                if (t.TXXX_category === 'music' && t.TIT2 && t.TPE1) {
                    freshHistory.push({ TIT2: t.TIT2.trim(), TPE1: t.TPE1.trim(), TXXX_category: 'music' });
                }
            }
        }


        if (!stationID.startsWith("XM_")) freshHistorySize = freshHistory.length
        freshHistorySize = freshHistory.length
        console.log(`Radio Now Playing Size: ${freshHistorySize}`)

        history = [...history, ...freshHistory];
        if (freshHistory.length === 0) {
            console.log("No historical tracks found in the feed.");
        }
        
        }

    }

        // Deduplicate local history array to avoid searching for the same song twice in one run
        const uniqueHistory = Array.from(new Set(history.map(s => JSON.stringify(s)))).map(s => JSON.parse(s));


        if (stationID.startsWith("XM_")) {
            //just continue on
        }
        if (uniqueHistory.length === 0) {
            console.log("No new or cached historical tracks found.");
            //return; //Nah, can continue - may be pending uris, plus need to continue for xm
        }

        console.log(`Found ${uniqueHistory.length} tracks. Searching Spotify...`);

        console.log("--- FULL HISTORY DATA STRUCTURE ---");
console.dir(uniqueHistory, { depth: null });

        console.log(`%c Minimized Now Playing Size: ${uniqueHistory.length}`, "color: #ea00ff")

        let existingTrackUris = new Set();

        let startingOffset = 0
        let nextPageUrl = ""

        if(!totalSpotifyRateLimit && (spotifyPlaylistDownloadAllowed || spotifyPlaylistDownloadSmallAllowed) && (stationNetwork[beginningStationNetworkAllowed].id === stationID)){
            if(spotifyPlaylistDownloadAllowed || existingCachedTrackUris.size <= 300){
                spotifyPlaylistDownloadAllowed = false
                // Start with the initial 100-item page endpoint
                nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;
            }
            else{
                startingOffset = (Math.floor(existingCachedTrackUris.size / 100) * 100) - 200
                            //https://api.spotify.com/v1/playlists/2yBlKOrxYIkY7UUqTObxI9/items?offset=500&limit=100&locale=en-US,en
                nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?offset=${startingOffset}&?limit=100&locale=en-US,en`;
            }
            spotifyPlaylistDownloadSmallAllowed = false
            console.log(`❌ Session Changes spotifyPlaylistDownloadAllowed - ${stationNetwork[beginningStationNetworkAllowed].id}. size=${existingCachedTrackUris.size} offset=${startingOffset}`);


        // ✅ STEP 1.5: Fetch existing tracks from the Spotify playlist to prevent duplicates
        console.log(`Loading entire track catalog for playlist: ${playlistId}...`);
        

        // 🔄 Pagination Loop: Keep crawling pages until nextPageUrl turns null
        while (nextPageUrl) {
            try {
                console.log(`nextPageUrl: ${nextPageUrl}`)
                const playlistResponse = await fetch(nextPageUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (!playlistResponse.ok) {
                    console.error(`⚠️ Playlist fetch interrupted! Status: ${playlistResponse.status}`);
                    if(playlistResponse.status === 401){
                        await delay(30 * 1000); //retry after 30sec
                        continue;
                    }
                    else{
                        totalSpotifyRateLimit = true
                        break;
                    }
                }

                const playlistData = await playlistResponse.json();
        console.log("--- FULL HISTORY DATA STRUCTURE ---");
console.dir(playlistData.items, { depth: null });
                const items = playlistData.items || [];

                // Extract and add found URIs directly into your lookup Set
                for (const i of items) {
                    const uri = i.item?.uri || i.track?.uri;
                    const track = i.track || i.item;
                    
                    // Extract official resolved text fields natively from Spotify's schema layout keys
                    const spotifyTitle = track.name;
                    const spotifyArtist = track.artists?.[0]?.name || "Unknown Artist";
                    const trackUri = track.uri;

                    if (uri){
                        //if it's not already in the cached existing track uris
                        if(!existingCachedTrackUris.has(uri)) existingTrackUris.add(uri);
                    }

                    // 🧼 Run your pre-processor function to generate the unified lowercase cache key slug
                    const cleanArtist = cleanMetadataString(spotifyArtist);
                    const cleanTitle = cleanMetadataString(spotifyTitle);
                    const cacheKey = `${cleanArtist}-${cleanTitle}`.toLowerCase();
                    //console.log(`cacheKey: '${cacheKey}'`)


                    // Check if this song footprint keys exist yet inside our storage block
                    if (globalSongCache[cacheKey]) {
                        const record = globalSongCache[cacheKey];
                        //console.log(`✅ [Playlist History song already in Cache]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);
                        
                        if(!record.found) record.found = true

                        if(!record.uri) record.uri = trackUri

                        // Track station affiliation mapping: Ensure stationID is attached to historical sync lists
                        record.stations_synced = record.stations_synced || []
                        if (!record.stations_synced.includes(stationID)) {
                            record.stations_synced.push(stationID);
                            pendingCloudCacheUploads[cacheKey] = record
                        }

                        // Canonical checking: Ensure the found URI is linked to your alternates array registry
                        if (record.uri !== trackUri && !record.alternate_uris.includes(trackUri)) {
                            record.alternate_uris.push(trackUri);
                            pendingCloudCacheUploads[cacheKey] = record
                            console.log(`🔗 [Variant Linked] Appended alternate track alias mapping: ${trackUri} to "${spotifyTitle}"`);
                            if(track.linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                                if(!record.alternate_uris) record.alternate_uris = []
                                record.alternate_uris.push(track.linked_from?.uri)
                            }
                        }
                    }
                    else {
                        // Initialize a brand new persistent cache schematic entry object mapping
                        const trackPayload = {
                            found: true,
                            uri: trackUri,
                            alternate_uris: [],
                            resolved_title: spotifyTitle,
                            resolved_artist: spotifyArtist,
                            stations_synced: [stationID]
                        }

                        globalSongCache[cacheKey] = trackPayload
                        pendingCloudCacheUploads[cacheKey] = trackPayload

                        if(track.linked_from?.id){
                            console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                            if(!record.alternate_uris) record.alternate_uris = []
                            record.alternate_uris.push(track.linked_from?.uri)
                        }
                        console.log(`✅ [Playlist History New Song Cached]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);
                    }

                    const foundfuzzyMatchKey = scanCacheForFuzzyMatch(cleanArtist, cleanTitle, globalSongCache, 0.88);

                    if (foundfuzzyMatchKey) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[foundfuzzyMatchKey];
                        //console.log(`✅ [Playlist History song already [Fuzzy Match] in Cache]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = trackUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];

                        if (cachedTrack.uri !== trackUri && !cachedTrack.alternate_uris.includes(trackUri)) {
                            cachedTrack.alternate_uris.push(trackUri)
                            console.log(`🔗 [Variant Added] Appended alternate track alias [Fuzzy Match] mapping: ${trackUri} to "${spotifyTitle}"`);
                            if(track.linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate [Fuzzy Match] track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                                cachedTrack.alternate_uris.push(track.linked_from?.uri)
                            }
                        }
                    }

                }

                // 🧭 Navigation checkpoint: Update the URL to the next page, or null to terminate
                nextPageUrl = playlistData.next; 

                // Optional: Print progress updates if dealing with massive lists
                if (nextPageUrl) {
                    console.log(`...Loaded ${existingTrackUris.size} tracks so far. Moving to next page...`);
                    // Tiny 100ms pause to ensure your pagination loop doesn't slam the endpoint
                    await delay(800); 
                }
            } catch (err) {
                console.error("❌ Exception encountered while fetching playlist tracks:", err);
                break;
            }
        }
        console.log(`🎯 Session Changes Complete! Final deduplication set populated with ${existingTrackUris.size} total tracks.`);
        }
        // else{

            
        //     const mirrorKey = `playlist_mirror_${stationID}`;

        //     // ✅ 100% Network-free startup pull!
        //     existingTrackUris = new Set(JSON.parse(localStorage.getItem(mirrorKey)) || []);

        //     if (existingTrackUris.size === 0) {
        //         console.log(`📡 Mirror miss! Fetching playlist catalog from Spotify servers for ${stationID}...`);
                
        //         // Execute your standard full-playlist pagination loop here to fetch from Spotify
        //         // ... (Your existing code to populate existingTrackUris from Spotify) ...
                
        //         // Save it to localStorage so you never have to make this API fetch again!
        //         localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingTrackUris)));
        //     } else {
        //         console.log(`🎯 Mirror hit! Instantly loaded ${existingTrackUris.size} tracks locally for ${stationID}. Zero API cost.`);
        //     }
        // }

        //concatenate cached uris with any ones from actual playlist that weren't already captured
        existingTrackUris = existingTrackUris.union(existingCachedTrackUris);

        // Save it to localStorage so you never have to make this API fetch again!
        //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
        await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!

        console.log(`Playlist currently contains ${existingTrackUris.size} tracks. Searching for new additions...`);

            if(!spotifySyncAllowed) {
                console.log(`%c ⏳ Spotify Search Gate Locked. Skipping API calls for another ${spotifySyncMinutesRemaining} minutes. Accumulating items in LocalStorage.`, "color: #83621aff; background: #b6b5b5ff");
            }
            else {
                console.log(`%c 🔓 Spotify Search Gate Open! Proceeding with live track queries...`, "color: #d9ff00ff; background: #005f00;");
                // Update the timestamp only when a full search run is allowed to start
                
                //localStorage.setItem(pacingKey, Date.now().toString());
            }
            console.log(`syncRadioSpotifyRateLimit: ${syncRadioSpotifyRateLimit}`)
            console.log(`spotifySyncAllowed: ${spotifySyncAllowed}`)
            console.log(`stationNetwork[currentStationNetworkAllowed].id: '${stationNetwork[currentStationNetworkAllowed].id}'`)
            console.log(`stationID: '${stationID}'`)
            console.log(`globalSearchesPerformed: ${globalSearchesPerformed}`)

        console.log(`Analyzing accumulated history backlog for station: ${stationID}...`);

        // 🚨 VOLUMETRIC GOVERNOR: Cap search requests to protect your account's daily quota
        const MAX_SEARCHES_PER_RUN = 150; // Per station limit, or set a global counter up top
        let searchesPerformedThisRun = 0;
        if(stationID !== "KBZN") spotifySearchPeformed = false


        // 2. Loop through tracks and find their Spotify URIs
        for (const item of uniqueHistory) {

            let globalCacheFound = true

            // ✅ Only process items categorized explicitly as music
            if (item.TXXX_category !== 'music') continue;

            // 🧼 RUN PRE-PROCESSOR: Clean and normalize raw station inputs instantly
            // ✅ Use the ID3 metadata tags (TIT2 and TPE1)
            const rawArtist = item.TPE1?.trim() || "";
            const rawTitle = item.TIT2?.trim() || "";
            if (!rawArtist || !rawTitle) continue;

            console.log(`rawArtist: ${rawArtist} rawTitle: ${rawTitle}`)

            const artist = cleanMetadataString(rawArtist);
            const title = cleanMetadataString(rawTitle);
            const cacheKey = `${artist}-${title}`.toLowerCase();

            if (!artist || !title) continue;
            console.log(`artist: ${artist} title: ${title}`)
            //console.log(`cacheKey: '${cacheKey}'`)

            // Check Global Session Cache First
            // 🅰️ CHECK 1: Strict Direct Key Match Check
            if (globalSongCache[cacheKey]) {
                const cachedTrack = globalSongCache[cacheKey];
                let foundUri = cachedTrack.uri;
                const alternates = cachedTrack.alternate_uris || []

                if(foundUri && !foundUri.includes("spotify:track:")){
                    foundUri = `spotify:track:${foundUri}`
                    cachedTrack.uri = foundUri
                }
                if(foundUri && foundUri.includes("XXXX")){
                    foundUri = ""
                }

                cachedTrack.stations_synced = cachedTrack.stations_synced || []

                // Target property arrays check: Has THIS station already synced this track?
                const alreadySyncedOnThisStation = cachedTrack.stations_synced.includes(stationID);

                console.log(`Song already in Global Song Cache - artist: ${artist} title: ${title}`)

                // 🛡️ CANONICAL CROSS-REFERENCE CHECK: Does the playlist contain ANY known version of this song?
                let isAnyVariantOnPlaylist
                if(alternates.some(altUri => existingTrackUris.has(altUri))){
                    console.log(`Original track not in playlist, but alternate track is.`)
                    isAnyVariantOnPlaylist = true
                    if(!foundUri){
                        foundUri = altUri
                    }
                }

                if(alreadySyncedOnThisStation) {
                    // Case 1: Already searched AND already added to this specific playlist. 
                    // Completely drop from this execution loop fraction! No network action needed.
                    console.log(`⏭️ [Cache Bypass] "${title} - ${artist}" already processed on this Station.`);
                    if(trackUrisToAdd.includes(foundUri)){
                        console.log(`somehow it's already in trackUrisToAdd`)
                    }
                }
                else {
                    // Mark this station ID inside the global cache array matrix immediately
                    if(foundUri) cachedTrack.stations_synced.push(stationID);
                }

                if(foundUri && !existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                    trackUrisToAdd.push(foundUri);
                    console.log(`✅ Song in Global Song Cache, but not in THIS playlist. Adding to batch artist: ${artist} title: ${title}`)

                    changesMade = changesMade || !savedPendingUris.includes(foundUri)
                }
                if(foundUri) continue; //It's in cache, no need to search for it
            }

            // 🅱️ CHECK 2: Fuzzy Cache Scanner Intercept
            // Threshold set to 0.88 (88% similarity) to catch typos while protecting accuracy
            // Why an 88% Threshold is the Sweet Spot
            // Setting the similarity threshold requires balancing coverage and precision:
            // Too High (e.g., 98%): Misses basic variations like Lady "a" vs Lady A.
            // Too Low (e.g., 70%): Risk falsely auto-mapping distinct tracks with similar title structures 
            // (e.g., matching Guns N' Roses - Live and Let Die to Paul McCartney - Live and Let Die).
            // The Sweet Spot (88%): Safely catches missing punctuation, quote formats, and stray 
            // line markers, while keeping completely different songs separated accurately.
            const fuzzyMatchKey = scanCacheForFuzzyMatch(artist, title, globalSongCache, 0.88);

            if (fuzzyMatchKey) {
                const cachedTrack = globalSongCache[fuzzyMatchKey];
                let foundUri = cachedTrack.uri;
                const alternates = cachedTrack.alternate_uris || []

                if(foundUri && !foundUri.includes("spotify:track:")){
                    foundUri = `spotify:track:${foundUri}`
                    cachedTrack.uri = foundUri
                }
                if(foundUri && foundUri.includes("XXXX")){
                    foundUri = ""
                }

                cachedTrack.stations_synced = cachedTrack.stations_synced || []

                // Target property arrays check: Has THIS station already synced this track?
                const alreadySyncedOnThisStation = cachedTrack.stations_synced.includes(stationID);

                console.log(`Song already in Global Song Cache [Fuzzy Match] - artist: ${artist} title: ${title}`)

                // 🛡️ CANONICAL CROSS-REFERENCE CHECK: Does the playlist contain ANY known version of this song?
                let isAnyVariantOnPlaylist
                if(alternates.some(altUri => existingTrackUris.has(altUri))){
                    console.log(`Original track not in playlist, but alternate track is.`)
                    isAnyVariantOnPlaylist = true
                    if(!foundUri){
                        foundUri = altUri
                    }
                }

                if(alreadySyncedOnThisStation) {
                    // Case 1: Already searched AND already added to this specific playlist. 
                    // Completely drop from this execution loop fraction! No network action needed.
                    console.log(`⏭️ [Cache Bypass] "${title} - ${artist}" already processed on this Station.`);
                }
                else{
                    // Add your station ID to this track's historical syncing records matrix
                    if(foundUri) cachedTrack.stations_synced.push(stationID);
                }
                if(foundUri && !existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                    trackUrisToAdd.push(foundUri);
                    console.log(`✅ Song in Global Song Cache [Fuzzy Match], but not in THIS playlist. Adding to batch artist: ${artist} title: ${title}`)

                    changesMade = changesMade || !savedPendingUris.includes(foundUri)
                }
                if(foundUri) continue;
            }

            globalCacheFound = false

            // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
            // Save the updated object map right after this station finishes its loop logic pass
            // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
            // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
            // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
            //await flushRuntimeCacheToIndexedDb(globalSongCache);


            // 🚨 CONDITION A: Global cap reached or gate is locked -> Defer immediately
            if(syncRadioSpotifyRateLimit || !spotifySyncAllowed || (stationNetwork[currentStationNetworkAllowed].id !== stationID) || globalSearchesPerformed >= GLOBAL_SEARCH_CAP ){
                if (globalSearchesPerformed >= GLOBAL_SEARCH_CAP) {
                    console.warn(`🛑 Global Session Cap of ${GLOBAL_SEARCH_CAP} reached mid-run! Deferring remaining tracks.`);
                    spotifySyncAllowed = false
                }
                if(stationNetwork[currentStationNetworkAllowed].id !== stationID){
                    console.log(`Current station ${stationID} not granted Spotify Search Gate`)
                }

                //This check isn't needed - we exit out if it is found
                //if(!globalSongCache[cacheKey] && !globalSongCache[fuzzyMatchKey]){
                    tracksToSaveForLater.push(item);
                    console.log(`🚨 Pushing item to tracksToSaveForLater: ${artist} title: ${title}`)

                    //if this is a new track to search
                    changesMade = changesMade || !savedPending.some(p => 
                        p.TIT2?.toLowerCase() === item.TIT2?.toLowerCase() && 
                        p.TPE1?.toLowerCase() === item.TPE1?.toLowerCase()
                    );

                //}
                continue;
            }
            
            // B. Search Spotify with pacing
            await delay(800);

            // Increment the shared global counter right before hitting the network
            globalSearchesPerformed++;
            spotifySearchPeformed = true

            console.log(`[Session Changes Global Search ${globalSearchesPerformed}/${GLOBAL_SEARCH_CAP}] Querying: ${title} - ${artist}`);

            const query = encodeURIComponent(`track:${title} artist:${artist}`);
            const searchUrl = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`;

            const searchResponse = await fetch(searchUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            // If we hit a 429, capture the header instruction or wait a full 5 seconds before retrying
            if (searchResponse.status === 429) {
                console.warn(`🛑 Spotify Rate Limit`);
                syncRadioSpotifyRateLimit = true
                globalSearchesPerformed = 0
                tracksToSaveForLater.push(item);

                // Using a public demo proxy (Note: public proxies often have their own limits)
                const proxyUrl = "https://cors-anywhere.herokuapp.com/";
                const targetUrl = searchUrl;

                const proxyResponse = await fetch(proxyUrl + targetUrl, {
                    method: "GET", // Or GET, matching your original searchUrl requirements
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "X-Requested-With": "XMLHttpRequest" // Required by cors-anywhere
                    }
                });

                if (proxyResponse.status === 429) {
                    // This will only run if the proxy server ALSO gets rate limited by Spotify
                    const retryAfter = proxyResponse.headers.get("retry-after");
                    console.log(`⏱️ Both local and proxy IPs rate limited. Retry after: ${retryAfter}s`);
                    tracksToSaveForLater.push(item);
                    continue; 
                } 
                
                if (proxyResponse.status === 200) {
                    console.log(`✅ Proxy successfully bypassed the 429 limit.`);
                    
                    // CRITICAL: Extract and process the data so you don't lose the track!
                    const data = await proxyResponse.json();
                    
                    // Add your normal track processing logic here, for example:
                    // const track = data.tracks.items[0];
                    // saveSpotifyTrack(track); 
                    
                    //continue; // Successfully recovered, move to the next item
                }
                
                // Catch-all for other proxy errors (403, 500, etc.)
                console.error(`❌ Proxy failed with status: ${proxyResponse.status}`);

                if (proxyResponse.status === 429) {
                    // The public proxy exposes ALL headers to the browser by default
                    const retryAfter = proxyResponse.headers.get("retry-after");
                    console.log(`retryAfter: ${retryAfter}`);
                }
                if(proxyResponse.status === 429){
                    const retryAfter = response.headers.get("Retry-AFter")

                    console.log(`retryAfter: ${retryAfter}`)
                }
                else{
                    console.log(`429 Proxy retry did not encounter 429`)
                    console.log(`proxyResponse.status: ${proxyResponse.status}`)
                }
                continue;
            }
            if (!searchResponse.ok) throw new Error(`StreamOn HTTP error! Status: ${searchResponse.status}`);

            if (searchResponse.ok) {
                const searchData = await searchResponse.json();
                const tracks = searchData.tracks?.items || [];
                
                if (tracks.length > 0) {
                    const foundUri = tracks[0].uri;
                    let foundartist = tracks[0].artists[0].name;
                    let foundtitle = tracks[0].name;
                    
                    // 🔄 UPDATE OR INITIALIZE TRACK RECORD LOGIC
                    if (globalSongCache[cacheKey]) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[cacheKey];
                        console.log(`✅ [New Search already in Cache]: ${title} - ${artist} -> ${foundUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = foundUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];
                        
                        // Append to variants list if it's a completely new unique ID string
                        if (cachedTrack.uri !== foundUri && !cachedTrack.alternate_uris.includes(foundUri)) {
                            cachedTrack.alternate_uris.push(foundUri);
                            console.log(`🔗 [Variant Added] Appended alternate track alias mapping: ${foundUri} to "${foundtitle}"`);
                            if(tracks[0].linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${tracks[0].linked_from?.uri} to "${foundtitle}"`);
                                cachedTrack.alternate_uris.push(tracks[0].linked_from?.uri)
                            }
                        }
                    }
                    else {
                        // Brand new record initialization structure
                        const trackPayload = {
                            found: true,
                            uri: foundUri,
                            alternate_uris: [], // Ready to collect variations on subsequent runs
                            resolved_title: foundtitle,
                            resolved_artist: foundartist,
                            stations_synced: [stationID]
                        }

                            globalSongCache[cacheKey] = trackPayload
                            pendingCloudCacheUploads[cacheKey] = trackPayload

                        if(tracks[0].linked_from?.id){
                            console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${tracks[0].linked_from?.uri} to "${foundtitle}"`);
                            globalSongCache[cacheKey].alternate_uris.push(tracks[0].linked_from?.uri)
                        }

                        console.log(`✅ [New Search Cached]: ${title} - ${artist} -> ${foundUri}`);
                    }

                    foundartist = cleanMetadataString(tracks[0].artists[0].name);
                    foundtitle = cleanMetadataString(tracks[0].name);
                    //const cacheKey = `${artist}-${title}`.toLowerCase();

                    const foundfuzzyMatchKey = scanCacheForFuzzyMatch(foundartist, foundtitle, globalSongCache, 0.88);

                    if (foundfuzzyMatchKey) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[foundfuzzyMatchKey];
                        console.log(`✅ [New Search already [Fuzzy Match] in Cache]: ${title} - ${artist} -> ${foundUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = foundUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];

                        if (cachedTrack.uri !== foundUri && !cachedTrack.alternate_uris.includes(foundUri)) {
                            cachedTrack.alternate_uris.push(foundUri)
                            console.log(`🔗 [Variant Added] Appended alternate track alias [Fuzzy Match] mapping: ${foundUri} to "${foundtitle}"`);
                            if(tracks[0].linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate [Fuzzy Match] track alias mapping: ${tracks[0].linked_from?.uri} to "${foundtitle}"`);
                                cachedTrack.alternate_uris.push(tracks[0].linked_from?.uri)
                            }
                        }
                    }
                    
                    // ✅ DUPLICATE CHECK: Skip adding to queue if it's already on your playlist
                    if (existingTrackUris.has(foundUri)) {
                        console.log(`⏭️ Skipping (Already in Playlist): ${title} - ${artist}`);
                    }

                    // ✅ DUPLICATE CHECK: Skip adding to playlist if it's already on your playlist
                    const alternates = globalSongCache[cacheKey].alternate_uris
                    //No alternates exist - otherwise we wouldn't have gotten this far
                    let isAnyVariantOnPlaylist
                    if(alternates.some(altUri => existingTrackUris.has(altUri))){
                        console.log(`Original track not in playlist, but alternate track is.`)
                        isAnyVariantOnPlaylist = true
                    }
                    const fuzzyalternates = globalSongCache[cacheKey].alternate_uris
                    //No alternates exist - otherwise we wouldn't have gotten this far
                    let isAnyFuzzyVariantOnPlaylist
                    if(fuzzyalternates.some(altUri => existingTrackUris.has(altUri))){
                        console.log(`Original [Fuzzy Match] track not in playlist, but alternate track is.`)
                        isAnyVariantOnPlaylist = true
                    }

                    if(!existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !isAnyFuzzyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                        trackUrisToAdd.push(foundUri);
                        console.log(`✅ Found New Track: ${title} - ${artist}`);

                        changesMade = changesMade || !savedPendingUris.includes(foundUri)
                    }

                    console.log(`✅ [Search Complete] Processed: ${title} - ${artist} -> ${foundUri}`);
                }
                else {
                    console.log(`❌ Not Found on Spotify: ${title} - ${artist}`);
                    
                    const trackPayload = {
                        found: false,
                        resolved_title: title,
                        resolved_artist: artist,
                        stations_searched: stationID,
                    }

                    globalSongCache[cacheKey] = trackPayload
                    pendingCloudCacheUploads[cacheKey] = trackPayload
                }
            }
            else {
                console.log(`⚠️ Search failed for: ${title} - ${artist} (Status: ${searchResponse.status})`);
            }
        }

        // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
        // Save the updated object map right after this station finishes its loop logic pass
        // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
        // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
        // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
        //await flushRuntimeCacheToIndexedDb(globalSongCache);

        if((globalSearchesPerformed >= GLOBAL_SEARCH_CAP) && (stationNetwork[currentStationNetworkAllowed].id === stationID)){
            globalSearchesPerformed = 0
            spotifySyncAllowed = false
        }

        let stationWithin5 = false
        for(whichStation = currentRadioPlaylistUpdateAllowed; whichStation < currentRadioPlaylistUpdateAllowed + 5; whichStation++){
            if (stationID === stationNetwork[whichStation % stationNetwork.length].id) stationWithin5 = true
        }
        //If we didn't hit the limit, go to next station
        if(spotifySyncAllowed && (stationNetwork[currentStationNetworkAllowed].id === stationID)){
            console.log(`Moving to next station`)
            currentStationNetworkAllowed = ((currentStationNetworkAllowed + 1) % stationNetwork.length)
        }


        // --- 3. BATCH ADD PHASE ---
        //const pendingUrisKey = `pending_uris_${stationID}`;
        let failedUris = [];

        //const savedPendingUris = JSON.parse(localStorage.getItem(pendingUrisKey)) || [];
        if (savedPendingUris.length > 0) {
            console.log(`%c Retrying ${savedPendingUris.length} pending track uris from previous run.`,"color: #ae00ffff");
            //trackUrisToAdd = [...trackUrisToAdd, ...savedPendingUris];
            // Combine both arrays and instantly filter out duplicates
            trackUrisToAdd = Array.from(new Set([...trackUrisToAdd, ...savedPendingUris]));
        }
        
        // 3. Add found tracks to your Spotify playlist
        if (trackUrisToAdd.length > 0) {
        if(!totalSpotifyRateLimit && stationWithin5){
            // 🛑 NEW: Filter out any malformed URIs containing 'XXXX' BEFORE processing batches
            const validTrackUris = trackUrisToAdd.filter(uri => {
                if (!uri || uri.includes("XXXX")) {
                    console.warn(`🗑️ [Purge] Removing malformed Spotify URI placeholder: "${uri}"`);
                    return false; // Drops it from the array completely
                }
                return true; // Keeps valid tracks
            });
            trackUrisToAdd = validTrackUris
            // Optional: Reverse array to keep oldest-to-newest timeline matching the radio order
            trackUrisToAdd.reverse(); 

            console.log(`%c Session Changes ${stationID}: Adding ${trackUrisToAdd.length} tracks to playlist...`, "color: #ff0000; background: #03db0e;");

            const batchSize = 100;

            for (let i = 0; i < trackUrisToAdd.length; i += batchSize) {
                const batch = trackUrisToAdd.slice(i, i + batchSize);
                const appendUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items`;

                try{
                    const appendResponse = await fetch(appendUrl, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ uris: batch })
                    });
                    
                    if (appendResponse.status === 429) {
                        totalSpotifyRateLimit = true
                        console.error("Rate limit hit during batch addition.");
                        failedUris = [...failedUris, ...batch];
                        break;
                    }
                    if (appendResponse.ok) {
                        console.log("🎉 Success! Playlist updated.");

                        // ✅ Keep the local reverse-mirror perfectly synced with Spotify's servers
                        for (const uri of batch) {
                            existingTrackUris.add(uri);
                        }
                        //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
                        await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!
                    } 
                    else {
                        const errData = await appendResponse.json();
                        console.error("Failed to add tracks to playlist:", errData);
                        failedUris = [...failedUris, ...batch];
                    }
                    
                }
                catch (err) {
                    failedUris = [...failedUris, ...batch];
                }
                    await delay(5 * 1000); 
            }
        }
        else{
            failedUris = [...failedUris, ...trackUrisToAdd];
            console.log(`Spotify rate limited. Pushing trackUrisToAdd to failedUris`)
        }
        }
        else {
            console.log("No matching tracks were found on Spotify during this run.");
        }

        if(!totalSpotifyRateLimit && spotifyPlaylistDeDuplicateAllowed && (stationNetwork[deDuplicateStationAllowed].id === stationID)){
            spotifyPlaylistDeDuplicateAllowed = false
            console.log(`❌ Session Changes DeDuplicate spotifyPlaylistDeDuplicateAllowed - ${stationNetwork[deDuplicateStationAllowed].id}.`);
            deduplicateSpotifyPlaylist(stationNetwork[deDuplicateStationAllowed].playlistId)
            console.log(`🎯 Session Changes DeDuplicate complete spotifyPlaylistDeDuplicateAllowed - ${stationNetwork[deDuplicateStationAllowed].id}.`);
        }

        // --- 4. FINALIZE: Save Unprocessed History for next run ---
        if (tracksToSaveForLater.length > 0) {
            localStorage.setItem(pendingStorageKey, JSON.stringify(tracksToSaveForLater));
            console.log(`%c Saved pending: ${savedPendingLength}`, "color: #ea00ff")
            console.log(`%c Radio Now Playing Size: ${freshHistorySize}`, "color: #ea00ff")
            console.log(`%c Minimized Now Playing Size: ${uniqueHistory.length}`, "color: #ea00ff")
            console.log(`%c Saving for later tracks: ${tracksToSaveForLater.length}`, "color: #ea00ff")
            console.log(`%c Added ${tracksToSaveForLater.length - savedPendingLength} tracks to pending`, "color: #ea00ff")
            console.log(`%c Eliminated ${uniqueHistory.length - tracksToSaveForLater.length} tracks`, "color: #8400ffff")
        }
        else {
            localStorage.removeItem(pendingStorageKey);
        }

        // B. Handle URIs (Items we found but couldn't add to the playlist)
        if (failedUris.length > 0) {
            localStorage.setItem(pendingUrisKey, JSON.stringify(failedUris));
            console.log(`Saving Spotify Failed Add Uris: ${failedUris.length}`)
        } else {
            localStorage.removeItem(pendingUrisKey);
        }

        console.log(`%c Session Changes ${stationID}: Playing: ${uniqueHistory.length - savedPendingLength} Pending Search: ${tracksToSaveForLater.length - savedPendingLength} Pending URIs: ${failedUris.length - savedPendingUris.length}`, "color: #00fff2; background: #585757;")
        if(changesMade) console.log(`%c Session Only Changes ${stationID}: Playing: ${uniqueHistory.length - savedPendingLength} Pending Search: ${tracksToSaveForLater.length - savedPendingLength} Pending URIs: ${failedUris.length - savedPendingUris.length}`, "color: #ffffff; background: #00aa00;")

        console.log(syncRadioSpotifyRateLimit ? "Sync partially finished." : `🎉 ${stationID} Station sync complete!`);
    }
    catch (error) {
        console.error("Error syncing radio playlist:", error);
    }
}

/**
 * ⏰ ACTIVE LIVE RADIO ACCUMULATOR WHEEL
 * Automatically polls live-only stations at short intervals to catch and 
 * accumulate their logs locally before the station deck shifts to the next track.
 */
function startLiveRadioAccumulator(stationID, targetPlaylistId) {
    console.log(`⏰ [Accumulator] Background monitoring engine armed for: ${stationID}`);
    
    syncRadioToSpotify(stationID, targetPlaylistId);

    // Poll the stream every 3.5 minutes (210,000 milliseconds)
    setInterval(async () => {
        try {
            console.log(`📡 [Accumulator] Running automated live check for ${stationID}...`);
            
            // Execute your standard sync function block natively
            // Your internal IndexedDB cache layer will automatically discard duplicates!
            await syncRadioToSpotify(stationID, targetPlaylistId);

            // 💾 MASTER LOCALSTORAGE WRITEBACK: Save everything safely back to the browser vault
            // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache_backfill));
            // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
            // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
            await flushRuntimeCacheToIndexedDb(globalSongCache);

        } catch (err) {
            console.error(`❌ [Accumulator] Monitor pass missed for ${stationID}:`, err);
        }
    }, 2.5 * 60 * 1000);
}

async function syncKBERToSpotify(stationID = 9999, playlistId = 9999) {
    
    const token = localStorage.getItem('access_token');
    
    console.log(`%c Fetching live history from ${stationID}...`, "color: #13c703; background: #000000;");
    
            // 🚨 CONDITION A: Global cap reached or gate is locked -> Defer immediately
            if(syncRadioSpotifyRateLimit || !spotifySyncAllowed || (stationNetwork[currentStationNetworkAllowed].id !== stationID) || globalSearchesPerformed >= GLOBAL_SEARCH_CAP ){
                if (globalSearchesPerformed >= GLOBAL_SEARCH_CAP) {
                    console.warn(`🛑 Global Session Cap of ${GLOBAL_SEARCH_CAP} reached mid-run! Deferring remaining tracks.`);
                }
                if(stationNetwork[currentStationNetworkAllowed].id !== stationID){
                    console.log(`Current station ${stationID} not granted Spotify Search Gate`)
                }
            }

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // --- STEP 0: Load Pending Tracks from LocalStorage ---
    let pendingStorageKey = `pending_tracks_${stationID}`;
    const mirrorKey = `playlist_mirror_${stationID}`;

    // 🚨 CONDITION A: Global cap reached or gate is locked -> Defer immediately
    if(syncRadioSpotifyRateLimit || !spotifySyncAllowed || (stationNetwork[currentStationNetworkAllowed].id !== stationID) || globalSearchesPerformed >= GLOBAL_SEARCH_CAP ){
        if (globalSearchesPerformed >= GLOBAL_SEARCH_CAP) {
            console.warn(`🛑 Global Session Cap of ${GLOBAL_SEARCH_CAP} reached mid-run! Deferring remaining tracks.`);
        }
        if(stationNetwork[currentStationNetworkAllowed].id !== stationID){
            console.log(`Current station ${stationID} not granted Spotify Search Gate`)
        }
    }

    // Triton Digital Open API endpoint configuration for KBER
    //const kberUrl = "https://allorigins.win";
    //const streamOnUrl = `https://api.allorigins.win//get?url=http%3A%2F%2Fyp.tritondigital.com%2Fmetadata%2F${stationID}%2Flast%2F10.json`;
    const kberUrl = `https://api.allorigins.win/get?url=https%3A%2F%2Fnp.tritondigital.com%2Fpublic%2Fnowplaying%3FmountName%3D${stationID}%26numberToFetch%3D10%26eventType%3Dtrack%26format%3Djson`
        // 1. Set up a primary proxy and a reliable backup proxy
        let targetUrl = `https://np.tritondigital.com/public/nowplaying?mountName=${stationID}&numberToFetch=100&eventType=track&format=json`;
        
        let primaryUrl = `https://allorigins.win/{encodeURIComponent(targetUrl)}`;
        primaryUrl = kberUrl
        const backupUrl = `https://proxy.cors.sh/${targetUrl}`; // Alternative high-speed gateway

    // Target the SecureNet Systems player status update endpoint
    if(stationID === 'KBLQ'){
        targetUrl = `https://streamdb7web.securenetsystems.net/player_status_update/${stationID}_history.xml`;
    }

    const proxyList = [
        "https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent(targetUrl),
        //`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,
        //`https://corsproxy.io/?url=${targetUrl}`,
        //`https://thingproxy.freeboard.io/fetch/${targetUrl}`,
        //`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
        //`https://cors-anywhere.herokuapp.com/${targetUrl}`,
        // `https://proxy.cors.sh/${targetUrl}`
    ]
        let rawContent = "";    

        // --- 1. PREPARE TRACKS: Combine Pending & New History ---
        let history = [];
        let freshHistorySize = 0;
        let changesMade = false

        // Load pending tracks (stored as {TIT2, TPE1, TXXX_category})
        const savedPending = JSON.parse(localStorage.getItem(pendingStorageKey)) || [];
        const savedPendingLength = savedPending.length
        if (savedPendingLength > 0) {
            console.log(`%c ${stationID} Retrying ${savedPendingLength} pending tracks from previous run.`,"color: #0099ffff");
            history = [...savedPending];
        }

        const pendingUrisKey = `pending_uris_${stationID}`;

        const savedPendingUris = JSON.parse(localStorage.getItem(pendingUrisKey)) || [];

        let newStationSearchAllowed = true;
        // if(history.length > 150){
        //     newStationSearchAllowed = false;
        //     console.log(`%c Pending queue > 150 tracks - skipping Station Play History Search.`, "color: #0000; backround: #ff7300ff;")
        // }


    try {
if(newStationSearchAllowed){
        let fetchSuccessful = false
        // ✅ 2. Loop through available proxy servers until one responds with valid data
        for (const proxyUrl of proxyList) {
            try{
                    // Safe URL parsing for clean logging strings
                    // const domainLabel = proxyUrl.includes("allorigins") ? "api.allorigins.win" : 
                    // proxyUrl.includes("thingproxy") ? "thingproxy.freeboard.io" : "api.codetabs.com";

                    console.log(`%c ${stationID} Attempting connection via: ${proxyUrl.split('/')[2]}...`, "color: #00c020;");
                    console.log(`proxyUrl: ${proxyUrl}`)

                    const response = await fetch(proxyUrl);
                    if (!response.ok){
                        console.log(`${stationID} Proxy failed ${proxyUrl}`)
                        continue; // If this proxy errors, loop immediately to the next one
                    }
                // Extract the body text based on the proxy's specific JSON or Text layout
                if (proxyUrl.includes("allorigins")) {
                    const proxyData = await response.json();
                    rawContent = proxyData.contents;
                } else {
                    rawContent = await response.text();
                }
            // 🔍 ADD THIS LOGGING LINE HERE:
            console.log(`[DEBUG] Raw proxy payload length: ${rawContent ? rawContent.length : 0}. First 1000 chars:`, rawContent ? rawContent.substring(0, 1000) : "EMPTY");

                // ✅ Correctly check for Triton's XML format instead of HTML error pages
                if (rawContent && rawContent.trim().startsWith("<?xml") && !rawContent.trim().startsWith("<!DOCTYPE")) {
                    fetchSuccessful = true;
                    console.log(`🎉 Connection established via ${proxyUrl.split('/')}!`);
                    break; // Exit the loop early because we got clean metadata
                }              
            } 
            catch (e) {
                console.warn(`⚠️ Proxy request failed during loop traversal.`);
            }
        }        

        if (!fetchSuccessful || !rawContent) {
            console.error("❌ Critical: All fallback proxy servers timed out. Skipping this sync cycle.");
            //return;
        }
        if(fetchSuccessful && rawContent){


        // ✅ NEW CONTENT-TYPE SOLVER: Parse Triton's raw XML stream using the browser's DOMParser
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(rawContent, "text/xml");
        
        // Triton wraps tracking updates inside <nowplaying-info> tags
        let freshHistory = []
        const trimmed = rawContent ? rawContent.trim() : "";

        // ✅ RE-IMPLEMENTED OPEN XML PARSER BLOCK
        // Matches Triton's <nowplaying-info-list> data structure perfectly
        if (trimmed.startsWith("<") || trimmed.includes("nowplaying-info")) {
            console.log(`<nowplaying-info-list>`)
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(rawContent, "text/xml");
            
            // Triton wraps historical track elements inside <nowplaying-info> elements
            const xmlTracks = xmlDoc.getElementsByTagName("nowplaying-info");
            
            console.log(`Successfully found ${xmlTracks.length} tracks inside Triton XML container...`);
            
            for (let i = 0; i < xmlTracks.length; i++) {
                const nodeItem = xmlTracks[i];
                const properties = nodeItem.getElementsByTagName("property");
                
                let title = "";
                let artist = "";

                // Safely iterate through Triton's unique CDATA property array blocks
                for (let j = 0; j < properties.length; j++) {
                    const nameAttr = properties[j].getAttribute("name");
                    if (nameAttr === "cue_title") {
                        title = properties[j].textContent?.trim() || "";
                    }
                    if (nameAttr === "track_artist_name") {
                        artist = properties[j].textContent?.trim() || "";
                    }
                }

                // Filter out non-music entries
                if (title && artist && title.toLowerCase() !== "advertisement") {
                    // Normalize object property keys to match your standard StreamOn layout exactly
                    freshHistory.push({ TIT2: title, TPE1: artist, TXXX_category: 'music' });
                }
            }
        }
        // Fallback fallback handler in case a proxy forces JSON headers on Triton later
        else if (trimmed.startsWith("{")) {
            console.log(`JSON headers`)
            const jsonData = JSON.parse(trimmed);
            const jsonTracks = jsonData["nowplaying-info-list"]?.["nowplaying-info"] || [];
            const tracksArray = Array.isArray(jsonTracks) ? jsonTracks : [jsonTracks];
            
            for (const item of tracksArray) {
                const properties = item.property || [];
                const titleObj = properties.find(p => p["@name"] === "cue_title");
                const artistObj = properties.find(p => p["@name"] === "track_artist_name");
                const title = titleObj?.["#text"]?.trim();
                const artist = artistObj?.["#text"]?.trim();

                if (title && artist && title.toLowerCase() !== "advertisement") {
                    freshHistory.push({ TIT2: title, TPE1: artist, TXXX_category: 'music' });
                }
            }
        }

        if (freshHistory.length === 0) {
            console.warn("⚠️ Data extraction notice: Zero rock track matches successfully structured.");
        }

        freshHistorySize = freshHistory.length
        console.log(`Radio Now Playing Size: ${freshHistorySize}`)

        // Merge backlogged entries from localStorage with newly processed tracks
        // ✅ Correctly extract the song array from the cdnstream response structure
        history = [...history, ...freshHistory];
        if (freshHistory.length === 0) {
            console.log("No historical tracks found in the feed.");
        }
    
        }
    }
        // Deduplicate local history array to avoid searching for the same song twice in one run
        const uniqueHistory = Array.from(new Set(history.map(s => JSON.stringify(s)))).map(s => JSON.parse(s));

        if (uniqueHistory.length === 0) {
            console.log("No new or cached historical tracks found.");
            return;
        }

        console.log(`%c Minimized Now Playing Size: ${uniqueHistory.length}`, "color: #ea00ff")

        let existingTrackUris = new Set();
        let nextPageUrl = ""

        const mirrorKey = `playlist_mirror_${stationID}`;

        // ✅ 100% Network-free startup pull!
        //let existingCachedTrackUris = new Set(JSON.parse(localStorage.getItem(mirrorKey)) || []);
        // 🚀 New IndexedDB layout (Make sure the enclosing function is marked as 'async'):
        let existingCachedTrackUris = new Set(await getPlaylistMirrorIndexedDB(mirrorKey) || []);

        if (existingCachedTrackUris.size === 0) {
            console.log(`📡 Mirror miss! Fetching playlist catalog from Spotify servers for ${stationID}...`);

            // Execute your standard full-playlist pagination loop here to fetch from Spotify
            // ... (Your existing code to populate existingTrackUris from Spotify) ...

            // Save it to localStorage so you never have to make this API fetch again!
            //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
            await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!
        } else {
            console.log(`🎯 Mirror hit! Instantly loaded ${existingCachedTrackUris.size} tracks locally for ${stationID}. Zero API cost.`);
        }

        if(!totalSpotifyRateLimit && (spotifyPlaylistDownloadAllowed || spotifyPlaylistDownloadSmallAllowed) && (stationNetwork[beginningStationNetworkAllowed].id === stationID)){
            if(spotifyPlaylistDownloadAllowed || existingCachedTrackUris.size <= 300){
                spotifyPlaylistDownloadAllowed = false
                // Start with the initial 100-item page endpoint
                nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;
            }
            else{
                startingOffset = (Math.floor(existingCachedTrackUris.size / 100) * 100) - 200
                            //https://api.spotify.com/v1/playlists/2yBlKOrxYIkY7UUqTObxI9/items?offset=500&limit=100&locale=en-US,en
                nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?offset=${startingOffset}&?limit=100&locale=en-US,en`;
            }
            spotifyPlaylistDownloadSmallAllowed = false
            console.log(`❌ Session Changes spotifyPlaylistDownloadAllowed - ${stationNetwork[beginningStationNetworkAllowed].id}. size=${existingCachedTrackUris.size} offset=${startingOffset}`);


        // ✅ STEP 1.5: Fetch existing tracks from the Spotify playlist to prevent duplicates
        console.log(`Loading entire track catalog for playlist: ${playlistId}...`);
        
        // 🔄 Pagination Loop: Keep crawling pages until nextPageUrl turns null
        while (nextPageUrl) {
            try {
                const playlistResponse = await fetch(nextPageUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (!playlistResponse.ok) {
                    console.error(`⚠️ Playlist fetch interrupted! Status: ${playlistResponse.status}`);
                    if(playlistResponse.status === 401){
                        await delay(30 * 1000); 
                        continue;
                    }
                    else{
                        totalSpotifyRateLimit = true
                        break;
                    }
                }

                const playlistData = await playlistResponse.json();
        console.log("--- FULL HISTORY DATA STRUCTURE ---");
console.dir(playlistData.items, { depth: null });
                const items = playlistData.items || [];

                // Extract and add found URIs directly into your lookup Set
                for (const i of items) {
                    const uri = i.item?.uri || i.track?.uri;
                    const track = i.track || i.item;

                    // Extract official resolved text fields natively from Spotify's schema layout keys
                    const spotifyTitle = track.name;
                    const spotifyArtist = track.artists?.[0]?.name || "Unknown Artist";
                    const trackUri = track.uri;
                    
                    if (uri){
                        //if it's not already in the cached existing track uris
                        if(!existingCachedTrackUris.has(uri)) existingTrackUris.add(uri);
                    }

                    // 🧼 Run your pre-processor function to generate the unified lowercase cache key slug
                    const cleanArtist = cleanMetadataString(spotifyArtist);
                    const cleanTitle = cleanMetadataString(spotifyTitle);
                    const cacheKey = `${cleanArtist}-${cleanTitle}`.toLowerCase();

                    // Check if this song footprint keys exist yet inside our storage block
                    if (globalSongCache[cacheKey]) {
                        const record = globalSongCache[cacheKey];
                        //console.log(`✅ [Playlist History song already in Cache]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);

                        if(!record.found) record.found = true

                        if(!record.uri) record.uri = trackUri

                        // Track station affiliation mapping: Ensure stationID is attached to historical sync lists
                        record.stations_synced = record.stations_synced || []
                        if (!record.stations_synced.includes(stationID)) {
                            record.stations_synced.push(stationID);
                        }

                        // Canonical checking: Ensure the found URI is linked to your alternates array registry
                        if (record.uri !== trackUri && !record.alternate_uris.includes(trackUri)) {
                            record.alternate_uris.push(trackUri);
                            console.log(`🔗 [Variant Linked] Appended alternate track alias mapping: ${trackUri} to "${spotifyTitle}"`);
                            if(track.linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                                record.alternate_uris.push(track.linked_from?.uri)
                            }
                        }
                    } 
                    else {
                        // Initialize a brand new persistent cache schematic entry object mapping
                        const trackPayload = {
                            found: true,
                            uri: trackUri,
                            alternate_uris: [],
                            resolved_title: spotifyTitle,
                            resolved_artist: spotifyArtist,
                            stations_synced: [stationID]
                        }

                        globalSongCache[cacheKey] = trackPayload
                        pendingCloudCacheUploads[cacheKey] = trackPayload

                        if(track.linked_from?.id){
                            console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                            record.alternate_uris.push(track.linked_from?.uri)
                        }
                        console.log(`✅ [Playlist History New Song Cached]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);
                    }

                    const foundfuzzyMatchKey = scanCacheForFuzzyMatch(cleanArtist, cleanTitle, globalSongCache, 0.88);

                    if (foundfuzzyMatchKey) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[foundfuzzyMatchKey];
                        //console.log(`✅ [Playlist History song already [Fuzzy Match] in Cache]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = trackUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];

                        if (cachedTrack.uri !== trackUri && !cachedTrack.alternate_uris.includes(trackUri)) {
                            cachedTrack.alternate_uris.push(trackUri)
                            console.log(`🔗 [Variant Added] Appended alternate track alias [Fuzzy Match] mapping: ${trackUri} to "${spotifyTitle}"`);
                            if(track.linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate [Fuzzy Match] track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                                cachedTrack.alternate_uris.push(track.linked_from?.uri)
                            }
                        }
                    }
                }

                // 🧭 Navigation checkpoint: Update the URL to the next page, or null to terminate
                nextPageUrl = playlistData.next; 

                // Optional: Print progress updates if dealing with massive lists
                if (nextPageUrl) {
                    console.log(`...Loaded ${existingTrackUris.size} tracks so far. Moving to next page...`);
                    // Tiny 100ms pause to ensure your pagination loop doesn't slam the endpoint
                    await delay(800); 
                }
            } catch (err) {
                console.error("❌ Exception encountered while fetching playlist tracks:", err);
                break;
            }
        }
        console.log(`🎯 Session Changes Complete! Final deduplication set populated with ${existingTrackUris.size} total tracks.`);
        }
        // else{
        //     const mirrorKey = `playlist_mirror_${stationID}`;

        //     // ✅ 100% Network-free startup pull!
        //     existingTrackUris = new Set(JSON.parse(localStorage.getItem(mirrorKey)) || []);

        //     if (existingTrackUris.size === 0) {
        //         console.log(`📡 Mirror miss! Fetching playlist catalog from Spotify servers for ${stationID}...`);
                
        //         // Execute your standard full-playlist pagination loop here to fetch from Spotify
        //         // ... (Your existing code to populate existingTrackUris from Spotify) ...
                
        //         // Save it to localStorage so you never have to make this API fetch again!
        //         localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingTrackUris)));
        //     } else {
        //         console.log(`🎯 Mirror hit! Instantly loaded ${existingTrackUris.size} tracks locally for ${stationID}. Zero API cost.`);
        //     }
        // }

        //concatenate cached uris with any ones from actual playlist that weren't already captured
        existingTrackUris = existingTrackUris.union(existingCachedTrackUris);

        // Save it to localStorage so you never have to make this API fetch again!
        //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
        await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!

        console.log(`Found ${uniqueHistory.length} items in ${stationID} feed. Processing tracks...`);
console.dir(uniqueHistory, { depth: null });
        let trackUrisToAdd = [];
        let tracksToSaveForLater = [];
        
            if(!spotifySyncAllowed) {
                console.log(`%c ⏳ Spotify Search Gate Locked. Skipping API calls for another ${spotifySyncMinutesRemaining} minutes. Accumulating items in LocalStorage.`, "color: #83621aff; background: #b6b5b5ff");
            }
            else {
                console.log(`%c 🔓 Spotify Search Gate Open! Proceeding with live track queries...`, "color: #d9ff00ff; background: #005f00;");
                // Update the timestamp only when a full search run is allowed to start
                
                //localStorage.setItem(pacingKey, Date.now().toString());
            }

        spotifySearchPeformed = false

        // 2. Loop through tracks and find their Spotify URIs
        for (const item of uniqueHistory) {
//console.dir(item, { depth: null });
            
            // 🧼 RUN PRE-PROCESSOR: Clean and normalize raw station inputs instantly
            // ✅ Use the ID3 metadata tags (TIT2 and TPE1)
            const rawArtist = item.TPE1?.trim() || "";
            const rawTitle = item.TIT2?.trim() || "";
            if (!rawArtist || !rawTitle) continue;

            const artist = cleanMetadataString(rawArtist);
            const title = cleanMetadataString(rawTitle);
            const cacheKey = `${artist}-${title}`.toLowerCase();

            if (!artist || !title) continue;
            console.log(`artist: ${artist} title: ${title}`)
            
            // Skip ads or incomplete tracks
            if (!title || !artist || title.toLowerCase() === "advertisement") continue;

            // Check Global Session Cache First
            // 🅰️ CHECK 1: Strict Direct Key Match Check
            if (globalSongCache[cacheKey]) {
                const cachedTrack = globalSongCache[cacheKey];
                let foundUri = cachedTrack.uri;
                const alternates = cachedTrack.alternate_uris || []

                if(foundUri && !foundUri.includes("spotify:track:")){
                    foundUri = `spotify:track:${foundUri}`
                    cachedTrack.uri = foundUri
                }

                cachedTrack.stations_synced = cachedTrack.stations_synced || []

                // Target property arrays check: Has THIS station already synced this track?
                const alreadySyncedOnThisStation = cachedTrack.stations_synced.includes(stationID);

                console.log(`Song already in Global Song Cache - artist: ${artist} title: ${title}`)

                // 🛡️ CANONICAL CROSS-REFERENCE CHECK: Does the playlist contain ANY known version of this song?
                let isAnyVariantOnPlaylist
                if(alternates.some(altUri => existingTrackUris.has(altUri))){
                    console.log(`Original track not in playlist, but alternate track is.`)
                    isAnyVariantOnPlaylist = true
                }

                if(alreadySyncedOnThisStation) {
                    // Case 1: Already searched AND already added to this specific playlist. 
                    // Completely drop from this execution loop fraction! No network action needed.
                    console.log(`⏭️ [Cache Bypass] "${title} - ${artist}" already processed on this Station.`);
                }
                else {
                    // Mark this station ID inside the global cache array matrix immediately
                    if(foundUri) cachedTrack.stations_synced.push(stationID);
                }

                if(foundUri && !existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                    trackUrisToAdd.push(foundUri);
                    console.log(`✅ Song in Global Song Cache, but not in THIS playlist. Adding to batch artist: ${artist} title: ${title}`)

                    changesMade = changesMade || !savedPendingUris.includes(foundUri)
                }
                console.log(`Song already added this session, skipping artist: ${artist} title: ${title}`)
                continue; //It's in cache, no need to search for it
            }

            // 🅱️ CHECK 2: Fuzzy Cache Scanner Intercept
            // Threshold set to 0.88 (88% similarity) to catch typos while protecting accuracy
            // Why an 88% Threshold is the Sweet Spot
            // Setting the similarity threshold requires balancing coverage and precision:
            // Too High (e.g., 98%): Misses basic variations like Lady "a" vs Lady A.
            // Too Low (e.g., 70%): Risk falsely auto-mapping distinct tracks with similar title structures 
            // (e.g., matching Guns N' Roses - Live and Let Die to Paul McCartney - Live and Let Die).
            // The Sweet Spot (88%): Safely catches missing punctuation, quote formats, and stray 
            // line markers, while keeping completely different songs separated accurately.
            const fuzzyMatchKey = scanCacheForFuzzyMatch(artist, title, globalSongCache, 0.88);

            if (fuzzyMatchKey) {
                const cachedTrack = globalSongCache[fuzzyMatchKey];
                let foundUri = cachedTrack.uri;
                const alternates = cachedTrack.alternate_uris || []

                if(foundUri && !foundUri.includes("spotify:track:")){
                    foundUri = `spotify:track:${foundUri}`
                    cachedTrack.uri = foundUri
                }

                cachedTrack.stations_synced = cachedTrack.stations_synced || []

                // Target property arrays check: Has THIS station already synced this track?
                const alreadySyncedOnThisStation = cachedTrack.stations_synced.includes(stationID);

                console.log(`Song already in Global Song Cache [Fuzzy Match] - artist: ${artist} title: ${title}`)

                // 🛡️ CANONICAL CROSS-REFERENCE CHECK: Does the playlist contain ANY known version of this song?
                let isAnyVariantOnPlaylist
                if(alternates.some(altUri => existingTrackUris.has(altUri))){
                    console.log(`Original track not in playlist, but alternate track is.`)
                    isAnyVariantOnPlaylist = true
                }

                if(alreadySyncedOnThisStation) {
                    // Case 1: Already searched AND already added to this specific playlist. 
                    // Completely drop from this execution loop fraction! No network action needed.
                    console.log(`⏭️ [Cache Bypass] "${title} - ${artist}" already processed on this Station.`);
                }
                else{
                    // Add your station ID to this track's historical syncing records matrix
                    if(foundUri) cachedTrack.stations_synced.push(stationID);
                }
                if(foundUri && !existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                    trackUrisToAdd.push(foundUri);
                    console.log(`✅ Song in Global Song Cache [Fuzzy Match], but not in THIS playlist. Adding to batch artist: ${artist} title: ${title}`)

                    changesMade = changesMade || !savedPendingUris.includes(foundUri)
                }
                continue;
            }

            // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
            // Save the updated object map right after this station finishes its loop logic pass
            // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
            // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
            // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
            //await flushRuntimeCacheToIndexedDb(globalSongCache);

            // 🚨 CONDITION A: Global cap reached or gate is locked -> Defer immediately
            if(syncRadioSpotifyRateLimit || !spotifySyncAllowed || (stationNetwork[currentStationNetworkAllowed].id !== stationID) || globalSearchesPerformed >= GLOBAL_SEARCH_CAP ){
                if (globalSearchesPerformed >= GLOBAL_SEARCH_CAP) {
                    console.warn(`🛑 Global Session Cap of ${GLOBAL_SEARCH_CAP} reached mid-run! Deferring remaining tracks.`);
                    spotifySyncAllowed = false
                }
                if(stationNetwork[currentStationNetworkAllowed].id !== stationID){
                    //console.log(`Current station ${stationID} not granted Spotify Search Gate`)
                }

                //This check isn't needed - we exit out if it is found
                //if(!globalSongCache[cacheKey] && !globalSongCache[fuzzyMatchKey]){
                    tracksToSaveForLater.push(item);
                    console.log(`🚨 Pushing item to tracksToSaveForLater: ${artist} title: ${title}`)
                    
                    //if this is a new track to search
                    changesMade = changesMade || !savedPending.some(p => 
                        p.TIT2?.toLowerCase() === item.TIT2?.toLowerCase() && 
                        p.TPE1?.toLowerCase() === item.TPE1?.toLowerCase()
                    );
                //}
                continue;
            }

            // B. Search Spotify with pacing
            await delay(800); 
            
            // Increment the shared global counter right before hitting the network
            globalSearchesPerformed++;
            spotifySearchPeformed = true

            console.log(`[Session Changes Global Search ${globalSearchesPerformed}/${GLOBAL_SEARCH_CAP}] Querying: ${title} - ${artist}`);

            // Search Spotify
            const query = encodeURIComponent(`track:${title} artist:${artist}`);
            const searchUrl = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`;
            const searchResponse = await fetch(searchUrl, { headers: { 'Authorization': `Bearer ${token}` } });

                // If we hit a 429, capture the header instruction or wait a full 5 seconds before retrying
                if (searchResponse.status === 429) {
                    console.warn(`🛑 Spotify Rate Limit`);
                    syncRadioSpotifyRateLimit = true
                    globalSearchesPerformed = 0
                    tracksToSaveForLater.push(item);
                    continue;
                }
            
            if (!searchResponse.ok) throw new Error(`StreamOn HTTP error! Status: ${searchResponse.status}`);

            const searchData = await searchResponse.json();
            const tracks = searchData.tracks?.items || [];
            
            if (tracks.length > 0) {
                    const foundUri = tracks[0].uri;
                    let foundartist = tracks[0].artists[0].name;
                    let foundtitle = tracks[0].name;
                    
                    // 🔄 UPDATE OR INITIALIZE TRACK RECORD LOGIC
                    if (globalSongCache[cacheKey]) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[cacheKey];
                        console.log(`✅ [New Search already in Cache]: ${title} - ${artist} -> ${foundUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = foundUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];
                        
                        // Append to variants list if it's a completely new unique ID string
                        if (cachedTrack.uri !== foundUri && !cachedTrack.alternate_uris.includes(foundUri)) {
                            cachedTrack.alternate_uris.push(foundUri);
                            console.log(`🔗 [Variant Added] Appended alternate track alias mapping: ${foundUri} to "${foundtitle}"`);
                            if(tracks[0].linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${tracks[0].linked_from?.uri} to "${foundtitle}"`);
                                cachedTrack.alternate_uris.push(tracks[0].linked_from?.uri)
                            }
                        }
                    }
                    else {
                        // Brand new record initialization structure
                        const trackPayload = {
                            found: true,
                            uri: foundUri,
                            alternate_uris: [], // Ready to collect variations on subsequent runs
                            resolved_title: foundtitle,
                            resolved_artist: foundartist,
                            stations_synced: [stationID]
                        }

                        globalSongCache[cacheKey] = trackPayload
                        pendingCloudCacheUploads[cacheKey] = trackPayload

                        if(tracks[0].linked_from?.id){
                            globalSongCache[cacheKey].alternate_uris.push(tracks[0].linked_from?.uri)
                        }

                        console.log(`✅ [New Search Cached]: ${title} - ${artist} -> ${foundUri}`);
                    }

                    foundartist = cleanMetadataString(tracks[0].artists[0].name);
                    foundtitle = cleanMetadataString(tracks[0].name);
                    //const cacheKey = `${artist}-${title}`.toLowerCase();

                    const foundfuzzyMatchKey = scanCacheForFuzzyMatch(foundartist, foundtitle, globalSongCache, 0.88);

                    if (foundfuzzyMatchKey) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[foundfuzzyMatchKey];
                        console.log(`✅ [New Search already [Fuzzy Match] in Cache]: ${title} - ${artist} -> ${foundUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = foundUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];

                        if (cachedTrack.uri !== foundUri && !cachedTrack.alternate_uris.includes(foundUri)) {
                            cachedTrack.alternate_uris.push(foundUri)
                            console.log(`🔗 [Variant Added] Appended alternate track alias [Fuzzy Match] mapping: ${foundUri} to "${foundtitle}"`);
                            if(tracks[0].linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias [Fuzzy Match] mapping: ${tracks[0].linked_from?.uri} to "${foundtitle}"`);
                                cachedTrack.alternate_uris.push(tracks[0].linked_from?.uri)
                            }
                        }
                    }
                    
                    // ✅ DUPLICATE CHECK: Skip adding to queue if it's already on your playlist
                    if (existingTrackUris.has(foundUri)) {
                        console.log(`⏭️ Skipping (Already in Playlist): ${title} - ${artist}`);
                    } 

                    // ✅ DUPLICATE CHECK: Skip adding to playlist if it's already on your playlist
                    const alternates = globalSongCache[cacheKey].alternate_uris
                    //No alternates exist - otherwise we wouldn't have gotten this far
                    let isAnyVariantOnPlaylist
                    if(alternates.some(altUri => existingTrackUris.has(altUri))){
                        console.log(`Original track not in playlist, but alternate track is.`)
                        isAnyVariantOnPlaylist = true
                    }
                    const fuzzyalternates = globalSongCache[cacheKey].alternate_uris
                    //No alternates exist - otherwise we wouldn't have gotten this far
                    let isAnyFuzzyVariantOnPlaylist
                    if(fuzzyalternates.some(altUri => existingTrackUris.has(altUri))){
                        console.log(`Original [Fuzzy Match] track not in playlist, but alternate track is.`)
                        isAnyVariantOnPlaylist = true
                    }

                    if(!existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !isAnyFuzzyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                        trackUrisToAdd.push(foundUri);
                        console.log(`✅ Found New Track: ${title} - ${artist}`);

                        changesMade = changesMade || !savedPendingUris.includes(foundUri)
                    }

                    console.log(`✅ [Search Complete] Processed: ${title} - ${artist} -> ${foundUri}`);
            }
            else {
                console.log(`❌ Not Found on Spotify: ${title} - ${artist}`);

                const trackPayload = {
                    found: false,
                    resolved_title: title,
                    resolved_artist: artist,
                    stations_searched: stationID,
                }

                globalSongCache[cacheKey] = trackPayload
                pendingCloudCacheUploads[cacheKey] = trackPayload
            }
        }

        // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
        // Save the updated object map right after this station finishes its loop logic pass
        // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
        // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
        // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
        //await flushRuntimeCacheToIndexedDb(globalSongCache);

        if((globalSearchesPerformed >= GLOBAL_SEARCH_CAP) && (stationNetwork[currentStationNetworkAllowed].id === stationID)){
            globalSearchesPerformed = 0
            spotifySyncAllowed = false
        }

        let stationWithin5 = false
        for(whichStation = currentRadioPlaylistUpdateAllowed; whichStation < currentRadioPlaylistUpdateAllowed + 5; whichStation++){
            if (stationID === stationNetwork[whichStation % stationNetwork.length].id) stationWithin5 = true
        }
        //If we didn't hit the limit, go to next station
        if(spotifySyncAllowed && (stationNetwork[currentStationNetworkAllowed].id === stationID)){
            currentStationNetworkAllowed = ((currentStationNetworkAllowed + 1) % stationNetwork.length)
        }

        // --- 3. BATCH ADD PHASE ---
        //const pendingUrisKey = `pending_uris_${stationID}`;
        let failedUris = [];

        //const savedPendingUris = JSON.parse(localStorage.getItem(pendingUrisKey)) || [];
        if (savedPendingUris.length > 0) {
            console.log(`%c Retrying ${savedPendingUris.length} pending track uris from previous run.`,"color: #ae00ffff");
            //trackUrisToAdd = [...trackUrisToAdd, ...savedPendingUris];
            // Combine both arrays and instantly filter out duplicates
            trackUrisToAdd = Array.from(new Set([...trackUrisToAdd, ...savedPendingUris]));
        }

        // 3. Add found tracks to your Spotify playlist
        if (trackUrisToAdd.length > 0) {
        if(!totalSpotifyRateLimit && stationWithin5){
            // Optional: Reverse array to keep oldest-to-newest timeline matching the radio order
            trackUrisToAdd.reverse(); 

            console.log(`%c Session Changes ${stationID}: Adding ${trackUrisToAdd.length} tracks to playlist...`, "color: #ff0000; background: #03db0e;");

            const batchSize = 100;

            for (let i = 0; i < trackUrisToAdd.length; i += batchSize) {
                const batch = trackUrisToAdd.slice(i, i + batchSize);
                const appendUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items`;

                try{
                    const appendResponse = await fetch(appendUrl, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ uris: batch })
                    });
                    
                    if (appendResponse.status === 429) {
                        totalSpotifyRateLimit = true
                        console.error("Rate limit hit during batch addition.");
                        failedUris = [...failedUris, ...batch];
                        break;
                    }
                    if (appendResponse.ok) {
                        console.log("🎉 Success! Playlist updated.");

                        // ✅ Keep the local reverse-mirror perfectly synced with Spotify's servers
                        for (const uri of batch) {
                            existingTrackUris.add(uri);
                        }
                        //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
                        await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!
                    } 
                    else {
                        const errData = await appendResponse.json();
                        console.error("Failed to add tracks to playlist:", errData);
                        failedUris = [...failedUris, ...batch];
                    }
                    
                }
                catch (err) {
                    failedUris = [...failedUris, ...batch];
                }
                    await delay(5 * 1000); 
            }
        }
        else{
            failedUris = [...failedUris, ...trackUrisToAdd];
            console.log(`Spotify rate limited. Pushing trackUrisToAdd to failedUris`)
        }
        } 
        else {
            console.log("No matching tracks were found on Spotify during this run.");
        }

        if(!totalSpotifyRateLimit && spotifyPlaylistDeDuplicateAllowed && (stationNetwork[deDuplicateStationAllowed].id === stationID)){
            spotifyPlaylistDeDuplicateAllowed = false
            console.log(`❌ Session Changes DeDuplicate spotifyPlaylistDeDuplicateAllowed - ${stationNetwork[deDuplicateStationAllowed].id}.`);
            deduplicateSpotifyPlaylist(stationNetwork[deDuplicateStationAllowed].playlistId)
            console.log(`🎯 Session Changes DeDuplicate complete spotifyPlaylistDeDuplicateAllowed - ${stationNetwork[deDuplicateStationAllowed].id}.`);
        }

        // --- 4. FINALIZE: Save Unprocessed History for next run ---
        if (tracksToSaveForLater.length > 0) {
            localStorage.setItem(pendingStorageKey, JSON.stringify(tracksToSaveForLater));
            console.log(`%c Saved pending: ${savedPendingLength}`, "color: #ea00ff")
            console.log(`%c Radio Now Playing Size: ${freshHistorySize}`, "color: #ea00ff")
            console.log(`%c Minimized Now Playing Size: ${uniqueHistory.length}`, "color: #ea00ff")
            console.log(`%c Saving for later tracks: ${tracksToSaveForLater.length}`, "color: #ea00ff")
            console.log(`%c Added ${tracksToSaveForLater.length - savedPendingLength} tracks to pending`, "color: #ea00ff")
            console.log(`%c Eliminated ${uniqueHistory.length - tracksToSaveForLater.length} tracks`, "color: #8400ffff")
        } 
        else {
            localStorage.removeItem(pendingStorageKey);
        }

        // B. Handle URIs (Items we found but couldn't add to the playlist)
        if (failedUris.length > 0) {
            localStorage.setItem(pendingUrisKey, JSON.stringify(failedUris));
            console.log(`Saving Spotify Failed Add Uris: ${failedUris.length}`)
        } else {
            localStorage.removeItem(pendingUrisKey);
        }

        console.log(`%c Session Changes ${stationID}: Playing: ${uniqueHistory.length - savedPendingLength} Pending Search: ${tracksToSaveForLater.length - savedPendingLength} Pending URIs: ${failedUris.length - savedPendingUris.length}`, "color: #00fff2; background: #585757;")
        if(changesMade) console.log(`%c Session Only Changes ${stationID}: Playing: ${uniqueHistory.length - savedPendingLength} Pending Search: ${tracksToSaveForLater.length - savedPendingLength} Pending URIs: ${failedUris.length - savedPendingUris.length}`, "color: #ffffff; background: #00aa00;")

        console.log(syncRadioSpotifyRateLimit ? "Sync partially finished." : `🎉 ${stationID} Station sync complete!`);

    } 
    catch (error) {
        console.error("Error syncing KBER playlist:", error);
    }
}
async function syncKBLQToSpotify(stationID, playlistId = 9999) {
    const token = localStorage.getItem('access_token');
    //const stationID = "KBLQ"; // SecureNet callsign identifier key
    
    console.log(`%c [KBLQ Cirrus] Fetching live history from Cache Valley Media Group (${stationID})...`, "color: #1a8cff; background: #000000;");

            // 🚨 CONDITION A: Global cap reached or gate is locked -> Defer immediately
            if(syncRadioSpotifyRateLimit || !spotifySyncAllowed || (stationNetwork[currentStationNetworkAllowed].id !== stationID) || globalSearchesPerformed >= GLOBAL_SEARCH_CAP ){
                if (globalSearchesPerformed >= GLOBAL_SEARCH_CAP) {
                    console.warn(`🛑 Global Session Cap of ${GLOBAL_SEARCH_CAP} reached mid-run! Deferring remaining tracks.`);
                }
                if(stationNetwork[currentStationNetworkAllowed].id !== stationID){
                    console.log(`Current station ${stationID} not granted Spotify Search Gate`)
                }
            }

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const pendingMetadataKey = `pending_tracks_${stationID}`;
    const pendingUrisKey = `pending_uris_${stationID}`;
    const mirrorKey = `playlist_mirror_${stationID}`;

    // --- STEP 1: PREPARE AND RESTORE TRACK QUEUES ---
    let savedPendingUris = JSON.parse(localStorage.getItem(pendingUrisKey)) || [];
    let trackUrisToAdd = []
    //let savedPendingUrisLength = trackUrisToAdd.length
    if (savedPendingUris.length > 0) {
        console.log(`%c Retrying ${savedPendingUris.length} pending track uris from previous run.`,"color: #ae00ffff");
        // Combine both arrays and instantly filter out duplicates
        trackUrisToAdd = Array.from(new Set([...trackUrisToAdd, ...savedPendingUris]));
    }

    let savedPendingMetadata = JSON.parse(localStorage.getItem(pendingMetadataKey)) || [];
    const savedPendingLength = savedPendingMetadata.length

    
    let totalMetadataQueue = []
    let freshHistorySize = 0;
    let changesMade = false

    if (savedPendingUris.length > 0) console.log(`%c Found ${savedPendingUris.length} URIs saved from a previous add-failure.`,"color: #ae00ffff");
    if (savedPendingLength > 0){
        console.log(`%c Retrying ${savedPendingLength} unsearched metadata tracks from previous rate-limit.`, "color: #0099ffff");
        totalMetadataQueue = [...savedPendingMetadata];
    }

        let newStationSearchAllowed = true;
        // if(totalMetadataQueue.length > 150){
        //     newStationSearchAllowed = false;
        //     console.log(`%c Pending queue > 150 tracks - skipping Station Play History Search.`, "color: #0000; backround: #ff7300ff;")
        // }


    try {

if(newStationSearchAllowed){
    // Target the SecureNet Systems player status update endpoint
    
    // ✅ DYNAMIC SERVER ROUTER: Assigns 'streamdb5web' for KKEX, otherwise defaults to 'streamdb7web'
    // That modern country payload correlates to 94.5 K-EX (KKEX-FM) based in Eastern Oregon, which is completely 
    // different from 101.9 The Ranch (KKEX-HD3) in Utah.SecureNet Systems hosts both stations, but because they are 
    // entirely different accounts, they are separated on two different server blocks:
    // 🔍 The Station Matrix Confusion streamdb7web + "KKEX": Connects to 94.5 K-EX (KKEX) in Oregon. 
    // They play mainstream Modern Country (Luke Combs, Morgan Wallen, Lainey Wilson).
    // streamdb5web + "KKEX3": Connects to 101.9 HD3 The Ranch (KKEX-HD3) in Utah. 
    // They play Texas/Red Dirt & Classic Country (Cody Jinks, Aaron Watson, George Strait).
    //const serverSubdomain = (stationID === "KKEX" || stationID === "KKEX3") ? "streamdb5web" : "streamdb7web";
    let serverSubdomain = ((stationID === "KKEX3") || (stationID === "KCLS"))? "streamdb5web" : "streamdb7web";
    if(stationID === "KRQX"){
        serverSubdomain = "streamdb8web"
    }
    
    const targetUrl = `https://${serverSubdomain}.securenetsystems.net/player_status_update/${stationID}_history.xml`;

    const proxyList = [
        "https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent(targetUrl),
        //`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,
        //`https://corsproxy.io/?url=${targetUrl}`,
        //`https://thingproxy.freeboard.io/fetch/${targetUrl}`,
        //`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
        //`https://cors-anywhere.herokuapp.com/${targetUrl}`,
        // `https://proxy.cors.sh/${targetUrl}`
    ];

    let rawContent = "";    
    let fetchSuccessful = false;

    // Proxy traversal loop
    for (const proxyUrl of proxyList) {
        try {
            const domainLabel = proxyUrl.split('/')[2];
           // console.log(`Attempting connection via proxy: ${domainLabel}...`);
                    console.log(`%c ${stationID} Attempting connection via: ${proxyUrl.split('/')[2]}...`, "color: #00c020;");
                    console.log(`proxyUrl: ${proxyUrl}`)
            const response = await fetch(proxyUrl);
            if (!response.ok){
                console.log(`${stationID} Proxy failed ${proxyUrl}`)
                continue; // If this proxy errors, loop immediately to the next one
            }

            if (proxyUrl.includes("allorigins")) {
                const proxyData = await response.json();
                rawContent = proxyData.contents;
            }
            else {
                rawContent = await response.text();
            }
            
            // 🔍 ADD THIS LOGGING LINE HERE:
            console.log(`[DEBUG] Raw proxy payload length: ${rawContent ? rawContent.length : 0}. First 3000 chars:`, rawContent ? rawContent.substring(0, 3000) : "EMPTY");
            
            // if (rawContent && rawContent.trim().startsWith("<?xml")) {
            //     fetchSuccessful = true;
            //     console.log(`🎉 Connection established via ${proxyUrl.split('/')}!`);
            //     break; 
            // }          
            // ✅ FIX: Accept standard JSON or any root XML tag, while safely rejecting HTML error pages
            // const trimmedContent = rawContent ? rawContent.trim() : "";
            // if (trimmedContent && !trimmedContent.toLowerCase().startsWith("<!doctype") && !trimmedContent.toLowerCase().startsWith("<html")) {
            //     if (trimmedContent.startsWith("{") || trimmedContent.startsWith("<")) {
            //         fetchSuccessful = true;
            //         console.log(`🎉 Connection established via ${proxyUrl.split('/')}!`);
            //         break; 
            //     }
            // }
            // // ✅ SAFE XML VALIDATOR: Accept any content starting with '<' as long as it's not an HTML error layout
            // const trimmedContent = rawContent ? rawContent.trim() : "";
            // if (trimmedContent && trimmedContent.startsWith("<") && !trimmedContent.toLowerCase().startsWith("<!doctype") && !trimmedContent.toLowerCase().startsWith("<html")) {
            //     fetchSuccessful = true;
            //         console.log(`🎉 Connection established via ${proxyUrl.split('/')}!`);
            //     break; 
            // } 
            // ✅ BROWSER-SAFE VALIDATOR: Look for a bracket anywhere in the text while dropping standard error screens
            const trimmedContent = rawContent ? rawContent.trim() : "";
            if (trimmedContent && !trimmedContent.toLowerCase().startsWith("<!doctype") && !trimmedContent.toLowerCase().startsWith("<html")) {
                
                // Use a RegExp test to see if the first character (ignoring hidden space/line markers) is a bracket
                if (/^[<{\[]/.test(trimmedContent)) {
                    fetchSuccessful = true;
                    console.log(`🎉 Connection established via ${proxyUrl.split('/')[2]}!`);
                    break; 
                }
            }
 
      
        } catch (e) {
            console.warn(`⚠️ Proxy line failed or timed out.`);
        }
    }

    if (!fetchSuccessful || !rawContent) {
        console.error("❌ Critical: All public proxies failed to pull XML from SecureNet.");
        //return;
    }

        let freshHistory = [];
    if(fetchSuccessful && rawContent){


        // --- STEP 2: PARSE SECURENET SYSTEMS HISTORY NODES ---
        const trimmed = rawContent.trim();

        // 🅰️ IF THE PROXY RETURNED JSON OBJECT DATA
        if (trimmed.startsWith("{")) {
            const jsonData = JSON.parse(trimmed);
            // SecureNet JSON arrays sit under history or playlist keys
            const jsonTracks = jsonData.history || jsonData.playlist?.song || [];
            const tracksArray = Array.isArray(jsonTracks) ? jsonTracks : [jsonTracks];
            
            for (const t of tracksArray) {
                const title = t.title || t.titleText;
                const artist = t.artist || t.artistText;
                if (title && artist && title.toLowerCase() !== "advertisement") {
                    freshHistory.push({ TIT2: title.trim(), TPE1: artist.trim(), TXXX_category: 'music' });
                }
            }
        } 
        // 🅱️ IF THE PROXY RETURNED AN XML TEXT STREAM
        else if (trimmed.startsWith("<") || trimmed.includes("<playHistory>")) {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(rawContent, "text/xml");
            const xmlSongs = xmlDoc.getElementsByTagName("song");
            
            for (let i = 0; i < xmlSongs.length; i++) {
                const item = xmlSongs[i];
                
                // Extract and clean title text
                let title = item.querySelector("title")?.textContent?.trim() || "";
                title = title.replace(/["']/g, ""); // Removes any rogue single or double quotes
                
                // Extract and clean artist text (Converts Lady "a" to Lady a)
                let artist = item.querySelector("artist")?.textContent?.trim() || "";
                artist = artist.replace(/["']/g, ""); // Strips quote wrappers cleanly
                
                if (title && artist && title.toLowerCase() !== "advertisement") {
                    freshHistory.push({ TIT2: title, TPE1: artist, TXXX_category: 'music' });
                }
            }
        }

    }


//console.log(`freshHistory: ${freshHistory}`)

        if (freshHistory.length === 0) {
            console.log(`No historical tracks found in the ${stationID} feed array data.`);
        }

        freshHistorySize = freshHistory.length
        console.log(`Radio Now Playing Size: ${freshHistorySize}`)

        // Merge backlogged items with newly pulled entries
        totalMetadataQueue = [...totalMetadataQueue, ...freshHistory];
}
        // Universal unique filter array
        const uniqueHistory = Array.from(new Set(totalMetadataQueue.map(s => JSON.stringify(s)))).map(s => JSON.parse(s));
//console.log(`uniqueHistory: ${uniqueHistory}`)
//console.log(uniqueHistory.keys)

        console.log(`%c Minimized Now Playing Size: ${uniqueHistory.length}`, "color: #ea00ff")

        let existingTrackUris = new Set();
        let nextPageUrl = ""
	
        const mirrorKey = `playlist_mirror_${stationID}`;

        // ✅ 100% Network-free startup pull!
        //let existingCachedTrackUris = new Set(JSON.parse(localStorage.getItem(mirrorKey)) || []);
        // 🚀 New IndexedDB layout (Make sure the enclosing function is marked as 'async'):
        let existingCachedTrackUris = new Set(await getPlaylistMirrorIndexedDB(mirrorKey) || []);

        if (existingCachedTrackUris.size === 0) {
            console.log(`📡 Mirror miss! Fetching playlist catalog from Spotify servers for ${stationID}...`);

            // Execute your standard full-playlist pagination loop here to fetch from Spotify
            // ... (Your existing code to populate existingTrackUris from Spotify) ...

            // Save it to localStorage so you never have to make this API fetch again!
            //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
            await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!
        } else {
            console.log(`🎯 Mirror hit! Instantly loaded ${existingCachedTrackUris.size} tracks locally for ${stationID}. Zero API cost.`);
        }

        if(!totalSpotifyRateLimit && (spotifyPlaylistDownloadAllowed || spotifyPlaylistDownloadSmallAllowed) && (stationNetwork[beginningStationNetworkAllowed].id === stationID)){
            if(spotifyPlaylistDownloadAllowed || existingCachedTrackUris.size <= 300){
                spotifyPlaylistDownloadAllowed = false
                // Start with the initial 100-item page endpoint
                nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;
            }
            else{
                startingOffset = (Math.floor(existingCachedTrackUris.size / 100) * 100) - 200
                            //https://api.spotify.com/v1/playlists/2yBlKOrxYIkY7UUqTObxI9/items?offset=500&limit=100&locale=en-US,en
                nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?offset=${startingOffset}&?limit=100&locale=en-US,en`;
            }
            spotifyPlaylistDownloadSmallAllowed = false
            console.log(`❌ Session Changes spotifyPlaylistDownloadAllowed - ${stationNetwork[beginningStationNetworkAllowed].id}. size=${existingCachedTrackUris.size} offset=${startingOffset}`);

        // ✅ STEP 1.5: Fetch existing tracks from the Spotify playlist to prevent duplicates
        console.log(`Loading entire track catalog for playlist: ${playlistId}...`);
        
        // 🔄 Pagination Loop: Keep crawling pages until nextPageUrl turns null
        while (nextPageUrl) {
            try {
                const playlistResponse = await fetch(nextPageUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (!playlistResponse.ok) {
                    console.error(`⚠️ Playlist fetch interrupted! Status: ${playlistResponse.status}`);
                    if(playlistResponse.status === 401){
                        await delay(30 * 1000); 
                        continue;
                    }
                    else{
                        totalSpotifyRateLimit = true
                        break;
                    }
                }

                const playlistData = await playlistResponse.json();
        console.log("--- FULL HISTORY DATA STRUCTURE ---");
console.dir(playlistData.items, { depth: null });
                const items = playlistData.items || [];

                // Extract and add found URIs directly into your lookup Set
                for (const i of items) {
                    const uri = i.item?.uri || i.track?.uri;
                    const track = i.track || i.item;

                    // Extract official resolved text fields natively from Spotify's schema layout keys
                    const spotifyTitle = track.name || "Unknown Title";
                    const spotifyArtist = track.artists?.[0]?.name || "Unknown Artist";
                    const trackUri = track.uri;

                    if (uri){
                        //if it's not already in the cached existing track uris
                        if(!existingCachedTrackUris.has(uri)) existingTrackUris.add(uri);
                    }

                    // 🧼 Run your pre-processor function to generate the unified lowercase cache key slug
                    const cleanArtist = cleanMetadataString(spotifyArtist);
                    const cleanTitle = cleanMetadataString(spotifyTitle);
                    const cacheKey = `${cleanArtist}-${cleanTitle}`.toLowerCase();

                    // Check if this song footprint keys exist yet inside our storage block
                    if (globalSongCache[cacheKey]) {
                        const record = globalSongCache[cacheKey];
                        //console.log(`✅ [Playlist History song already in Cache]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);

                        if(!record.found) record.found = true

                        if(!record.uri) record.uri = trackUri

                        // Track station affiliation mapping: Ensure stationID is attached to historical sync lists
                        record.stations_synced = record.stations_synced || []
                        if (!record.stations_synced.includes(stationID)) {
                            record.stations_synced.push(stationID);
                        }

                        // Canonical checking: Ensure the found URI is linked to your alternates array registry
                        if (record.uri !== trackUri && !record.alternate_uris.includes(trackUri)) {
                            record.alternate_uris.push(trackUri);
                            console.log(`🔗 [Variant Linked] Appended alternate track alias mapping: ${trackUri} to "${spotifyTitle}"`);
                            if(track.linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                                record.alternate_uris.push(track.linked_from?.uri)
                            }
                        }
                    } 
                    else {
                        // Initialize a brand new persistent cache schematic entry object mapping
                        const trackPayload = {
                            found: true,
                            uri: trackUri,
                            alternate_uris: [],
                            resolved_title: spotifyTitle,
                            resolved_artist: spotifyArtist,
                            stations_synced: [stationID]
                        }

                        globalSongCache[cacheKey] = trackPayload
                        pendingCloudCacheUploads[cacheKey] = trackPayload

                        if(track.linked_from?.id){
                            console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                            record.alternate_uris.push(track.linked_from?.uri)
                        }
                        console.log(`✅ [Playlist History New Song Cached]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);
                    }

                    const foundfuzzyMatchKey = scanCacheForFuzzyMatch(cleanArtist, cleanTitle, globalSongCache, 0.88);

                    if (foundfuzzyMatchKey) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[foundfuzzyMatchKey];
                        //console.log(`✅ [Playlist History song already [Fuzzy Match] in Cache]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = trackUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];

                        if (cachedTrack.uri !== trackUri && !cachedTrack.alternate_uris.includes(trackUri)) {
                            cachedTrack.alternate_uris.push(trackUri)
                            console.log(`🔗 [Variant Added] Appended alternate track alias [Fuzzy Match] mapping: ${trackUri} to "${spotifyTitle}"`);
                            if(track.linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate [Fuzzy Match] track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                                cachedTrack.alternate_uris.push(track.linked_from?.uri)
                            }
                        }
                    }
                }

                // 🧭 Navigation checkpoint: Update the URL to the next page, or null to terminate
                nextPageUrl = playlistData.next; 

                // Optional: Print progress updates if dealing with massive lists
                if (nextPageUrl) {
                    console.log(`...Loaded ${existingTrackUris.size} tracks so far. Moving to next page...`);
                    // Tiny 100ms pause to ensure your pagination loop doesn't slam the endpoint
                    await delay(800); 
                }
            } catch (err) {
                console.error("❌ Exception encountered while fetching playlist tracks:", err);
                break;
            }
        }
        console.log(`🎯 Session Changes Complete! Final deduplication set populated with ${existingTrackUris.size} total tracks.`);
        }
        // else{
        //     const mirrorKey = `playlist_mirror_${stationID}`;

        //     // ✅ 100% Network-free startup pull!
        //     existingTrackUris = new Set(JSON.parse(localStorage.getItem(mirrorKey)) || []);

        //     if (existingTrackUris.size === 0) {
        //         console.log(`📡 Mirror miss! Fetching playlist catalog from Spotify servers for ${stationID}...`);
                
        //         // Execute your standard full-playlist pagination loop here to fetch from Spotify
        //         // ... (Your existing code to populate existingTrackUris from Spotify) ...
                
        //         // Save it to localStorage so you never have to make this API fetch again!
        //         localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingTrackUris)));
        //     } else {
        //         console.log(`🎯 Mirror hit! Instantly loaded ${existingTrackUris.size} tracks locally for ${stationID}. Zero API cost.`);
        //     }
        // }

        //concatenate cached uris with any ones from actual playlist that weren't already captured
        existingTrackUris = existingTrackUris.union(existingCachedTrackUris);

        // Save it to localStorage so you never have to make this API fetch again!
        //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
        await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!

        console.log(`Playlist currently contains ${existingTrackUris.size} tracks. Searching for new additions...`);

        // --- STEP 3: SEARCH TIMELINE WITH ACCOUNT THROTTLE FLAGS ---
        let metadataToSaveForLater = [];

            if(!spotifySyncAllowed) {
                console.log(`%c ⏳ Spotify Search Gate Locked. Skipping API calls for another ${spotifySyncMinutesRemaining} minutes. Accumulating items in LocalStorage.`, "color: #83621aff; background: #b6b5b5ff");
            }
            else {
                console.log(`%c 🔓 Spotify Search Gate Open! Proceeding with live track queries...`, "color: #d9ff00ff; background: #005f00;");
                // Update the timestamp only when a full search run is allowed to start
                
                //localStorage.setItem(pacingKey, Date.now().toString());
            }

        spotifySearchPeformed = false

        for (const item of uniqueHistory) {
            // 🧼 RUN PRE-PROCESSOR: Clean and normalize raw station inputs instantly
            // ✅ Use the ID3 metadata tags (TIT2 and TPE1)
            const rawArtist = item.TPE1?.trim() || "";
            const rawTitle = item.TIT2?.trim() || "";
            if (!rawArtist || !rawTitle) continue;

            const artist = cleanMetadataString(rawArtist);
            const title = cleanMetadataString(rawTitle);
            const cacheKey = `${artist}-${title}`.toLowerCase();

            if (!artist || !title) continue;
            console.log(`artist: ${artist} title: ${title}`)

            // Check Global Session Cache First
            // 🅰️ CHECK 1: Strict Direct Key Match Check
            if (globalSongCache[cacheKey]) {
                const cachedTrack = globalSongCache[cacheKey];
                let foundUri = cachedTrack.uri;
                const alternates = cachedTrack.alternate_uris || []

                if(foundUri && !foundUri.includes("spotify:track:")){
                    foundUri = `spotify:track:${foundUri}`
                    cachedTrack.uri = foundUri
                }

                cachedTrack.stations_synced = cachedTrack.stations_synced || []

                // Target property arrays check: Has THIS station already synced this track?
                const alreadySyncedOnThisStation = cachedTrack.stations_synced.includes(stationID);

                console.log(`Song already global song cache - artist: ${artist} title: ${title}`)

                // 🛡️ CANONICAL CROSS-REFERENCE CHECK: Does the playlist contain ANY known version of this song?
                let isAnyVariantOnPlaylist
                if(alternates.some(altUri => existingTrackUris.has(altUri))){
                    console.log(`Original track not in playlist, but alternate track is.`)
                    isAnyVariantOnPlaylist = true
                }

                if(alreadySyncedOnThisStation) {
                    // Case 1: Already searched AND already added to this specific playlist. 
                    // Completely drop from this execution loop fraction! No network action needed.
                    console.log(`⏭️ [Cache Bypass] "${title} - ${artist}" already processed on this Station.`);
                }
                else {
                    // Mark this station ID inside the global cache array matrix immediately
                    if(foundUri) cachedTrack.stations_synced.push(stationID);
                }

                if(foundUri && !existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                    trackUrisToAdd.push(foundUri);
                    console.log(`✅ Song in Global Song Cache, but not in THIS playlist. Adding to batch artist: ${artist} title: ${title}`)

                    changesMade = changesMade || !savedPendingUris.includes(foundUri)
                }
                console.log(`Song already added this session, skipping artist: ${artist} title: ${title}`)
                continue; //It's in cache, no need to search for it
            }

            // 🅱️ CHECK 2: Fuzzy Cache Scanner Intercept
            // Threshold set to 0.88 (88% similarity) to catch typos while protecting accuracy
            // Why an 88% Threshold is the Sweet Spot
            // Setting the similarity threshold requires balancing coverage and precision:
            // Too High (e.g., 98%): Misses basic variations like Lady "a" vs Lady A.
            // Too Low (e.g., 70%): Risk falsely auto-mapping distinct tracks with similar title structures 
            // (e.g., matching Guns N' Roses - Live and Let Die to Paul McCartney - Live and Let Die).
            // The Sweet Spot (88%): Safely catches missing punctuation, quote formats, and stray 
            // line markers, while keeping completely different songs separated accurately.
            const fuzzyMatchKey = scanCacheForFuzzyMatch(artist, title, globalSongCache, 0.88);

            if (fuzzyMatchKey) {
                const cachedTrack = globalSongCache[fuzzyMatchKey];
                let foundUri = cachedTrack.uri;
                const alternates = cachedTrack.alternate_uris || []

                if(foundUri && !foundUri.includes("spotify:track:")){
                    foundUri = `spotify:track:${foundUri}`
                    cachedTrack.uri = foundUri
                }

                cachedTrack.stations_synced = cachedTrack.stations_synced || []

                // Target property arrays check: Has THIS station already synced this track?
                const alreadySyncedOnThisStation = cachedTrack.stations_synced.includes(stationID);

                console.log(`Song already in Global Song Cache [Fuzzy Match] - artist: ${artist} title: ${title}`)

                // 🛡️ CANONICAL CROSS-REFERENCE CHECK: Does the playlist contain ANY known version of this song?
                let isAnyVariantOnPlaylist
                if(alternates.some(altUri => existingTrackUris.has(altUri))){
                    console.log(`Original track not in playlist, but alternate track is.`)
                    isAnyVariantOnPlaylist = true
                }

                if(alreadySyncedOnThisStation) {
                    // Case 1: Already searched AND already added to this specific playlist. 
                    // Completely drop from this execution loop fraction! No network action needed.
                    console.log(`⏭️ [Cache Bypass] "${title} - ${artist}" already processed on this Station.`);
                }
                else{
                    // Add your station ID to this track's historical syncing records matrix
                    if(foundUri) cachedTrack.stations_synced.push(stationID);
                }
                if(foundUri && !existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                    trackUrisToAdd.push(foundUri);
                    console.log(`✅ Song in Global Song Cache [Fuzzy Match], but not in THIS playlist. Adding to batch artist: ${artist} title: ${title}`)

                    changesMade = changesMade || !savedPendingUris.includes(foundUri)
                }
                continue;
            }

            // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
            // Save the updated object map right after this station finishes its loop logic pass
            // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
            // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
            // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
            //await flushRuntimeCacheToIndexedDb(globalSongCache);

            // 🚨 CONDITION A: Global cap reached or gate is locked -> Defer immediately
            if(syncRadioSpotifyRateLimit || !spotifySyncAllowed || (stationNetwork[currentStationNetworkAllowed].id !== stationID) || globalSearchesPerformed >= GLOBAL_SEARCH_CAP ){
                if (globalSearchesPerformed >= GLOBAL_SEARCH_CAP) {
                    console.warn(`🛑 Global Session Cap of ${GLOBAL_SEARCH_CAP} reached mid-run! Deferring remaining tracks.`);
                    spotifySyncAllowed = false
                }
                if(stationNetwork[currentStationNetworkAllowed].id !== stationID){
                    //console.log(`Current station ${stationID} not granted Spotify Search Gate`)
                }

                //This check isn't needed - we exit out if it is found
                //if(!globalSongCache[cacheKey] && !globalSongCache[fuzzyMatchKey]){
                    metadataToSaveForLater.push(item);
                    console.log(`🚨 Pushing item to tracksToSaveForLater: ${artist} title: ${title}`)

                    //if this is a new track to search
                    changesMade = changesMade || !savedPendingMetadata.some(p => 
                        p.TIT2?.toLowerCase() === item.TIT2?.toLowerCase() && 
                        p.TPE1?.toLowerCase() === item.TPE1?.toLowerCase()
                    );
                //}
                continue;
            }

            // Paced linear query delay
            await delay(800);

            // Increment the shared global counter right before hitting the network
            globalSearchesPerformed++;
            spotifySearchPeformed = true

            console.log(`[Session Changes Global Search ${globalSearchesPerformed}/${GLOBAL_SEARCH_CAP}] Querying: ${title} - ${artist}`);

            const query = encodeURIComponent(`track:${title} artist:${artist}`);
            const searchUrl = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`;
            const searchResponse = await fetch(searchUrl, { headers: { 'Authorization': `Bearer ${token}` } });

            if (searchResponse.status === 429) {
                console.warn(`🛑 Spotify search rate limit hit on ${stationID}. Deferring remaining metadata rows.`);
                syncRadioSpotifyRateLimit = true;
                globalSearchesPerformed = 0
                metadataToSaveForLater.push(item);
                continue;
            }

            if (searchResponse.ok) {
                const searchData = await searchResponse.json();
                const tracks = searchData.tracks?.items || [];
                if (tracks.length > 0) {
                    const foundUri = tracks[0].uri;
                    let foundartist = tracks[0].artists[0].name;
                    let foundtitle = tracks[0].name;
                    
                    // 🔄 UPDATE OR INITIALIZE TRACK RECORD LOGIC
                    if (globalSongCache[cacheKey]) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[cacheKey];
                        console.log(`✅ [New Search already in Cache]: ${title} - ${artist} -> ${foundUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = foundUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];
                        
                        // Append to variants list if it's a completely new unique ID string
                        if (cachedTrack.uri !== foundUri && !cachedTrack.alternate_uris.includes(foundUri)) {
                            cachedTrack.alternate_uris.push(foundUri);
                            console.log(`🔗 [Variant Added] Appended alternate track alias mapping: ${foundUri} to "${foundtitle}"`);
                            if(tracks[0].linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${tracks[0].linked_from?.uri} to "${foundtitle}"`);
                                cachedTrack.alternate_uris.push(tracks[0].linked_from?.uri)
                            }
                        }
                    }
                    else {
                        // Brand new record initialization structure
                        const trackPayload = {
                            found: true,
                            uri: foundUri,
                            alternate_uris: [], // Ready to collect variations on subsequent runs
                            resolved_title: foundtitle,
                            resolved_artist: foundartist,
                            stations_synced: [stationID]
                        }

                        globalSongCache[cacheKey] = trackPayload
                        pendingCloudCacheUploads[cacheKey] = trackPayload

                        if(tracks[0].linked_from?.id){
                            globalSongCache[cacheKey].alternate_uris.push(tracks[0].linked_from?.uri)
                        }

                        console.log(`✅ [New Search Cached]: ${title} - ${artist} -> ${foundUri}`);
                    }

                    foundartist = cleanMetadataString(tracks[0].artists[0].name);
                    foundtitle = cleanMetadataString(tracks[0].name);
                    //const cacheKey = `${artist}-${title}`.toLowerCase();

                    const foundfuzzyMatchKey = scanCacheForFuzzyMatch(foundartist, foundtitle, globalSongCache, 0.88);

                    if (foundfuzzyMatchKey) {
                        // Entry already exists, meaning this live search discovered an alternative variant link
                        const cachedTrack = globalSongCache[foundfuzzyMatchKey];
                        console.log(`✅ [New Search already [Fuzzy Match] in Cache]: ${title} - ${artist} -> ${foundUri}`);

                        if(!cachedTrack.found) cachedTrack.found = true

                        if(!cachedTrack.uri) cachedTrack.uri = foundUri

                        cachedTrack.stations_synced = cachedTrack.stations_synced || []
                        if (!cachedTrack.stations_synced.includes(stationID)) {
                            cachedTrack.stations_synced.push(stationID);
                        }

                        if (!cachedTrack.alternate_uris) cachedTrack.alternate_uris = [];

                        if (cachedTrack.uri !== foundUri && !cachedTrack.alternate_uris.includes(foundUri)) {
                            cachedTrack.alternate_uris.push(foundUri)
                            console.log(`🔗 [Variant Added] Appended alternate track alias [Fuzzy Match] mapping: ${foundUri} to "${foundtitle}"`);
                            if(tracks[0].linked_from?.id){
                                console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias [Fuzzy Match] mapping: ${tracks[0].linked_from?.uri} to "${foundtitle}"`);
                                cachedTrack.alternate_uris.push(tracks[0].linked_from?.uri)
                            }
                        }
                    }
                    
                    // ✅ DUPLICATE CHECK: Skip adding to queue if it's already on your playlist
                    if (existingTrackUris.has(foundUri)) {
                        console.log(`⏭️ Skipping (Already in Playlist): ${title} - ${artist}`);
                    } 

                    // ✅ DUPLICATE CHECK: Skip adding to playlist if it's already on your playlist
                    const alternates = globalSongCache[cacheKey].alternate_uris
                    //No alternates exist - otherwise we wouldn't have gotten this far
                    let isAnyVariantOnPlaylist
                    if(alternates.some(altUri => existingTrackUris.has(altUri))){
                        console.log(`Original track not in playlist, but alternate track is.`)
                        isAnyVariantOnPlaylist = true
                    }
                    const fuzzyalternates = globalSongCache[cacheKey].alternate_uris
                    //No alternates exist - otherwise we wouldn't have gotten this far
                    let isAnyFuzzyVariantOnPlaylist
                    if(fuzzyalternates.some(altUri => existingTrackUris.has(altUri))){
                        console.log(`Original [Fuzzy Match] track not in playlist, but alternate track is.`)
                        isAnyVariantOnPlaylist = true
                    }

                    if(!existingTrackUris.has(foundUri) && !isAnyVariantOnPlaylist && !isAnyFuzzyVariantOnPlaylist && !trackUrisToAdd.includes(foundUri)) {
                        trackUrisToAdd.push(foundUri);
                        console.log(`✅ Found New Track: ${title} - ${artist}`);

                        changesMade = changesMade || !savedPendingUris.includes(foundUri)
                    }

                    console.log(`✅ [Search Complete] Processed: ${title} - ${artist} -> ${foundUri}`);
                }
                else {
                    console.log(`❌ Not Found on Spotify: ${title} - ${artist}`);

                    const trackPayload = {
                        found: false,
                        resolved_title: title,
                        resolved_artist: artist,
                        stations_searched: stationID,
                    }

                    globalSongCache[cacheKey] = trackPayload
                    pendingCloudCacheUploads[cacheKey] = trackPayload
                }
            }
            else {
                console.log(`⚠️ Search failed for: ${title} - ${artist} (Status: ${searchResponse.status})`);
            }
        }

        // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
        // Save the updated object map right after this station finishes its loop logic pass
        // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
        // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
        // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
        //await flushRuntimeCacheToIndexedDb(globalSongCache);

        if((globalSearchesPerformed >= GLOBAL_SEARCH_CAP) && (stationNetwork[currentStationNetworkAllowed].id === stationID)){
            globalSearchesPerformed = 0
            spotifySyncAllowed = false
        }

        let stationWithin5 = false
        for(whichStation = currentRadioPlaylistUpdateAllowed; whichStation < currentRadioPlaylistUpdateAllowed + 5; whichStation++){
            if (stationID === stationNetwork[whichStation % stationNetwork.length].id) stationWithin5 = true
        }
        //If we didn't hit the limit, go to next station
        if(spotifySyncAllowed && (stationNetwork[currentStationNetworkAllowed].id === stationID)){
            currentStationNetworkAllowed = ((currentStationNetworkAllowed + 1) % stationNetwork.length)
        }

        if (savedPendingUris.length > 0) {
            console.log(`%c Retrying ${savedPendingUris.length} pending track uris from previous run.`,"color: #ae00ffff");
        }

        // --- STEP 4: BULK REVERSAL BATCH INJECTION (100 Max) ---
        let failedUris = [];

        if (trackUrisToAdd.length > 0) {
        if(!totalSpotifyRateLimit && stationWithin5){
            trackUrisToAdd.reverse(); 

            console.log(`%c Session Changes ${stationID}: Adding ${trackUrisToAdd.length} tracks to playlist...`, "color: #ff0000; background: #03db0e;");

            const batchSize = 100;

            for (let i = 0; i < trackUrisToAdd.length; i += batchSize) {
                const batch = trackUrisToAdd.slice(i, i + batchSize);
                const appendUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items`;
                
                try {
                    const appendResponse = await fetch(appendUrl, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ uris: batch })
                    });
                    
                    if (appendResponse.status === 429) {
                        totalSpotifyRateLimit = true
                        console.error(`🛑 Rate limit hit during ${stationID} batch update execution.`);
                        failedUris = [...failedUris, ...batch];
                        break; 
                    }
                    if (appendResponse.ok) {
                        console.log("🎉 Success! Playlist updated.");

                        // ✅ Keep the local reverse-mirror perfectly synced with Spotify's servers
                        for (const uri of batch) {
                            existingTrackUris.add(uri);
                        }
                        //localStorage.setItem(mirrorKey, JSON.stringify(Array.from(existingCachedTrackUris)));
                        await setPlaylistMirrorIndexedDB(mirrorKey, Array.from(existingCachedTrackUris)); // Much cleaner, no stringify needed!
                    } 
                    else {
                        const errData = await appendResponse.json();
                        console.error("Failed to add tracks to playlist:", errData);
                        failedUris = [...failedUris, ...batch];
                    }
                } catch (err) {
                    failedUris = [...failedUris, ...batch];
                }
                    await delay(5 * 1000); 
            }
        }
        else{
            failedUris = [...failedUris, ...trackUrisToAdd];
            console.log(`Spotify rate limited. Pushing trackUrisToAdd to failedUris`)
        }
        }
        else {
            console.log("No matching tracks were found on Spotify during this run.");
        }

        if(!totalSpotifyRateLimit && spotifyPlaylistDeDuplicateAllowed && (stationNetwork[deDuplicateStationAllowed].id === stationID)){
            spotifyPlaylistDeDuplicateAllowed = false
            console.log(`❌ Session Changes DeDuplicate spotifyPlaylistDeDuplicateAllowed - ${stationNetwork[deDuplicateStationAllowed].id}.`);
            deduplicateSpotifyPlaylist(stationNetwork[deDuplicateStationAllowed].playlistId)
            console.log(`🎯 Session Changes DeDuplicate complete spotifyPlaylistDeDuplicateAllowed - ${stationNetwork[deDuplicateStationAllowed].id}.`);
        }

        // --- STEP 5: FINAL LOCAL STORAGE WRITEBACK ---
        if (metadataToSaveForLater.length > 0) {
            localStorage.setItem(pendingMetadataKey, JSON.stringify(metadataToSaveForLater));
            console.log(`%c Saved pending: ${savedPendingLength}`, "color: #ea00ff")
            console.log(`%c Radio Now Playing Size: ${freshHistorySize}`, "color: #ea00ff")
            console.log(`%c Minimized Now Playing Size: ${uniqueHistory.length}`, "color: #ea00ff")
            console.log(`%c Saving for later tracks: ${metadataToSaveForLater.length}`, "color: #ea00ff")
            console.log(`%c Added ${metadataToSaveForLater.length - savedPendingLength} tracks to pending`, "color: #ea00ff")
            console.log(`%c Eliminated ${uniqueHistory.length - metadataToSaveForLater.length} tracks`, "color: #8400ffff")
        }
        else {
            localStorage.removeItem(pendingMetadataKey);
        }

        if (failedUris.length > 0) {
            localStorage.setItem(pendingUrisKey, JSON.stringify(failedUris));
            console.log(`Saving Spotify Failed Add Uris: ${failedUris.length}`)
        } 
        else {
            localStorage.removeItem(pendingUrisKey);
        }

        console.log(`%c Session Changes ${stationID}: Playing: ${uniqueHistory.length - savedPendingLength} Pending Search: ${metadataToSaveForLater.length - savedPendingLength} Pending URIs: ${failedUris.length - savedPendingUris.length}`, "color: #00fff2; background: #585757;")
        if(changesMade) console.log(`%c Session Only Changes ${stationID}: Playing: ${uniqueHistory.length - savedPendingLength} Pending Search: ${metadataToSaveForLater.length - savedPendingLength} Pending URIs: ${failedUris.length - savedPendingUris.length}`, "color: #ffffff; background: #00aa00;")

        console.log(syncRadioSpotifyRateLimit ? "Sync partial." : `🎉 ${stationID} Station sync complete!`);

    } catch (error) {
        console.error("Critical parsing error processing " + stationID + " payload tree:", error);
    }
}
async function discoverU92Callsign() {
    console.log("Searching for U92's hidden SecureNet stream ID...");
    const proxy = `https://api.allorigins.win/get?url=`
    //const searchUrl = encodeURIComponent(`https://streamdb7web.securenetsystems.net/v1/search/stations?query=92.5`);
    const searchUrl = encodeURIComponent(`https://streamdb7web.securenetsystems.net/player_status_update/KUUU_history.xml`);
    
    try {
        const res = await fetch(`${proxy}${searchUrl}`);
        const data = await res.json();
        const json = JSON.parse(data.contents);
        const stations = json.results || json.stations || [];
        
        console.log("--- FOUND STATIONS MATCHING '92.5' ---");
        stations.forEach(s => {
            console.log(`Station: ${s.name} | City: ${s.city} | EXPECTED CALLSIGN KEY: "${s.callsign}"`);
        });
    } catch (e) {
        console.error("Discovery request failed. SecureNet's directory might be restricted.", e);
    }
}
// async function discoverU92TritonMount() {
//     console.log("🔍 Scanning Triton's server block to locate U92's active mountName...");
//     const proxy = `https://api.allorigins.win/get?url=`
//     // Querying Triton's global provisioning service
//     const targetUrl = encodeURIComponent(`https://np.tritondigital.com/public/`);
    
async function discoverU92TritonMount() {
    console.log("🔍 Scanning Triton's server block to locate U92's active mountName...");
    
    // List of every possible corporate mount configuration Broadway Media uses for U92
    const checks = ["KUUUFM_AAC", "KUUU_AAC", "KUUUFM_HD", "KUUUFM", "KUUU", "KUDDHD2", "KUDDHD", "KUUUAM", "KUUU_AM"];
    let mountIdentified = false;

    for (const mount of checks) {
        // Build a targeted query for each mount variations
        const targetUrl = `https://np.tritondigital.com/public/nowplaying?mountName=${mount}&numberToFetch=2&eventType=track&format=json`;
        const probeUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`;
        
        try {
            console.log(`Pinging Triton mount variation: "${mount}"...`);
            const response = await fetch(probeUrl);
            if (!response.ok) continue;

            const text = await response.text();
            
            // If Triton returns a valid XML tracking block that isn't empty
            if (text.includes("nowplaying-info") && !text.includes("<nowplaying-info-list/>")) {
                console.log(`%c🎯 TARGET MOUNT IDENTIFIED: "${mount}"`, "color: #13c703; font-weight: bold; font-size: 14px;");
                console.log("[DEBUG] Sample text returned:", text.substring(0, 1500));
                mountIdentified = true;
                //break;
            } else {
                console.log(`Mount "${mount}" connected, but returned a blank playlist history.`);
            }
        } catch (err) {
            console.warn(`Probe failed for ${mount}`);
        }
    }

    if (!mountIdentified) {
        console.error("❌ All standard Triton mount variations returned empty or failed.");
    }
}
function listenToLiveU92(playlistId = "2nDRY8T9SruY4U0Dy4OkTS") {
    const token = localStorage.getItem('access_token');
    const mountName = "KUUUFM"; // The definitive live stream key we identified

    console.log(`%c📡 [U92 Live] Initializing Server-Sent Event stream listener for ${mountName}...`, "color: #d113c1; font-weight: bold;");

    // Triton's official real-time chunked streaming endpoint
    const sseUrl = `https://stream.tritondigital.com/v2/metadata/sse?mountName=${mountName}`;
    const eventSource = new EventSource(sseUrl);

    eventSource.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            
            // Look for Triton's native track change event property layout
            if (data.type === "track" && data.cue_title && data.track_artist_name) {
                const title = data.cue_title.trim();
                const artist = data.track_artist_name.trim();

                if (title.toLowerCase() === "advertisement") return;

                console.log(`%c🎵 [U92 Airing Now]: ${title} - ${artist}`, "color: #d113c1;");
            }
        }
        catch (err) {
            console.error("Error processing live stream packet data:", err);
        }
    }
}

async function gatherIHeartStationTrack(siteId = "KAAZ-FM", stationLabel = "Rock1067") {
    console.log(`📡 [iHeart] Polling current live track for ${stationLabel} (ID: ${siteId})...`);
    
    // 94.1 KODJ (Classic Hits): Site ID 4781
    // 107.5 The Vibe (Hip Hop & R&B): Site ID 7316
    // 97.1 ZHT (Top 40 & Pop): Site ID 4777

    // Rock 106.7 (KAAZ) is tracked under stream ID 6105
    // 97.1 ZHT (KZHT) is tracked under stream ID 4733
    // 107.5 The Vibe (KUUU-HD2) is tracked under stream ID 8894
    // 94.1 KODJ is tracked under stream ID 4737

    // Official public iHeartRadio Live Metadata Gateway
    //const targetUrl = `https://api.iheart.com/api/v2/live-meta/stream/${siteId}/currentTrackMeta`;
    // ✅ NEW COMPILATION GATEWAY: Public content route that uses station call letters directly
    // let targetUrl = `https://content.api.iheart.com/v3/stations/${siteId.toUpperCase().trim()}/now-playing`;
    // targetUrl = `https://api.iheart.com/api/v2/live-meta/stream/${siteId}/currentTrackMeta`;
    //targetUrl = "https://" + "content.api.iheart.com" + "/v3/stations/" + siteId;
    // targetUrl = "https://" + "api.iheart.com" + "/api/v2/live-meta/stream/" + siteId + "/currentTrackMeta";
    // ✅ NEW PRODUCTION PATHWAY: Uses the v3 'now-playing' specific resource
    //const targetUrl = "https://" + "content.api.iheart.com" + "/v3/stations/" + siteId + "/now-playing";
    // ✅ BYPASS PATHWAY: Targets the public web player directory endpoint instead of the data-center subdomain!
    //const targetUrl = "https://" + "www.iheart.com" + "/api/v1/stations/" + siteId + "/now-playing";
    //const targetUrl = "https://" + "iheart.com" + "/api/v1/live-meta/stream/" + siteId + "/currentTrackMeta"
    // ✅ CHARACTER-PERFECT CONCATENATION: Explicitly forces the 'uapi' subdomain to bypass 530 and 404 walls!
    //const targetUrl = "https://" + "uapi" + ".iheart.com" + "/api/v1/live-meta/stream/" + siteId + "/currentTrackMeta";
// ✅ SHOUTCAST METADATA GATEWAY: Wide-open public streaming directory asset
//const targetUrl = "https://" + "shoutcast" + ".mixstream.net" + "/v2/station/" + "kaazfm" + "/nowplaying"; 
    // ✅ THE UN-BLOCKED PRODUCITON CDN PATH: Bypasses the Akamai firewall walls natively
    //const targetUrl = "https://" + "iheart.com" + "/api/v1/stations/" + siteId + "/now-playing";
// ✅ CHARACTER-PERFECT CONCATENATION: Locks in the 'onair' subdomain to clear out 530 and 404 errors!
//const targetUrl = "https://" + "onair" + ".iheart.com" + "/api/v1/stations/" + siteId + "/now-playing";
// ✅ TUNEIN BACKEND ENDPOINT: Open-access tracking logger that bypasses iHeart's firewalls entirely
// ✅ CHARACTER-PERFECT CONCATENATION: Explicitly forces the 'opml' subdomain with NO extra slashes inside variables!
//const targetUrl = "https://" + "opml" + ".tunein.com" + "/Describe.ashx" + "?c=nowplaying&id=" + "s34651";
    // ✅ THE TRIPLE-VERIFIED ENDPOINT: Real-time song tracker for iHeart streams
    //const targetUrl = "https://" + "api.iheart.com" + "/api/v2/live-meta/stream/" + siteId + "/currentTrackMeta";
// ✅ PRODUCTION 2026 API PATH: Points to the live US player cluster with zero firewalls
const targetUrl = "https://" + "api.iheart.com" + "/api/v3/live-meta/stream/" + siteId + "/currentTrackMeta";



    const proxyList = [
        "https://" + "spotify-proxy" + "." + "detmer14" + ".workers.dev" + "/?url=" + encodeURIComponent(targetUrl),
        // `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,
        // //`https://thingproxy.freeboard.io/fetch/${targetUrl}`,
        // `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
        // `https://cors-anywhere.herokuapp.com/${targetUrl}`,
        // //`https://proxy.cors.sh/${targetUrl}`
    ];


    let fetchSuccessful = false;
    let rawContent = "";

    // 🔄 Proxy traversal loop: Rotates through open gateways automatically
    for (const proxyUrl of proxyList) {
        try {
            const domainLabel = proxyUrl.split('/')[2];
            console.log(`%c [${stationLabel}] Attempting connection via proxy: ${domainLabel}...`, "color: #00c020;");
            console.log(`proxyUrl: ${proxyUrl}`)

            const response = await fetch(proxyUrl);
            if (!response.ok) {
                console.log(`[${stationLabel}] Proxy failed: ${proxyUrl}`);
                continue; 
            }

            // Extract the body content based on the proxy's layout schema
            if (proxyUrl.includes("allorigins")) {
                const proxyData = await response.json();
                rawContent = proxyData.contents;
            } else {
                rawContent = await response.text();
            }
            // 🔍 ADD THIS LOGGING LINE HERE:
            console.log(`[DEBUG] Raw proxy payload length: ${rawContent ? rawContent.length : 0}. First 1000 chars:`, rawContent ? rawContent.substring(0, 1000) : "EMPTY");


            // ✅ SAFE JSON VALIDATOR: Ensure the payload is a valid JSON object string and not an HTML error sheet
            const trimmed = rawContent ? rawContent.trim() : "";
            // Validate that we got a valid JSON payload instead of an HTML error or empty response
            if (trimmed && trimmed.startsWith("{") && !trimmed.toLowerCase().startsWith("<!doctype") && !trimmed.toLowerCase().startsWith("<html")) {
                // Reject server-side error schemas explicitly
                if (trimmed.includes('"errors"') || trimmed.includes('"error"') || trimmed.includes('"code":4')) {
                    console.log(`[${stationLabel}] Proxy bypassed an internal iHeart error block. Trying next...`);
                    continue;
                }
                
                fetchSuccessful = true;
                console.log(`🎉 Connection established via ${domainLabel}!`);
                break; 
            }
            if (trimmed && trimmed.startsWith("{") && !trimmed.toLowerCase().startsWith("<!doctype") && !trimmed.toLowerCase().startsWith("<html")) {
                fetchSuccessful = true;
                console.log(`🎉 Connection established via ${domainLabel}!`);
                break; // Exit the loop early because we got clean data
            }
            if (trimmed && !trimmed.toLowerCase().startsWith("<!doctype") && !trimmed.toLowerCase().startsWith("<html")) {
                // If it returns an explicit iHeart error object string, reject it and continue the loop
                if (trimmed.includes("Path not found") || trimmed.includes("error")) {
                    console.log(`[${stationLabel}] Proxy returned an iHeart API error block. Trying next fallback...`);
                    continue;
                }
                
                if (trimmed.startsWith("{") || trimmed.includes("title") || trimmed.includes("artist")) {
                    fetchSuccessful = true;
                    console.log(`🎉 Connection established via ${domainLabel}!`);
                    break; 
                }
            }
        } catch (e) {
            console.warn(`⚠️ Proxy request failed during loop traversal.`);
        }
    }

    if (!fetchSuccessful || !rawContent) {
        console.error(`❌ Critical: All fallback proxies failed to pull data for ${stationLabel}. Skipping this sync cycle.`);
        return;
    }

    try {
        // --- STEP 2: PROCESS THE RETRIEVED TEXT SAFELY INTO OBJECTS ---
        let freshHistory = [];
        const trackData = JSON.parse(rawContent.trim());

        if (trackData && trackData.title && trackData.artist) {
            const title = trackData.title.trim();
            const artist = trackData.artist.trim();

            // Filter out commercial breaks or talk block fillers
            if (title.toLowerCase() !== "advertisement" && artist.toLowerCase() !== "iheartradio") {
                // Map cleanly into your standard metadata dictionary schema structure
                freshHistory.push({ TIT2: title, TPE1: artist, TXXX_category: 'music' });
            }
        }

        if (freshHistory.length === 0) {
            console.log(`[${stationLabel}] Station is currently airing commercials or a morning show block.`);
            return; // No music to cache on this 10-minute check
        }

        // --- STEP 3: LOG & ACCUMULATE METADATA ---
        const pendingMetadataKey = `pending_metadata_${stationLabel}`;
        let savedPendingMetadata = JSON.parse(localStorage.getItem(pendingMetadataKey)) || [];

        // Merge newly discovered items into the backlog array without duplicates
        for (const item of freshHistory) {
            const isDuplicate = savedPendingMetadata.some(p => 
                p.TIT2?.toLowerCase() === item.TIT2?.toLowerCase() && 
                p.TPE1?.toLowerCase() === item.TPE1?.toLowerCase()
            );
            if (!isDuplicate) {
                savedPendingMetadata.push(item);
            }
        }

        // Save the updated backlog back to localStorage to wait for the hourly sync
        localStorage.setItem(pendingMetadataKey, JSON.stringify(savedPendingMetadata));
        console.log(`📦 Accumulated item. Total pending search queue for ${stationLabel}: ${savedPendingMetadata.length}`);

    } catch (error) {
        console.error(`Error parsing iHeart JSON payload data:`, error);
    }
}

async function queryLyristForSpotify(artist, title) {
    // Lyrist uses a simple path-based search
    const targetUrl = `https://lyrist.vercel.app/api/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    //const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`;
    const proxyUrl = targetUrl
    console.log(`proxyUrl: ${proxyUrl}`)

    try {
        const response = await fetch(proxyUrl);
                let rawContent = await response.text();

        // 🔍 ADD THIS LOGGING LINE HERE:
        console.log(`[DEBUG] Raw proxy payload length: ${rawContent ? rawContent.length : 0}. First 2000 chars:`, rawContent ? rawContent.substring(0, 2000) : "EMPTY");

        // const data = await response.json();

        // // Lyrist often includes the Spotify ID or full URL
        // if (data.url && data.url.includes("spotify.com")) {
        //     const trackId = data.url.split("/track/").pop().split("?");
        //     return `spotify:track:${trackId}`;
        // }
    } catch (e) { console.error("Lyrist lookup failed", e); }
    return null;
}

async function querySonglinkForSpotifyUri(artist, title) {
    //const query = encodeURIComponent(`${artist} ${title}`);
    const query = (`track:${title} artist:${artist}`);
    const spotifySearchUrl = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`;

    // Odesli's public lookup can take a search term
    let targetUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifySearchUrl)}`;

    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`;

    console.log(`proxyUrl: ${proxyUrl}`)

    try {
        const response = await fetch(proxyUrl);
        const data = await response.json();

        // Odesli returns a linksByPlatform object
        if (data.linksByPlatform && data.linksByPlatform.spotify) {
            const spotifyUrl = data.linksByPlatform.spotify.url; // e.g. https://spotify.com...
            const trackId = spotifyUrl.split("/track/").split("?");
            const uri = `spotify:track:${trackId}`;
            
            console.log(`%c🎯 [Songlink Intercept]: Found Spotify URI -> ${uri}`, "color: #13c703; font-weight: bold;");
            return uri;
        }
    } catch (err) {
        console.error("Songlink fallback failed:", err);
    }
    return null;
}

/**
 * Queries the free MusicBrainz API for a track metadata footprint.
 * Attempts to retrieve an exact ISRC code or direct Spotify URI link.
 */
async function queryMusicBrainzForTrack(artist, title) {
    // 💡 REQUIRED: Customize this string to identify your specific scraper application
    const appIdentity = "RadioToSpotifyPlaylistMixer/1.0.0 ( ben.burt.spotify@gmail.com )";
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // MusicBrainz uses standard Lucene query syntax for their recording search endpoint
    const queryStr = `artist:"${artist}" AND recording:"${title}"`;
    const targetUrl = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(queryStr)}&fmt=json`;
    
    // We pass this through your existing working CodeTabs proxy to bypass browser CORS walls
    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`;

    console.log(`proxyUrl: ${proxyUrl}`)

    try {
        await delay(1100); // 1-second pacing margin
        console.log(`📡 [MusicBrainz Search] Querying MBID for: ${title} - ${artist}...`);
        
        const searchRes = await fetch(proxyUrl, { headers: { 'User-Agent': appIdentity } });
        if (!searchRes.ok){
            console.log(`searchRes.ok = false`)
            return null;
        }
        
        const searchData = await searchRes.json();
        const recordings = searchData.recordings || [];
        
        if (recordings.length === 0) {
            console.log("❌ [MusicBrainz] Zero catalog entries found for this metadata combination.");
            return null;
        }
        
        // Grab the unique MusicBrainz ID (MBID) from the top matching entry
        // Find the first recording that isn't just a placeholder "Work"
        // ✅ Specifically find a high-score studio track (video: false)
        // ✅ Specifically target the 'recording' result type to avoid composition 'works'
        const validRecording = recordings.find(r => r.id && !r.video && r.length > 180000) || recordings;
        //const validRecording = recordings.find(r => r.id && r.score >= 90 && !r.video) || recordings;
        const mbid = validRecording.id;
        console.log(`🧬 [MusicBrainz] Found matching tracking key MBID: ${mbid}`);

        // ==========================================
        // 🅱️ STEP 2: DIRECT LOOKUP WITH RELATIONS INC
        // ==========================================
        // ✅ The crucial parameter: ?inc=url-rels tells the server to attach streaming hyperlinks
        const lookupTarget = `https://musicbrainz.org/ws/2/recording/${mbid}?inc=releases+release-groups+url-rels+release-rels+release-group-rels&fmt=json`;
        const lookupProxy = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(lookupTarget)}`;
        
        await delay(1100); // Pacing delay to respect the MusicBrainz traffic bucket rules
        console.log(`📡 [MusicBrainz Lookup] Fetching external relations map for MBID...`);

        const lookupRes = await fetch(lookupProxy, { headers: { 'User-Agent': appIdentity } });
        if (!lookupRes.ok){
            console.log(`lookupRes.ok = false`)
            return null;
        }

        //const trackData = await lookupRes.json();
        const trackData = []
        //rawContent = trackData.contents;
                let rawContent = await lookupRes.text();

        // 🔍 ADD THIS LOGGING LINE HERE:
        console.log(`[DEBUG] Raw proxy payload length: ${rawContent ? rawContent.length : 0}. First 2000 chars:`, rawContent ? rawContent.substring(0, 2000) : "EMPTY");


        // 🛡️ RECURSIVE DEEP SCANNER: Finds any 'resource' key containing a Spotify track URL inside the object
        let foundSpotifyUri = null;

        function findSpotifyUriInObject(obj) {
            console.log(`Parsing for Uri - findSpotifyUriInObject`)
            if (foundSpotifyUri) return; // Exit early if already found
            if (!obj || typeof obj !== 'object'){
                console.log(`This check failed: !obj || typeof obj !== 'object'`)
                return;
            }

            // Check if the current object level has a direct 'resource' value matching our criteria
            if (obj.resource && typeof obj.resource === 'string') {
                console.log(`This check succeded: obj.resource && typeof obj.resource === 'string'`)
                const urlStr = obj.resource.toLowerCase();
                if (urlStr.includes("open.spotify.com")) {
                    const pathParts = obj.resource.split("/track/");
                    if (pathParts.length > 1) {
                        const trackId = pathParts[1].split("?")[0].trim();
                        if (trackId) {
                            foundSpotifyUri = `spotify:track:${trackId}`;
                            return;
                        }
                    }
                }
                else{
                    console.log(`This check failed: urlStr.includes("open.spotify.com")`)
                }
            }
            else{
                console.log(`This check failed: obj.resource && typeof obj.resource === 'string'`)
            }

            // Otherwise, recursively dig deeper down into all children nodes/arrays
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    findSpotifyUriInObject(obj[key]);
                }
            }
        }

        // Initialize the crawler across the entire returned track database tree
        findSpotifyUriInObject(trackData);

        if (foundSpotifyUri) {
            console.log(`%c🎯 [MusicBrainz Intercept Success]: Found valid fallback link -> ${foundSpotifyUri}`, "color: #13c703; font-weight: bold;");
            return foundSpotifyUri;
        }
        
        console.log("⚠️ [MusicBrainz] Metadata node matched, but lacks an active Spotify relation mapping.");

    } catch (err) {
        console.error("❌ Exception encountered on MusicBrainz fallback processing step:", err);
    }
    return null; // Cache miss on MusicBrainz ecosystem
}


/**
 * Pagination engine that crawls a full Spotify playlist and backfills 
 * all track URIs into your local persistent global storage cache.
 */
// backfillGlobalCacheFromPlaylist("3HPDlPwGtZi5bxBYOGLEWd", "7346_48k");
async function backfillGlobalCacheFromPlaylist(playlistId, stationID = "MANUAL_IMPORT") {
    const token = localStorage.getItem('access_token');
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    if (!token) {
        console.error("❌ Critical Error: Access token is missing from localStorage.");
        return;
    }

    console.log(`%c🚀 [Cache Backfill] Initializing full pagination scan for playlist ID: ${playlistId}`, "color: #1DB954; font-weight: bold;");

    // 1. Load the active persistent global cache object from local storage up front
    let globalSongCache_backfill = {}
    //let globalSongCache_backfill = JSON.parse(localStorage.getItem('spotify_global_song_cache')) || {};
    //globalSongCache_backfill = JSON.parse(localStorage.getItem('spotify_global_song_cache')) || {};
    // ✅ Ensure runtime cache has data before starting lookups
    //if (!globalSongCache_backfill || Object.keys(globalSongCache_backfill).length === 0) {
        globalSongCache_backfill = await loadIndexedDbToRuntimeCache();
        console.log(`🎉 Backfill cache hydrated! Total records: ${Object.keys(globalSongCache_backfill).length}`);
    //}

    // Start with the initial 100-item page endpoint path
    let nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;
    let totalItemsProcessed = 0;
    let newCacheEntriesAdded = 0;

    // 🔄 Pagination Loop: Keep crawling pages sequentially until nextPageUrl turns null
    while (nextPageUrl) {
        try {
            console.log(`📡 Fetching playlist catalog page: ${nextPageUrl.split('?')[1] || 'default'}...`);
            
            const response = await fetch(nextPageUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (response.status === 429) {
                console.error("🛑 Spotify Rate Limit hit during backfill extraction! Saving current progress and stopping.");
                break;
            }

            if (!response.ok) {
                console.error(`⚠️ Network fetch interrupted! Status code: ${response.status}`);
                break;
            }

            const playlistData = await response.json();
            const items = playlistData.items || [];

            // 🔄 Inner Loop: Iterate through the items array collection pulled from this page
            for (const wrapper of items) {
                totalItemsProcessed++;
                const track = wrapper.track || wrapper.item;

                // Skip non-track entries (like podcast episodes or deleted rows)
                if (!track || !track.name || !track.uri) continue;

                // Extract official resolved text fields natively from Spotify's schema layout keys
                const spotifyTitle = track.name;
                const spotifyArtist = track.artists?.[0]?.name || "Unknown Artist";
                const trackUri = track.uri;

                // 🧼 Run your pre-processor function to generate the unified lowercase cache key slug
                const cleanArtist = cleanMetadataString(spotifyArtist);
                const cleanTitle = cleanMetadataString(spotifyTitle);
                
                if (!cleanArtist || !cleanTitle) continue;
                const cacheKey = `${cleanArtist}-${cleanTitle}`.toLowerCase();

                // Check if this song footprint keys exist yet inside our storage block
                if (globalSongCache_backfill[cacheKey]) {
                    const record = globalSongCache_backfill[cacheKey];
                    console.log(`✅ [New Search already in Cache]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);

                    if(!record.found) record.found = true

                    if(!record.uri) record.uri = trackUri

                    // Track station affiliation mapping: Ensure stationID is attached to historical sync lists
                    record.stations_synced = record.stations_synced || []
                    if (!record.stations_synced.includes(stationID)) {
                        record.stations_synced.push(stationID);
                    }

                    // 🛠️ FIX SECURED: Ensure alternate_uris is safely initialized before querying it
                    record.alternate_uris = record.alternate_uris || [];

                    // Canonical checking: Ensure the found URI is linked to your alternates array registry
                    if (record.uri !== trackUri && !record.alternate_uris.includes(trackUri)) {
                        record.alternate_uris.push(trackUri);
                        console.log(`🔗 [Variant Linked] Appended alternate track alias mapping: ${trackUri} to "${spotifyTitle}"`);
                        if(track.linked_from?.id){
                            console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                            record.alternate_uris.push(track.linked_from?.uri)
                        }
                    }
                } 
                else {
                    // Initialize a brand new persistent cache schematic entry object mapping
                    globalSongCache_backfill[cacheKey] = {
                        found: true,
                        uri: trackUri,
                        alternate_uris: [],
                        resolved_title: spotifyTitle,
                        resolved_artist: spotifyArtist,
                        stations_synced: [stationID]
                    };
                    if(track.linked_from?.id){
                        console.log(`🔗 [linked_from Variant Linked] Appended alternate track alias mapping: ${track.linked_from?.uri} to "${spotifyTitle}"`);
                        record.alternate_uris.push(track.linked_from?.uri)
                    }

                    console.log(`✅ [New Search Cached]: ${spotifyTitle} - ${spotifyArtist} -> ${trackUri}`);

                    newCacheEntriesAdded++;
                }
            }

            // 🧭 Navigation updates checkpoint: Update the pointer address string string matching next or null
            nextPageUrl = playlistData.next;

            if (nextPageUrl) {
                // Tiny pacing cushion delay buffer so you do not slam the item lookup loops
                await delay(200);
            }

        } catch (err) {
            console.error("❌ Exception encountered during pagination traversal processing step:", err);
            break;
        }
    }

    // 💾 MASTER LOCALSTORAGE WRITEBACK: Save everything safely back to the browser vault
    // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache_backfill));
    // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
    // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
    await flushRuntimeCacheToIndexedDb(globalSongCache_backfill);

    
    console.log(`%c🎯 Backfill Complete! Processed ${totalItemsProcessed} total playlist items. Added ${newCacheEntriesAdded} brand new songs directly to 'spotify_global_song_cache'.`, "color: #1DB954; font-weight: bold;");
}

/**
 * Scans globalSongCache for tracks that failed past Spotify searches
 * and outputs them cleanly grouped by station for manual review.
 */
/**
 * Iterates through the globalSongCache dictionary object properties,
 * extracting and printing all records currently flagged as missing.
 */
function printUnfoundTracksReport() {
    console.log("🔍 [Diagnostics] Scanning dictionary-mapped globalSongCache for missing items...");
    
    const cacheKeys = Object.keys(globalSongCache);
    let unfoundCount = 0;

    // Set up an object map to group deficiencies contextually by station ID
    const groupedByStation = {};

    cacheKeys.forEach(key => {
        const record = globalSongCache[key];
        
        if (record.found === false && record.bypassSearch !== true) {
            unfoundCount++;
            
            // Fallback to generic tag if station_searched is missing
            const station = record.stations_searched || "UNKNOWN_STATION";
            
            if (!groupedByStation[station]) {
                groupedByStation[station] = [];
            }
            
            groupedByStation[station].push({
                cacheKey: key,
                artist: record.resolved_artist || "Unknown Artist",
                title: record.resolved_title || "Unknown Title"
            });
        }
    });

    if (unfoundCount === 0) {
        console.log("🎉 Complete cache coverage! Zero missing tracks present in globalSongCache.");
        return;
    }

    console.log(`❌ Discovered ${unfoundCount} unresolved track signatures across the dictionary collection:`);

    // Output the formatted diagnostic list grouped by station context
    for (const stationID in groupedByStation) {
        //console.log(`\n📡 [Station Context: ${stationID}] ─── (${groupedByStation[stationID].length} Unfound)`);
        
        groupedByStation[stationID].forEach((item, index) => {
            //console.log(`  ${index + 1}. [CacheKey]: "${item.cacheKey}"`);
            //console.log(`     [Identity]: ${item.artist} - "${item.title}"`);
            console.log(`${item.artist},${item.title},XXXXXX,${stationID}`)
        });
    }
}

/**
 * Reads structured track listings from the clipboard to manually resolve 
 * previously unfound records inside globalSongCache.
 */
// Paste this into your console, hit Enter, then IMMEDIATELY click anywhere on your main app webpage!
// setTimeout(async () => { await resolveMissingTracksFromClipboard(); }, 3000);
async function resolveMissingTracksFromClipboard() {
    console.log("📋 [Manual Sync] Accessing system clipboard contents...");
    
    try {
            // 2. ✅ Run the startup pull-and-merge sequence instantly!
            //await pullAndMergeCaches(currentSpotifyUser);

        const clipboardText = await navigator.clipboard.readText();
        
        if (!clipboardText || !clipboardText.trim()) {
            console.warn("⚠️ Clipboard layout payload is completely empty.");
            return;
        }

        const lines = clipboardText.split(/\r?\n/);
        console.log(`Processing ${lines.length} manual entry rows...`);

        let updatedCount = 0;
        let newlyAddedCount = 0;

        for (const line of lines) {
            if (!line.trim()) continue;

            // Split line by comma properties: RawArtist, RawTitle, SpotifyURI, StationID
            const parts = line.split(",");
            if (parts.length < 3) {
                console.warn(`⚠️ Skipping malformed line data structure: "${line}"`);
                continue;
            }

            const rawArtist = parts[0].trim();
            const rawTitle = parts[1].trim();
            const spotifyUri = parts[2].trim();
            const stationID = parts[3] ? parts[3].trim() : "MANUAL_ENTRY";
            const bypassSearch = parts[3] ? parts[3].trim() : "false"

            const cleanArtist = cleanMetadataString(rawArtist);
            const cleanTitle = cleanMetadataString(rawTitle);
            
            const cacheKey = `${cleanArtist}-${cleanTitle}`.toLowerCase();

            // Extract the simple track ID out of the full Spotify URI string
            let cleanSpotifyId = spotifyUri.replace("spotify:track:", "").trim();
            cleanSpotifyId = `spotify:track:${cleanSpotifyId}`


            // Check if this song footprint keys exist yet inside our storage block
            if (globalSongCache[cacheKey]) {
                const record = globalSongCache[cacheKey];
                console.log(`✅ [Resolved Cache Entry]: ${rawTitle} - ${rawArtist} -> ${cleanSpotifyId}`);

                record.found = true
                record.bypasSearch = bypassSearch

                //if(!record.uri) record.uri = cleanSpotifyId
                record.uri = cleanSpotifyId //fix bad uris

                // Track station affiliation mapping: Ensure stationID is attached to historical sync lists
                record.stations_synced = record.stations_synced || []
                if (!record.stations_synced.includes(stationID)) {
                    record.stations_synced.push(stationID);
                }

                // 🛠️ FIX SECURED: Ensure alternate_uris is safely initialized before querying it
                record.alternate_uris = record.alternate_uris || [];
                
                // Canonical checking: Ensure the found URI is linked to your alternates array registry
                if (record.uri !== cleanSpotifyId && !record.alternate_uris.includes(cleanSpotifyId)) {
                    record.alternate_uris.push(cleanSpotifyId);
                    console.log(`🔗 [Variant Linked] Appended alternate track alias mapping: ${cleanSpotifyId} to "${rawTitle}"`);
                }

                updatedCount++;
            } 
            else {
                // Initialize a brand new persistent cache schematic entry object mapping
                const trackPayload = {
                    found: true,
                    bypasSearch: bypassSearch,
                    uri: cleanSpotifyId,
                    alternate_uris: [],
                    resolved_title: rawTitle,
                    resolved_artist: rawArtist,
                    stations_synced: [stationID]
                }

                globalSongCache[cacheKey] = trackPayload
                pendingCloudCacheUploads[cacheKey] = trackPayload

                console.log(`➕ [Added New Entry]: ${rawArtist} - "${rawTitle}" -> ID: ${cleanSpotifyId}`);

                newlyAddedCount++;
            }
        }

        pushCachesPendingUpdatesToCloud(currentSpotifyUser);

        console.log(`\n🎉 [Processing Complete]: Successfully updated ${updatedCount} items, injected ${newlyAddedCount} new items.`);
        console.log("💡 Next Step: Trigger your standard 'pushCachesToCloud()' script pass to secure changes to Supabase!");

    } catch (clipboardErr) {
        console.error("❌ Failed to read system clipboard context layers natively:", clipboardErr);
    }
}

/**
 * Crawls a target Spotify playlist, isolates duplicate track instances natively 
 * by URI and cleaned text metadata, and purges them while preserving original timestamps.
 */
async function deduplicateSpotifyPlaylist(playlistId) {
    const token = localStorage.getItem('access_token');
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    if (!token) {
        console.error("❌ Critical: Access token missing from localStorage.");
        return;
    }

    console.log(`%c🧼 [Deduplicator] Initializing optimization pass for playlist: ${playlistId}`, "color: #1DB954; font-weight: bold;");

    let allItems = [];
    let nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;
    let snapshotId = "";

    // =========================================================================
    // 🅰️ STEP 1: PAGINATE AND FETCH ALL ITEMS + THE CURRENT SNAPSHOT ID
    // =========================================================================
    while (nextPageUrl) {
        try {
            const response = await fetch(nextPageUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (response.status === 429) {
                console.error("🛑 Spotify rate limit wall hit during catalog extraction. Aborting.");
                return;
            }
            if (!response.ok) throw new Error(`HTTP target error: ${response.status}`);

            const playlistData = await response.json();
            
            // Capture the latest snapshot_id required by the delete endpoint payload
            if (playlistData.snapshot_id) {
                snapshotId = playlistData.snapshot_id;
            }

            const pageItems = playlistData.items || [];
            allItems.push(...pageItems);
            
            nextPageUrl = playlistData.next;
            if (nextPageUrl) await delay(800);

        } catch (err) {
            console.error("❌ Failed to compile playlist item mapping sheets:", err);
            return;
        }
    }

    console.log(`📋 [Deduplicator] Compiled ${allItems.length} total playlist tracking slots. Analyzing fingerprints...`);

    // Sets to hold the "first seen" unique instances
    const seenUris = new Set();
    const seenMetadataSlugs = new Set();
    
    // Array to hold the duplicates we need to delete
    const duplicatesToPurge = [];

    // =========================================================================
    // 🅱️ STEP 2: SCAN CHANNELS TRACK INDICES FOR TARGET DUPLICATES
    // =========================================================================
    for (let index = 0; index < allItems.length; index++) {
        const wrapper = allItems[index];
        const track = wrapper.track || wrapper.item;

        if (!track || !track.name || !track.uri) continue;

        const trackUri = track.uri;
        const rawTitle = track.name;
        const rawArtist = track.artists?.[0]?.name || "Unknown Artist";

        // Generate the clean case-insensitive metadata key slug matching your tools
        const cleanTitle = cleanMetadataString(rawTitle);
        const cleanArtist = cleanMetadataString(rawArtist);
        const metadataSlug = `${cleanArtist}|${cleanTitle}`;

        // Evaluation Logic: Is this an absolute duplication artifact?
        const isUriDuplicate = seenUris.has(trackUri);
        const isMetadataDuplicate = seenMetadataSlugs.has(metadataSlug);

        if (isUriDuplicate || isMetadataDuplicate) {
            let reason = isUriDuplicate ? "Exact URI Match" : "Cleaned Text Match";
            console.log(`❌ [Duplicate Flagged]: Position ${index} -> "${rawTitle} - ${rawArtist}" (${reason})`);
            
            // Save the URI and its exact original array slot position index
            duplicatesToPurge.push({
                uri: trackUri,
                position: index
            });
        } else {
            // First time seeing this song footprint! Log it as the master instance to preserve it
            seenUris.add(trackUri);
            seenMetadataSlugs.add(metadataSlug);
        }
    }

    if (duplicatesToPurge.length === 0) {
        console.log("%c🎉 [Deduplicator] Session Changes Optimization pass complete. Your playlist has zero duplicate tracks!", "color: #1DB954; font-weight: bold;");
        return;
    }

    console.log(`\n🚨 [Deduplicator] Found ${duplicatesToPurge.length} duplicate entries. Preparing reverse deletion pipeline...`);

    // =========================================================================
    // 🅲 STEP 3: THE SEPARATED-ARRAY POSITIONAL PURGE
    // =========================================================================
    
    // Sort all 792 duplicates globally from HIGHEST to LOWEST index
    // This is the only way to keep the snapshot valid during the deletions!
    duplicatesToPurge.sort((a, b) => b.position - a.position);

    // Spotify's /items endpoint allows a batch of 100 items per request
    const batchSize = 100;

    for (let i = 0; i < duplicatesToPurge.length; i += batchSize) {
        const currentBatch = duplicatesToPurge.slice(i, i + batchSize);
        
        // Target the /items endpoint that you verified is responding
        const deleteUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items`;

        // ✅ THE NEW FORMAT: Separating URIs and Positions into two parallel arrays.
        // This structure is often used to resolve the 'No uris provided' error 
        // when positional metadata is present.
        const requestPayload = {
            "uris": currentBatch.map(item => item.uri),
            "positions": currentBatch.map(item => Number(item.position)),
            "snapshot_id": snapshotId 
        };

        try {
            await new Promise(resolve => setTimeout(resolve, 1100)); // Pacing safety
            console.log(`📡 Sending Parallel-Array Batch (${i + 1} to ${Math.min(i + batchSize, duplicatesToPurge.length)})...`);

            const deleteResponse = await fetch(deleteUrl, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestPayload)
            });

            if (deleteResponse.ok) {
                const resData = await deleteResponse.json();
                // ✅ CRITICAL: Capture the new snapshotId for the NEXT batch
                snapshotId = resData.snapshot_id; 
                console.log(`✅ Batch Successful! Snapshot Updated: ${snapshotId}`);
            } else {
                const errorData = await deleteResponse.json();
                console.error(`❌ Deletion dropped (${deleteResponse.status}): ${errorData.error.message}`);
                
                // If it STILL says "No uris provided", it means /items explicitly requires 
                // the tracks: [{uri, positions}] wrapper, but your snapshotId is stale.
                return;
            }

        } catch (err) {
            console.error("Exception during deletion execution:", err);
            return;
        }
    }

    console.log(`%c🎯 Session Changes [DeDuplicator] Playlist optimized! Cleared ${duplicatesToPurge.length} duplicates.`, "color: #1DB954; font-weight: bold;");
}

/**
 * Migration Deduplicator: Creates a fresh playlist containing only the 
 * unique tracks from the source playlist.
 * Bypasses 403 errors by using POST (creation/addition) instead of DELETE/PUT.
 */
async function migrationDeduplicatePlaylist(playlistId) {
    const token = localStorage.getItem('access_token');
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    if (!token) {
        console.error("❌ Critical: Access token missing from localStorage.");
        return;
    }

    console.log(`%c🚀 [Migration] Starting fresh clone for: ${playlistId}`, "color: #1DB954; font-weight: bold;");

    let allItems = [];
    let nextPageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;
    let originalName = "Migrated Playlist";

    // 🅰️ STEP 1: LOAD ALL CURRENT TRACKS & GET PLAYLIST NAME
    try {
        const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items?limit=1`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const metaData = await metaRes.json();
        originalName = metaData.name || originalName;

        while (nextPageUrl) {
            const response = await fetch(nextPageUrl, { 
                headers: { 'Authorization': `Bearer ${token}` } 
            });
            const data = await response.json();
            
            if (data.items) {
                allItems.push(...data.items);
            }
            
            nextPageUrl = data.next;
            if (nextPageUrl) await delay(800);
        }
    } catch (err) {
        console.error("❌ Failed to load source playlist:", err);
        return;
    }

    // 🅱️ STEP 2: LOCALLY FILTER UNIQUE TRACKS
    const seenUris = new Set();
    const seenMetadataSlugs = new Set();
    const cleanMasterUris = [];
    let dupCount = 0;

    for (const wrapper of allItems) {
        const track = wrapper.track || wrapper.item;
        if (!track || !track.uri) continue;

        // Use your cleanMetadataString function to normalize artist and title
        const artistName = track.artists && track.artists.length > 0 ? track.artists[0].name : "Unknown Artist";
        const trackName = track.name || "Unknown Track";
        
        const slug = `${cleanMetadataString(artistName)}|${cleanMetadataString(trackName)}`;
        
        // Logic: Keep first instance if neither URI nor Metadata Slug has been seen
        if (seenUris.has(track.uri) || seenMetadataSlugs.has(slug)) {
            dupCount++;
        } else {
            seenUris.add(track.uri);
            seenMetadataSlugs.add(slug);
            cleanMasterUris.push(track.uri);
        }
    }

    if (dupCount === 0) {
        console.log("%c🎉 No duplicates found in source. Migration skipped.", "color: #1DB954; font-weight: bold;");
        return;
    }

    console.log(`🚨 Found ${dupCount} duplicates. Unique tracks to migrate: ${cleanMasterUris.length}`);

    // 🅲 STEP 3: CREATE THE NEW "CLEANED" PLAYLIST
    try {
        // // First, get your User ID to construct the creation URL
        // const meRes = await fetch('https://spotify.com', { 
        //     headers: { 'Authorization': `Bearer ${token}` } 
        // });
        // const meData = await meRes.json();
        // const userId = meData.id;

        // console.log(`📡 Creating new playlist container for user: ${userId}...`);
        const createRes = await fetch(`https://api.spotify.com/v1/me/playlists`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
                name: `${originalName} (Cleaned)`,
                public: true,
                description: `A deduplicated version of ${originalName} created on ${new Date().toLocaleString()}.`
            })
        });

        const newPlaylist = await createRes.json();
        const newPlaylistId = newPlaylist.id;
        console.log(`✅ New playlist created! ID: ${newPlaylistId}`);

        // 🅳 STEP 4: ADD CLEAN TRACKS IN BATCHES
        const batchSize = 100; // Spotify API limit for track insertion
        for (let i = 0; i < cleanMasterUris.length; i += batchSize) {
            const batch = cleanMasterUris.slice(i, i + batchSize);
            await delay(800); // Safety delay to respect rate limits
            console.log(`📡 Migrating batch (${i + 1} to ${Math.min(i + batchSize, cleanMasterUris.length)})...`);
            
            const addUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items`;

            const insertRes = await fetch(addUrl, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${token}`, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ uris: batch })
            });

            if (!insertRes.ok) {
                console.error(`❌ Failed to add batch starting at ${i}:`, await insertRes.text());
            }
        }

        console.log(`%c🎯 Migration Complete! Your unique tracks are now in: "${originalName} (Cleaned)"`, "color: #1DB954; font-weight: bold;");

    } catch (err) {
        console.error("❌ Exception during migration:", err);
    }
}


/**
 * Calculates the Levenshtein Distance between two strings
 * and returns a similarity score between 0.0 (no match) and 1.0 (perfect match).
 */
function getLevenshteinSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;

    const trackMatrix = [];

    // Initialize the distance matrix rows and columns
    for (let i = 0; i <= s2.length; i++) {
        trackMatrix[i] = [i];
    }
    for (let j = 0; j <= s1.length; j++) {
        trackMatrix[0][j] = j;
    }

    // Fill out the edit distance matrix numbers
    for (let i = 1; i <= s2.length; i++) {
        for (let j = 1; j <= s1.length; j++) {
            if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
                trackMatrix[i][j] = trackMatrix[i - 1][j - 1];
            } else {
                trackMatrix[i][j] = Math.min(
                    trackMatrix[i - 1][j - 1] + 1, // substitution character cost
                    Math.min(
                        trackMatrix[i][j - 1] + 1, // insertion character cost
                        trackMatrix[i - 1][j] + 1  // deletion character cost
                    )
                );
            }
        }
    }

    // Calculate percentage similarity based on the maximum string length
    const distance = trackMatrix[s2.length][s1.length];
    const maxLength = Math.max(s1.length, s2.length);
    
    return (maxLength - distance) / maxLength;
}

/**
 * Scans the local persistent cache keys to find any close typographical matches.
 * Returns the matching cache key object data string if a hit occurs, otherwise null.
 */
function scanCacheForFuzzyMatch(freshArtist, freshTitle, globalSongCache, threshold = 0.88) {
    const freshSlug = `${freshArtist}-${freshTitle}`.toLowerCase();
    
    let bestMatchKey = null;
    let highestScore = 0;

    // Loop through every unique key currently saved inside your local storage cache
    for (const cachedKey of Object.keys(globalSongCache)) {
        // Run the Levenshtein calculator metric against the key strings
        const score = getLevenshteinSimilarity(freshSlug, cachedKey);
        
        if (score > highestScore) {
            highestScore = score;
            bestMatchKey = cachedKey;
        }
    }

    // If the best match meets or beats your safety threshold, accept it
    if (highestScore >= threshold && bestMatchKey) {
        //console.log(`✨ [Fuzzy Match Hit!] Local match confidence: ${(highestScore * 100).toFixed(1)}%`);
        //console.log(`   Input:  "${freshTitle}" by ${freshArtist}`);
        //console.log(`   Cached: "${globalSongCache[bestMatchKey].resolved_title}" by ${globalSongCache[bestMatchKey].resolved_artist}`);
        return bestMatchKey;
    }

    return null; // Absolute cache miss
}

/**
 * Normalizes input metadata strings to maximize local cache matches.
 * Strips bracketed text filler, nested quotes, rogue symbols, and extra spaces.
 */
function cleanMetadataString(inputString) {
    if (!inputString) return "";

    let cleaned = inputString;

    // 1. Remove bracketed text filler like (Remastered), [Radio Edit], (Live from Studio), etc.
    cleaned = cleaned.replace(/\([^)]*\)/g, ""); // Strips everything inside round brackets ()
    cleaned = cleaned.replace(/\[[^\]]*\]/g, ""); // Strips everything inside square brackets []

    // 2. Normalize artist/track variations (e.g., "Featuring", "Feat.", "Ft.") by splitting them
    // This ensures "Artist A feat. Artist B" matches cleanly against just "Artist A"
    cleaned = cleaned.replace(/\b(feat|ft|featuring)\b.*/i, "");

    // 3. Strip all variations of single, double, curly, and directional quotes
    cleaned = cleaned.replace(/["'“”‘’`’]/g, "");

    // 4. Convert specific common connector symbols like hyphens or slashes to clean spaces
    cleaned = cleaned.replace(/[-–—\/]/g, " ");

    // 5. Strip out any remaining special punctuation symbols that cause string fracturing
    cleaned = cleaned.replace(/[.,?!@#$%^&*()_+={}\[\]|\\:;<>~]/g, "");

    // 6. Enforce lowercase transformation and compress multiple whitespace fractures into a single space
    cleaned = cleaned.toLowerCase();
    cleaned = cleaned.replace(/\s+/g, " ");
    
    return cleaned.trim();
}


// =========================================================================
// 🗄️ INDEXEDDB PERSISTENT STORAGE CONTROLLER
// =========================================================================
const DB_NAME = "SpotifyRadioSyncDB";
// const DB_VERSION = 1;
const STORE_NAME = "song_cache";

const DB_VERSION = 2; // Bump version to 2 to trigger upgrade if you had a previous version

function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // Retain your old song cache table if it existed
            if (!db.objectStoreNames.contains("global_song_cache")) {
                db.createObjectStore("global_song_cache");
            }
            // 🆕 Add the new dedicated object store container for your playlist mirrors
            if (!db.objectStoreNames.contains("playlist_mirrors")) {
                db.createObjectStore("playlist_mirrors");
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 💾 Save a playlist mirror to IndexedDB
async function setPlaylistMirrorIndexedDB(key, data) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("playlist_mirrors", "readwrite");
        const store = transaction.objectStore("playlist_mirrors");
        const request = store.put(data, key);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 📖 Read a playlist mirror from IndexedDB
async function getPlaylistMirrorIndexedDB(key) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("playlist_mirrors", "readonly");
        const store = transaction.objectStore("playlist_mirrors");
        const request = store.get(key);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Initializes the local database browser disk space.
 */
function openLocalCacheDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // Create our local data sheet table using the fuzzy metadata match key as our index primary key
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

/**
 * Saves a single track record natively into the browser disk without stringifying.
 */
async function saveLocalTrackItem(key, value) {
    const db = await openLocalCacheDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(value, key.trim().toLowerCase());

        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Retrieves a single track entry instantly from the disk via its metadata key string.
 */
async function getLocalTrackItem(key) {
    const db = await openLocalCacheDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key.trim().toLowerCase());

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Pulls down the ENTIRE local cache dictionary object so your cloud backup routines 
 * can package it up for Supabase in a single operation.
 */
async function getFullLocalTrackCacheMap() {
    console.log("📂 [IndexedDB] Opening and traversing Indexed DB for -song_cache-");
    const db = await openLocalCacheDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.openCursor();
        const fullMap = {};

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                fullMap[cursor.key] = cursor.value;
                cursor.continue();
            } else {
                console.log("✅ [IndexedDB] Success - Finished Opening and traversing Indexed DB for -song_cache-");
                resolve(fullMap); // Finished traversing the whole disk space
            }
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Bulk writes an entire dictionary map down to the disk (used during cloud pull-and-merge bootup).
 */
async function saveFullLocalTrackCacheMap(cacheMap) {
    const db = await openLocalCacheDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        
        Object.keys(cacheMap).forEach(key => {
            store.put(cacheMap[key], key.trim().toLowerCase());
        });

        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * ✅ BOOT ACTION: Reads your entire IndexedDB storage block straight into 
 * your existing synchronous runtime globalSongCache object.
 */
/**
 * ✅ CORRECTED: Returns the hydrated disk dataset directly,
 * avoiding JavaScript's reference-assignment limitations.
 */
async function loadIndexedDbToRuntimeCache() {
    try {
        console.log("📂 [IndexedDB] Extracting master track cache map from disk...");
        const fullDiskMap = await getFullLocalTrackCacheMap();
        console.log(`✅ [IndexedDB] Success Extracting master track cache map from disk`)
        // Return the clean data structure directly
        return fullDiskMap || {};
        
    }
    catch (err) {
        console.error("❌ [IndexedDB] Failed to extract data maps from disk filesystem storage:", err);
        return {}; // Return empty object fallback to preserve downstream loop iteration integrity
    }
}

/**
 * ✅ FLUSH ACTION: Bulk-saves your updated synchronous globalSongCache object 
 * straight back down to the IndexedDB disk at the end of a radio sync pass.
 */
/**
 * ✅ CORRECTED: Bulk-saves whichever specific memory cache model 
 * you pass into it down to the persistent browser disk space.
 */
async function flushRuntimeCacheToIndexedDb(targetCacheObj) {
    try {
        if (!targetCacheObj || Object.keys(targetCacheObj).length === 0) {
            console.warn("⚠️ [IndexedDB] Flush bypassed: Target cache layer object is completely empty.");
            return;
        }
        
        const count = Object.keys(targetCacheObj).length;
        console.log(`💾 [IndexedDB] Flushing ${count} tracks from runtime layout memory down to disk...`);
        
        await saveFullLocalTrackCacheMap(targetCacheObj);
        console.log("🎉 [IndexedDB] Disk sync operation successfully logged.");
    } catch (err) {
        console.error("❌ [IndexedDB] Critical failure encountered during bulk disk write pass:", err);
    }
}

// RUN THIS ONCE IN CONSOLE TO MIGRATE EXISTING CACHE DATA BEFORE WIPING LOCALSTORAGE
async function migrateLocalStorageToIndexedDb() {
    const oldCacheText = localStorage.getItem('spotify_global_song_cache');
    if (oldCacheText) {
        const oldData = JSON.parse(oldCacheText);
        console.log(`🚚 Migrating ${Object.keys(oldData).length} tracks to IndexedDB...`);
        await saveFullLocalTrackCacheMap(oldData);
        console.log("✅ Migration complete! You can now safely delete the old localStorage key.");
    } else {
        console.log("No existing localStorage cache detected. Ready for a clean slate.");
    }
}
//await migrateLocalStorageToIndexedDb();

async function migrateMirrorsToIndexedDB() {
    console.log("🚚 [Migration] Initializing localStorage to IndexedDB Mirror Shift...");
    let migrationCount = 0;

    // Loop backward through localStorage keys so deleting items doesn't mess up our index loop
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        
        if (key && key.startsWith("playlist_mirror_")) {
            try {
                const rawData = localStorage.getItem(key);
                if (rawData) {
                    const parsedData = JSON.parse(rawData);
                    
                    // 1. Write the payload cleanly into the database engine
                    await setPlaylistMirrorIndexedDB(key, parsedData);
                    
                    // 2. Erase the item from localStorage to instantly clear your 5MB quota block
                    localStorage.removeItem(key);
                    migrationCount++;
                    console.log(`✅ Ported and cleared: ${key}`);
                }
            } catch (err) {
                console.error(`❌ Migration hit a snag on item key ${key}:`, err);
            }
        }
    }

    console.log(`%c🎉 Migration Complete! Successfully shifted ${migrationCount} playlist mirrors to IndexedDB. Storage quota freed!`, "color: #00c020; font-weight: bold;");
}

// Execute migration instantly in your test session pass
//await migrateMirrorsToIndexedDB();


// =========================================================================
// ☁️ CROSS-DEVICE CACHE SYNCHRONIZATION ENGINE
// =========================================================================

/**
 * 🅰️ STARTUP PIPELINE: Pulls data from the cloud, combines it with localStorage,
 * resolves URI conflicts cleanly, and flushes a master cache matrix back to local disk.
 * Run this function inside your app initialization routine right after capturing the user ID!
 */
async function pullAndMergeCaches(currentSpotifyUser) {
    if (!currentSpotifyUser || currentSpotifyUser === "guest") {
        console.error("❌ [Sync] Sync cancelled: currentSpotifyUser parameter is undefined or missing.");
        return;
    }

    console.log(`%c📡 [Sync] Fetching cloud caches for Spotify ID: ${currentSpotifyUser}...`, "color: #00bcd4; font-weight: bold;");

    let cloudSongCache = {};
    let cloudMixCache = {};

    try {
        // Fetch your row record straight out of your user_caches table
        const { data, error } = await supabaseClient
            .from('user_caches')
            .select('globalsongcache, mix_cache')
            .eq('spotify_id', currentSpotifyUser)
            .maybeSingle(); // Handles empty tables gracefully without dropping exceptions

        if (error) {
            console.warn("⚠️ [Sync] Cloud database fetch missed or tables uninitialized. Proceeding with defaults:", error.message);
        } else if (data) {
            cloudSongCache = data.globalsongcache || {};
            cloudMixCache = data.mix_cache || {};
            console.log(`☁️ [Sync] Downloaded ${Object.keys(cloudSongCache).length} tracks and ${Object.keys(cloudMixCache).length} mixtures from cloud storage.`);
        }
    } catch (err) {
        console.error("❌ [Sync] Critical exception during cloud cache pull execution:", err);
    }

    // Unpack your current browser local storage caches
    //const localSongCache = JSON.parse(localStorage.getItem('spotify_global_song_cache')) || {};
    // let localSongCache = {}
    // ✅ Ensure runtime cache has data before starting lookups
    //if (!localSongCache || Object.keys(localSongCache).length === 0) {
    let localSongCache = await loadIndexedDbToRuntimeCache();
    //}

    const localMixCache = JSON.parse(localStorage.getItem('spotify_mix_cache')) || {};

    // =========================================================================
    // 🧬 MERGE ROUTINE 1: GLOBAL SONG METADATA MATRIX
    // =========================================================================
    const mergedSongCache = { ...localSongCache };

    Object.keys(cloudSongCache).forEach(rawKey => {
        // Enforce safe lowercase matching matching our fuzzy dictionary rules
        const key = rawKey.trim().toLowerCase();
        
        if (!mergedSongCache[key]) {
            // New track discovered on an alternate device! Merge it natively
            mergedSongCache[key] = cloudSongCache[rawKey];
        } 
        else {
            // Collision detected! Reconcile data integrity rows safely
            const localItem = mergedSongCache[key];
            const cloudItem = cloudSongCache[rawKey];

            const localHasUri = localItem.uri && localItem.uri !== "PENDING_RESOLVE";
            const cloudHasUri = cloudItem.uri && cloudItem.uri !== "PENDING_RESOLVE";

            // Scenario A: Local track is an unresolved pending search stub, but cloud item has a true URI handle!
            if (!localHasUri && cloudHasUri) {
                console.log(`%c✨ [Sync Upgrade] "${key}" upgraded with URI resolved on alternate device -> ${cloudItem.uri}`, "color: #1DB954;");
                mergedSongCache[key] = cloudItem;
            } 
            // Scenario B: Both versions contain identical URIs. Merge their historical radio station log fields.
            if (localItem.uri === cloudItem.uri) {
                const unifiedStations = Array.from(new Set([
                    ...(localItem.stations_synced || []),
                    ...(cloudItem.stations_synced || [])
                ]));
                mergedSongCache[key].stations_synced = unifiedStations;
                const unifiedAlternateUris = Array.from(new Set([
                    ...(localItem.alternate_uris || []),
                    ...(cloudItem.alternate_uris || [])
                ]));
                mergedSongCache[key].alternate_uris = unifiedAlternateUris;
            }
            else{
                if(!mergedSongCache[key].alternate_uris) mergedSongCache[key].alternate_uris = []
                if (cloudHasUri && !mergedSongCache[key].alternate_uris.includes(cloudItem.uri)) {
                    mergedSongCache[key].alternate_uris.push(cloudItem.uri);
                }
            }
        }
    });

    // =========================================================================
    // 🎛️ MERGE ROUTINE 2: MIXES STORAGE
    // =========================================================================
    // For mixtures data sheets, modern attributes automatically overlay old keys cleanly
    const mergedMixCache = { ...localMixCache, ...cloudMixCache };

    // 💾 Commit unified master sets back down to the browser disk architecture
    // localStorage.setItem('spotify_global_song_cache', JSON.stringify(mergedSongCache));
    // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
    // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
    await flushRuntimeCacheToIndexedDb(mergedSongCache);
    localStorage.setItem('spotify_mix_cache', JSON.stringify(mergedMixCache));

    // Seed the working runtime variable so downstream radio sync functions can read it immediately
    globalSongCache = mergedSongCache;
    
    console.log(`%c🎉 Cache Synchronization Complete! Total monitored tracks: ${Object.keys(mergedSongCache).length}`, "color: #1DB954; font-weight: bold;");
}

/**
 * 🅱️ BACKUP PIPELINE: Uploads local localStorage data models directly up to your 
 * Supabase cluster row using a native PostgreSQL SQL UPSERT command.
 */
async function pushCachesToCloud1(currentSpotifyUser) {
    if (!currentSpotifyUser || currentSpotifyUser === "guest") return;

    console.log("☁️ [Sync] Packing local database models for cloud upload backup...");

    const currentLocalSongCache = JSON.parse(localStorage.getItem('spotify_global_song_cache')) || {};
    const currentLocalMixCache = JSON.parse(localStorage.getItem('spotify_mix_cache')) || {};

    try {
        // Native PostgreSQL UPSERT rule call: Replaces matching rows or inserts new ones instantly
        const { error } = await supabaseClient
            .from('user_caches')
            .upsert({
                spotify_id: currentSpotifyUser,
                globalsongcache: currentLocalSongCache,
                mix_cache: currentLocalMixCache,
                updated_at: new Date().toISOString()
            }, { onConflict: 'spotify_id' });

        if (error) {
            console.error("❌ [Sync] Cloud backup request rejected by Supabase container:", error.message);
        } else {
            console.log("%c☁️ [Sync] Backup successful! Master records synchronized across all cloud platforms.", "color: #00c020;");
        }
    } catch (e) {
        console.error("❌ [Sync] Exception thrown inside periodic cloud upload loop phase:", e);
    }
}
async function pushCachesToCloud2(spotifyUserId) {
    if (!spotifyUserId) return;

    console.log("☁️ [Sync] Extracting persistent IndexedDB sheets for Supabase verification upload...");

    // ✅ Natively compile the massive local tracking array maps out of IndexedDB
    const currentLocalSongCache = await getFullLocalTrackCacheMap();
    const currentLocalMixCache = JSON.parse(localStorage.getItem('spotify_mix_cache')) || {};

    try {
        const { error } = await supabaseClient
            .from('user_caches')
            .upsert({
                spotify_id: spotifyUserId,
                globalsongcache: currentLocalSongCache,
                mix_cache: currentLocalMixCache,
                updated_at: new Date().toISOString()
            }, { onConflict: 'spotify_id' });

        if (error) {
            console.error("❌ [Sync] Cloud upload missed:", error.message);
        } else {
            console.log("%c☁️ [Sync] Cloud synchronization complete! Cache data safely backed up.", "color: #00c020;");
        }
    } catch (e) {
        console.error("❌ Exception thrown during database push:", e);
    }
}
async function pushCachesToCloud4(spotifyUserId, attempt = 1) {
    if (!spotifyUserId) return;
    //if (attempt > 3) return;

    console.log("☁️ [Sync] Packing runtime memory matrix models for cloud upload backup...");

    // Grab the current live state of your global cache dictionary
    const currentLocalSongCache = globalSongCache || {};
    const currentLocalMixCache = JSON.parse(localStorage.getItem('spotify_mix_cache')) || {};

    try {
        const { error } = await supabaseClient
            .from('user_caches')
            .upsert({
                spotify_id: spotifyUserId,
                globalsongcache: currentLocalSongCache,
                mix_cache: currentLocalMixCache,
                updated_at: new Date().toISOString()
            }, { onConflict: 'spotify_id' });

        if (error) {
            console.error("❌ [Sync] Cloud upload missed:", error.message);
            setTimeout(async () => { pushCachesToCloud(spotifyUserId, attempt + 1); }, (3 * attempt) * 1000); //try again - start with 3 sec
        } else {
            console.log("%c☁️ [Sync] Cloud sync complete! Cache database safely secured.", "color: #00c020;");
        }
    } catch (e) {
        console.error("❌ Exception thrown during cloud push execution step:", e);
    }
}
async function pushCachesToCloud4(spotifyUserId, attempt = 1) {
    console.log("☁️ [Sync] Packing runtime memory matrix models for cloud upload backup...");
    
    // 1. Convert your dictionary object cache to an array of table rows
    const allCacheEntries = Object.entries(globalSongCache).map(([key, trackData]) => ({
        spotify_id: spotifyUserId,
        cache_key: key,
        track_metadata: trackData,
        updated_at: new Date().toISOString()
    }));

    const BATCH_SIZE = 100;
    
    // 2. Loop through the array and process the data in small chunks
    for (let i = 0; i < allCacheEntries.length; i += BATCH_SIZE) {
        const chunk = allCacheEntries.slice(i, i + BATCH_SIZE);
        
        const { error } = await supabaseClient
            .from('user_caches')
            .upsert(chunk, { onConflict: 'spotify_id,cache_key' }); // Ensure your constraint keys match exactly

        if (error) {
            console.error(`❌ [Sync] Batch ${i / BATCH_SIZE + 1} upload missed:`, error.message);
            //return; // Exit execution if a batch encounters a real failure
            //setTimeout(async () => { pushCachesToCloud(spotifyUserId, attempt + 1); }, (3 * attempt) * 1000); //try again - start with 3 sec
        }
        else{
            console.log("✅ [Sync] Batch ${i / BATCH_SIZE + 1} Cloud upload completed successfully!");
        }
    }
    
    console.log("✅ [Sync] Cloud upload completed successfully in structured batches!");
}
async function pushCachesToCloud(spotifyUserId) {
    if (!spotifyUserId) return;

    console.log("☁️ [Sync] Packing runtime memory matrix models for cloud upload backup...");

    const currentLocalSongCache = globalSongCache || {};
    const currentLocalMixCache = JSON.parse(localStorage.getItem('spotify_mix_cache')) || {};

    try {
        const localEntries = Object.entries(currentLocalSongCache);
        const BATCH_SIZE = 5000;

        console.log(`🔄 [Sync] Session Changes Sending ${localEntries.length} tracks to server merge pipeline...`);

        // Loop through your tracks and send them in isolated, independent 100-song chunks
        for (let i = 0; i < localEntries.length; i += BATCH_SIZE) {
            const chunk = localEntries.slice(i, i + BATCH_SIZE);
            
            // Build a small, temporary chunk object layout
            const chunkObject = {};
            for (const [key, value] of chunk) {
                chunkObject[key] = value;
            }

            // Execute the server-side RPC function
            const { error } = await supabaseClient
                .rpc('merge_song_cache', {
                    user_id: spotifyUserId,
                    new_tracks: chunkObject,        // Sends ONLY 100 songs at a time over the network!
                    mix_data: currentLocalMixCache
                });

            if (error) {
                console.error(`❌ [Sync] Session Changes Server-side merge failed at block ${Math.floor(i/BATCH_SIZE) + 1}:`, error.message);
                //return;
            } else {
                console.log(`🎯 [Sync] Session Changes Server processed and merged block ${Math.floor(i/BATCH_SIZE) + 1} successfully.`);
            }
        }

        console.log("%c☁️ [Sync] Session Changes Cloud sync complete! Database safely updated via server merge.", "color: #00c020;");

    } catch (e) {
        console.error("❌ Exception thrown during cloud push execution step:", e);
    }
}
async function pushCachesPendingUpdatesToCloud(spotifyUserId) {
    if (!spotifyUserId) return;

    // 🛑 Avoid making network requests if no new tracks were captured
    const uploadCount = Object.keys(pendingCloudCacheUploads).length;
    if (uploadCount === 0) {
        console.log("ℹ️ [Sync Bypass]: Session Changes No new tracks captured this interval. Keeping disk budget safe.");
        return;
    }

    console.log(`☁️ [Sync] Session Changes Pushing ${uploadCount} new delta tracks to server merge pipeline...`);
    const currentLocalMixCache = JSON.parse(localStorage.getItem('spotify_mix_cache')) || {};

    try {
        // Pass ONLY the small temporary object instead of your full 27MB cache!
        const { error } = await supabaseClient
            .rpc('merge_song_cache', {
                user_id: spotifyUserId,
                new_tracks: pendingCloudCacheUploads, 
                mix_data: currentLocalMixCache
            });

        if (error) {
            console.error("❌ [Sync] Session Changes Server merge failed:", error.message);
        }
        else {
            console.log(`%c☁️ [Sync] Session Changes ${uploadCount} Delta successfully combined! Flushing local queue.`, "color: #00c020;");
            
            // 🎯 Clear out the tracking object so the next run starts with a clean slate
            pendingCloudCacheUploads = {}; 
        }
    } catch (e) {
        console.error("❌ Exception thrown during cloud push:", e);
    }
}

// Global scope counter to track your 15-minute execution cycles
let cloudSyncCycleCount = 0;
/**
 * ⏰ TIME GATE REGULATOR LOOP: Initializes background timer cadence execution loops.
 * Monitors local activity state changes and updates cloud server sheets every 15 minutes.
 */
function initializeAutomaticCloudBackupLoop(currentSpotifyUser) {
    if (!currentSpotifyUser || currentSpotifyUser === "guest") return;
    
    console.log("⏰ [Sync] Automated 15-minute background cloud interval scheduler armed.");
    
    // 15 minutes * 60 seconds * 1000 milliseconds
    pushCachesToCloud(currentSpotifyUser);
    setInterval(async () => {
        // 2. ✅ Run the startup pull-and-merge sequence instantly!
        //await pullAndMergeCaches(currentSpotifyUser);
        
        // cloudSyncCycleCount++; // Advance the cycle tracker flag
        // if(cloudSyncCycleCount % 8 === 0){
        //     await pushCachesToCloud(currentSpotifyUser);
        // }
        // else{
        //     await pushCachesPendingUpdatesToCloud(currentSpotifyUser);
        // }

        await pushCachesPendingUpdatesToCloud(currentSpotifyUser);

    }, 15 * 60 * 1000);
}


async function initializePlayer(){
    window.onSpotifyWebPlaybackSDKReady = () => {
        const player = new Spotify.Player({
            name: 'Random Playlist Player',
            getOAuthToken: cb => cb(accessToken),
            volume: 0.8
        })

        player.connect()
    }
}

// =========================
// Pure random picker (no UI, no playback)
// =========================
function pickRandomTrackInfo() {

    const chosenplaylist = pickPlaylistByMode()
    if(!chosenplaylist) return null

    const index = Math.floor(Math.random() * chosenplaylist.trackCount)
        console.log("pickRandomTrackInfo")
    return { playlist: chosenplaylist, index }
}

// function toggleSelectionMode(){
//     selectionMode = selectionMode === "slider" ? "balanced" : "slider"
//     saveAppState()
//     renderPlaylists()

//     showResult(selectionMode === "balanced" ? "Balanced mode: all enabled playlists are equally likely" : "Slider selection mode: playlist weights enabled")
// }

function setSelectionMode(mode){
    console.log(`selectionMode: ${selectionMode} mode: ${mode}`)
    selectionMode = mode
    document.querySelector(`input[name="selectionMode"][value="${selectionMode}"]`).checked = true;

        console.log(`%c ${selectionMode} mode enabled`, "color: #0b8100;")
        showResult(`%c ${selectionMode} mode enabled`, "color: #0b8100;")
        visualLog(`%c ${selectionMode} mode enabled`, "color: #0b8100;")

    if(mode === "normal"){
        playlists.forEach(p => {
            if(p.enabled) p.sliderValue = 50
        }) 
        //syncSlidersFromState();
        //normalizePercentagesAfterToggle()
    }
    if(mode === "percentage"){
        //renderPlaylists()
        normalizePercentagesAfterToggle()
    }
    if(mode === "relative"){
        playlists.forEach(p => {
            if(p.enabled) p.sliderValue = 50
        }) 
        
    }
    
        // playlists.forEach((p, index) => {
        //     setTimeout(() => {
        // //        refreshPlaylistCount(p.id, index);
        //     }, 2000 * index);
        // })
    renderPlaylists()
    saveAppState()
}


function rebalancePercentages(activeSlider){

    const rows = Array.from(document.querySelectorAll('.playlist-row')).filter(row => row.querySelector('.playlist-enabled').checked)

    if(rows.length <= 1){
        activeSlider.value = 100
        updateSliderDisplay(activeSlider)
        return
    }

    const activeValue = Number(activeSlider.value)
    const remaining = 100 - activeValue
    
    const otherSliders = rows.map(r => r.querySelector('.playlist-slider')).filter(s => s !== activeSlider)

    const currentSum = otherSliders.reduce((sum, s) => sum + Number(s.value), 0)

    isProgrammaticSliderUpdate = true

    let runningTotal = 0

    otherSliders.forEach((slider, index) => {
        let newValue

        if(currentSum === 0){
            //even split fallback
            newValue = remaining / otherSliders.length
        }
        else{
            newValue = (Number(slider.value) / currentSum * remaining)
        }

        // Last slider absorbs rounding error
        if(index === otherSliders.length - 1){
            newValue = remaining - runningTotal
        }

        const roundedValue = Math.max(0, Math.round(newValue))
        slider.value = roundedValue
        const playlistIndex = Number(slider.dataset.index)
        playlists[playlistIndex].sliderValue = roundedValue
        runningTotal += slider.value
        updateSliderDisplay(slider)
    })

    isProgrammaticSliderUpdate = false
}


function xrebalancePercentagesByIndex(activeIndex){
    showResult(`Rebalancing ${Date.now().toString()}`)
    const enabled = playlists.map((p, i) => ({p, i})).filter(x => x.p.enabled)

    if(enabled.length === 0) return

    //only one enabled playlist - 100
    if(enabled.length === 1){
        enabled[0].p.sliderValue = 100
        return
    }

    const active = playlists[activeIndex]
    const activeValue = Math.max(0, Math.min(100, active.sliderValue ?? 0))
    active.sliderValue = activeValue

    const remaining = 100 - activeValue

    const others = enabled.filter(x => x.i !== activeIndex)
    
    const currentSum = others.reduce((sum, x) => sum + (x.p.sliderValue ?? 0), 0)

    let runningTotal = 0

    others.forEach((x, idx) => {
        let newValue

        if(currentSum === 0){
            //even split fallback
            newValue = remaining / others.length
        }
        else{
            newValue = (x.p.sliderValue / currentSum) * remaining
        }

        if(idx === others.length -1){
            //absorb rounding error
            newValue = remaining - runningTotal
        }

        x.p.sliderValue = Math.max(0, Math.round(newValue))
        runningTotal += x.p.sliderValue
    })
    showResult(`Rebalancing ${Date.now().toString()}`)
}

let maxPercentage = 100
function rebalancePercentagesByIndex(activeIndex){
try{

    const debug = false

    if(debug) showResult(`Rebalancing ${Date.now().toString()}`)
    const enabled = playlists
        .map((p, i) => ({p, i}))
        .filter(x => x.p.enabled)
    //const enabled = Array.from(document.querySelectorAll('.playlist-row')).filter((row, rowindex) => row.querySelector('.playlist-enabled').checked).map(row => row.querySelector('.playlist-slider'))

    if(enabled.length === 0) return

    isProgrammaticSliderUpdate = true

    //only one enabled playlist - 100
    if(enabled.length === 1){
        playlists[enabled[0].i].sliderValue = 100;
        isProgrammaticSliderUpdate = true
        return;
    }
        if(debug) showResult(`Rebalancing Enabled ${enabled.length}`)


    const active = playlists[activeIndex]
    const activeValue = Math.max(0, Math.min(100, active.sliderValue ?? 0))
    active.sliderValue = activeValue
    if(debug) console.log(`\nRebalancing activeValue ${active.sliderValue}`)


    const remaining = 100 - activeValue
    let runningTotal = 0
    //maxPercentage = Number(activeValue) //to scale the visuals

    //const filteredSliders = Array.from(sliders).filter((_, i) => i !== indexToExclude);
    //const sliders = Array.from(document.querySelectorAll('.playlist-row')).filter((row, rowindex) => rowindex !== activeIndex).filter((row) => row.querySelector('.playlist-enabled').checked).map(row => row.querySelector('.playlist-slider'))
    const sliders = Array.from(document.querySelectorAll('#playlist-list .playlist-slider'))
        .filter((slider) => {
            const row = slider.closest('.playlist-row');
            const playlistIndex = Number(slider.dataset.index);
            return playlistIndex !== activeIndex && row.querySelector('.playlist-enabled').checked;
    })
    if(debug) console.log(`currentSum`)
    if(debug) console.log(`sliders length ${sliders.length}`)
    
    //calculate the total sum of slider values
    //reduce iterates through sliders to boil it down to a single number
    const currentSum = sliders.reduce((accumulator, currentItem, index) => {
        // If the current index matches the one to exclude, return the accumulator unchanged
        // if (index === activeIndex) {
        //     return accumulator;
        // }
        // Otherwise, add the current item's value to the accumulator
        if(debug) console.log(`value ${currentItem.value}`)
        return accumulator + Number(currentItem.value);
    }, 0); // Start the accumulator at 0
    if(debug) console.log(`Rebalancing currentSum ${currentSum}`)

    if(debug) console.log(`set sliders`)
    sliders.forEach((slider, i) => {
        //if(i !== activeIndex){ //This is taken care of in the querySelectorAll statement above now
            
            //maxPercentage = Math.max(maxPercentage, Number(slider.value))

            let newValue
            if(currentSum === 0){
                //even split fallback
                newValue = remaining / sliders.length
            }
            else{
                newValue = (Number(slider.value) / currentSum) * remaining
            }

            let finalValueToAssign
            if(i === sliders.length -1){
                //absorb rounding error
                finalValueToAssign = Math.max(0, remaining - runningTotal);
            }
            else{
                finalValueToAssign = newValue;
            }

        // Add the UNROUNDED value to the total to maintain precision
        runningTotal += finalValueToAssign

        // ONLY round when saving to data and UI
        const roundedValue = Math.max(0, Math.round(finalValueToAssign))
        slider.value = roundedValue
        const playlistIndex = Number(slider.dataset.index)
        playlists[playlistIndex].sliderValue = roundedValue
        if(debug) console.log(`slider ${playlistIndex} value ${slider.value}`)
        updateSliderDisplay(slider)
        //}
    })
} catch (e){
    console.error("Rebalance failed:", e)
} finally {
    isProgrammaticSliderUpdate = false //This ALWAYS runs
}
}


function updateSliderDisplay(slider){
    const valueSpan = slider.closest('.playlist-row').querySelector('.slider-value')

    if(valueSpan){
        valueSpan.textContent = slider.value
    }
}

function normalizePercentagesAfterToggle(){
    const debug = false
    if(debug)console.log("normalize percentages after toggle")

    //const sliders = Array.from(document.querySelectorAll('.playlist-row')).filter(row => row.querySelector('.playlist-enabled').checked).map(row => row.querySelector('.playlist-slider'))
    const sliders = Array.from(document.querySelectorAll('.playlist-row'))
        .filter(row => {
            const checkbox = row.querySelector('.playlist-enabled');
            return checkbox && checkbox.checked; // Only keep if checkbox exists AND is checked
        })
        .map(row => row.querySelector('.playlist-slider'))
        .filter(slider => slider !== null); // Ensure we only have valid sliders

    if(sliders.length === 0){
    if(debug)console.log("no playlists enabled")
        return
    }

    const equal = Math.floor(100 / sliders.length) || 1
    let totalAssigned = 0

    sliders.forEach((slider, i) => {
        if(i === sliders.length - 1){
            //slider.value = ((100 - totalAssigned) || 1) // Last one takes exactly what is left to hit 100
            slider.value = Math.max(1, 100 - totalAssigned);
        }
        else{
            slider.value = equal
            totalAssigned += equal
        }
        if(debug) console.log(`slider ${i} value ${slider.value}`)

        const playlistIndex = Number(slider.dataset.index)
        playlists[playlistIndex].sliderValue = slider.value
        updateSliderDisplay(slider)
    })

}

function syncSlidersFromState(){

    const debug = false
    if(debug) console.log("syncSlidersFromState")
    // document.querySelectorAll(".playlist.slider").forEach(slider => {
    //     const i = Number(slider.dataset.index)
    //     const value = playlists[i].sliderValue ?? 0
    //     slider.value = value
    //     slider.closest(".playlist-row").querySelector(".slider-value").textContent = value
    // })

    // document.querySelectorAll(".playlist.slider").forEach(slider => {
    //     const i = Number(slider.dataset.index)
    //     const value = playlists[i].sliderValue ?? 0
    //     slider.value = value
    //     const display = slider.closest(".playlist-row").querySelector(".slider-value")
    //     //slider.closest(".playlist-row").querySelector(".slider-value").textContent = value
    //     if(display){
    //         display.textContent = value
    //     }
    // })

    playlists.forEach((playlist, index) => {
        if(debug) console.log(`playlist ${index}`)
        const slider = document.querySelector(`.playlist-slider[data-index="${index}"]`)
        const display = slider?.closest('.playlist-row')?.querySelector('.slider-value')
        if(slider){
            if(debug) console.log(`playlist.sliderValue ${playlist.sliderValue}`)
            slider.value = playlist.sliderValue ?? 50
            if(debug) console.log(`value ${slider.value}`)
        }
        if(display){
            display.textContent = playlist.sliderValue ?? 50
            if(debug) console.log(`text ${display.textContent}`)
        }
    })
}



function pickPlaylistByMode(){
    const activePlaylists = playlists.filter(p => p.enabled)

    if(activePlaylists.length === 0) return null

    if(selectionMode === 'balanced'){
        return pickUniformly(activePlaylists)
    }
    if(selectionMode === 'percentage'){
        return pickByPercentage(activePlaylists)
    }

    //normal + relative
    return pickByWeightAlgorithm(activePlaylists)
}

function pickUniformly(activePlaylists){
    return activePlaylists[Math.floor(Math.random() * activePlaylists.length)]
}

function pickByPercentage(activePlaylists){
    //if you move a slider such that others are still calculating or rebalancing, the "total" might temporarily be 0
    const total = activePlaylists.reduce((sum, p) => sum + (Number(p.sliderValue) ?? 0), 0)

    // If total is 0, fallback to pickUniformly instead of returning null
    if(total === 0) return pickUniformly(activePlaylists)

    let r = Math.random() * total
    //console.log(`total = ${total}`)
    //console.log(`r = ${r}`)

    for(const playlist of activePlaylists){
        r -= Number(playlist.sliderValue)
    //console.log(`r == ${r} sliderValue = ${Number(playlist.sliderValue)}`)
        if(r <= 0) return playlist
    }

    return activePlaylists[0] //Final safety fallback
}

function pickByWeightAlgorithm(activePlaylists){
    const weightedCounts = activePlaylists.map(p => p.trackCount * getWeight(p.sliderValue ?? 50, p))

    const total = weightedCounts.reduce((s, v) => s + v, 0)
    //console.log(`total: ${total}`)
    if(total <= 0) return null

    let r = Math.random() * total

    for(let i = 0; i < activePlaylists.length; i++){
        r -= weightedCounts[i]
        if(r <= 0) return activePlaylists[i]
    }

    return null
}


async function pickRandomSong(attempt = 0) {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    if (!player){
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - Error: PLAYER_NOT_POWERED_ON`, {
                step: "pickRandomSong",
                error: `PLAYER_NOT_POWERED_ON`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        alert("Turn player on first")
        return "PLAYER_NOT_POWERED_ON";
    }

    // 1. Re-activate the element to satisfy autoplay rules
    // Nudge the browser to keep the audio context alive
    player.activateElement(); 
    player.connect().then(success => {
        if (success) {
            console.warn("Connection request sent to Spotify!");
        } 
        else {
            console.error(`%c pickRandomSong - Error: PLAYER_CONNECTION_FAIL`, "color: #ff0000; background: #ffffff;")
            visualLog(`%c Connection failed.`, "color: #ff0000; background: #ffffff;")
        // SEND THE LOG
        logEvent("ERROR", `pickRandomSong - Error: PLAYER_CONNECTION_FAIL`, {
            step: "pickRandomSong",
            error: `PLAYER_CONNECTION_FAIL`,
            stack_trace: new Error().stack, // Auto-trace errors
            strikeCount: rateLimitStrikes,
            activeMix: activeMixId
        });
            console.error("Connection failed.");
        }
    });
    

    lastPickTime = Date.now(); // Update timestamp whenever a pick is made (manual or auto)
    const activePlaylists = playlists.filter(p => p.enabled)

    // Safety: Don't get stuck in an infinite loop if a playlist is 100% unplayable
    if (attempt > 5) {
        showResult(`%c Error: Finding next item to Play failed too many times. Waiting for spotify to be re-authenticated.`, "color: #c300ff;")
        visualLog(`%c Error: Finding next item to Play failed too many times. Waiting for spotify to be re-authenticated.`, "color: #c300ff;")
        console.log("Error: Finding next item to Play failed too many times. Waiting for spotify to be re-authenticated.");
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - Error: Finding next item to Play failed too many times. Waiting for spotify to be re-authenticated.`, {
                step: "pickRandomSong",
                error: `RESTRICTED_TRACKS_LIMIT`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return("TOO_MANY_RESTRICTED_TRACKS_IN_PLAYLIST");
    }

    if(activePlaylists.length === 0){
        alert("Select at least one playlist")
        return "NO_PLAYLIST_ENABLED"
    }

    let cumulative = 0
    let chosenplaylist, index


    chosenplaylist = pickPlaylistByMode()
    if (!chosenplaylist) {
        console.warn("No playlist selected for auto-pick.");
        return "NO_PLAYLIST_CHOSEN_NO_ACTIVE_PLAYLISTS"; // Don't alert here, just stop
    }
    const playlistIndex = playlists.findIndex(p => p.id === chosenplaylist.id);

    index = Math.floor(Math.random() * chosenplaylist.trackCount) // uniform inside playlist
        //showResult(`Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`)        
        visualLog(`%c Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`, "color: #0004ff;")
        console.log(`--------------- Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`)
            // SEND THE LOG
            logEvent("TRACE", `pickRandomSong - Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`, {
                step: "pickRandomSong",
                error: `PLAYLIST_CHOSEN`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

    if (MOCK_MODE) {
        showResult(`--------------- Playlist ${chosenplaylist.name}, song #${index + 1}`)
        return "SUCCESS"
    }

    // --- NEW: SPOTIFY ID VALIDATION ---
    // If the ID is just a name like "A" or "MyMix", we only do "Mock" mode
    const isSpotifyId = /^[a-zA-Z0-9]{22}$/.test(chosenplaylist.id);

    if (!isSpotifyId) {
        const randomIndex = Math.floor(Math.random() * chosenplaylist.trackCount);
        showResult(`[MOCK MODE] Playlist: ${chosenplaylist.name}, Track #${randomIndex + 1}`);
        console.log(`Bypassing Spotify API for non-Spotify Playlist: ${chosenplaylist.id}`);
        return "SUCCESS"; // STOP HERE: Do not call getTrackAtIndex or playTrack
    }

    // real Spotify playback...
    const token = localStorage.getItem('access_token');
    await refreshPlaylistCount(chosenplaylist.id, playlistIndex);
    const track = await getTrackAtIndex(token, chosenplaylist.id, index)
    
    if (track === "NETWORK_ERROR"){
        console.log("pickRandomSong - getTrackAtIndex - NETWORK_ERROR, stopping loop")
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - getTrackAtIndex - NETWORK_ERROR, stopping loop`, {
                step: "pickRandomSong",
                error: `NETWORK_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return "NETWORK_ERROR"; // Stop the loop immediately!
    }
    
    // 4. RATE LIMIT CHECK: Stop if safeSpotifyFetch triggered a 429
    if (track === "RATE_LIMIT_HIT") {
        console.log("pickRandomSong: RATE_LIMIT_HIT, stopping loop");
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - getTrackAtIndex - RATE_LIMIT_HIT, stopping loop`, {
                step: "pickRandomSong",
                error: `RATE_LIMIT_HIT`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return "RATE_LIMIT_HIT";
    }

    if (track === null) {
        if (isSoftLocked) {
            console.log("pickRandomSong: Mixer is soft-locked. Waiting for recovery...");
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - getTrackAtIndex - SOFT_LOCKED, stopping loop`, {
                step: "pickRandomSong",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return "PICKRANDOMSONG_ERROR"; // Don't even attempt a retry loop
        }
        // ... normal restricted track retry logic ...
    }

    // Safety check: only call playTrack if we actually got a track back
    if (track && track.uri) {
        nowPlayingText = `%c Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`
        console.log(`%c Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`, "color: #129900;")
        showResult(`%c Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`, "color: #129900;")
        visualLog(`%c Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`, "color: #129900;")
            // SEND THE LOG
            logEvent("TRACE", `pickRandomSong - getTrackAtIndex - Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`, {
                step: "pickRandomSong",
                error: `GETTRACK_SUCCESS`,
                track: track.name,
                track_artist: track.artists[0].name,
                playlist: chosenplaylist.name,
                track_id: track.id,
                track_id_isrc: track.id,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

        let trackISRC = track.id

        queuePlaylistsMap.set(trackISRC, {
            name: chosenplaylist.name,
            playlist: chosenplaylist.id
        });

        const playTrackReturn = await playTrack(track.uri, false); //retry false
            
        if(playTrackReturn !== "SUCCESS"){
            console.warn("pickRandomSong playTrack - safeSpotifyFetch - FAIL:", playTrackReturn)
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong playTrack - safeSpotifyFetch - FAIL: ${playTrackReturn}`, {
                step: "pickRandomSong",
                error: `PICKRANDOM_PLAYTRACK_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return "FAIL"
        }

        // To keep the music playing when the screen goes off, Android requires a "Foreground Service." Browsers can't do this easily, but there is a hack: The Media Session API. If you "tell" Android that media is playing, it’s less likely to kill the tab.
        // Add this whenever a song starts:
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.name,
                artist: `${track.artists[0].name} - ${chosenplaylist.name}`,
                album: chosenplaylist.name,
                chapterTitle: chosenplaylist.name,
                artwork: [{ src: track.album.images[0].url }]
            });

            // Update the playback state so the play/pause button looks right
            navigator.mediaSession.playbackState = "playing";
        }

        incrementPlaylistCount(chosenplaylist.id)

        // --- ADD TO HISTORY ---
        addToHistory(track, chosenplaylist.name);

        // If the song that just started is the one at the top of our queue, remove it
        if (internalQueue.length > 0 && internalQueue[0].id === lastTrackId) {
            internalQueue.shift(); 
            renderQueue();
        }

        //queuePlaylistsMap.set(lastTrackId, { name: chosenplaylist.name });


        lastTrackId = trackISRC
        console.warn("lastTrackId - pickRandomSong:", lastTrackId, track.name)


        return("SUCCESS")

    } 
    else {
        console.log("Could not fetch that specific track. Try again!");
        // If track was null (failed safety checks), try again!
        console.log("Track was restricted or null. Retrying pick attempt " + (attempt + 1) + "...");
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - getTrackAtIndex - Track was restricted or null. Retrying pick attempt ${attempt +1}...`, {
                step: "pickRandomSong",
                error: `QUEUE_GETTRACK_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        safeTimeout(() => pickRandomSong(attempt + 1), 1000) //setTimeout ensures you never make more than one retry per second 
        return("GETTRACKATINDEX_FAIL")
    }
}

// =========================
// Batch playlist generator
// =========================
async function generateRandomPlaylist() {
    const countInput = document.getElementById("playlist-size")
    const desiredCount = parseInt(countInput.value)

    if (isNaN(desiredCount) || desiredCount < 1) {
        alert("Enter a valid number of tracks")
        return
    }

    const selections = []
    const maxAttempts = desiredCount * 2 //Safety to prevent infinite loops

    for (let i = 0; i < desiredCount; i++) {
        const result = pickRandomTrackInfo()
        if (!result){
	      //Don't break the loop, just log and try again
	      console.warn("Picker returned null, skipping one slot")
	      continue
	  }
        selections.push(result)
    }

    const container = document.getElementById("generated-playlist")
    container.innerHTML = ""

    selections.forEach((item, i) => {
        const row = document.createElement("div")
        row.className = "playlist-row"
        row.style.backgroundColor = 
            playlists.indexOf(item.playlist) !== -1 ?
            getPlaylistColorByIndex(playlists.indexOf(item.playlist))
            : "#eee"

        row.innerHTML = `
            <span>${item.playlist.name}</span>
            <span>${item.index + 1}</span>
        `

        container.appendChild(row)
    })

    showResult(`%c Generated ${selections.length} tracks`, "color: #000000;")
    visualLog(`%c Generated ${selections.length} tracks`, "color: #000000;")

    // REAL MODE (next step)
    // 1. Fetch track URIs via getTrackAtIndex (batched)
    // 2. Create Spotify playlist
    // 3. Add tracks in batches of 100
}


// =========================
// Playlist color helper
// =========================
function getPlaylistColor(name) {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash)
    }
    return `hsl(${hash % 360}, 70%, 85%)`
}

function getPlaylistColorByIndex(index){
    return playlistColorPalette[index % playlistColorPalette.length]
}


async function getTrackAtIndex(token, playlistId, index){
    //console.log("getTrackAtIndex");
    const limit = 1
    const offset = Number(index)

    try{
        const res = await safeSpotifyFetch(

    `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}&market=from_token&additional_types=track`,
            {
                headers: { Authorization: `Bearer ${token}` }
            }
        )

        if(res === "MAX_CALLS_PER_MINUTE"){
            console.warn("getTrackAtIndex - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "getTrackAtIndex",
                error: `MAX_CALLS_PER_MINUTE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(res === "SOFT_LOCKED"){
            console.warn("getTrackAtIndex - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "getTrackAtIndex",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(res === "429_MAX_STRIKES"){
            console.warn("getTrackAtIndex - safeSpotifyFetch - 429_MAX_STRIKES")
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "getTrackAtIndex",
                error: `429_MAX_STRIKES`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(res === "429_STRIKE"){
            console.warn("getTrackAtIndex - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - 429_STRIKE`, {
                step: "getTrackAtIndex",
                error: `429_STRIKE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(res === "401_TOKEN_EXPIRED"){
            console.warn("getTrackAtIndex - safeSpotifyFetch - 401_TOKEN_EXPIRED")
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - 401_TOKEN_EXPIRED`, {
                step: "getTrackAtIndex",
                error: "401_TOKEN_EXPIRED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        // --- THE RATE LIMIT CHECK ---
        if (res.status === 429) {
            const retryAfter = res.headers.get("Retry-After") || 5;
            
            console.error(`getTrackAtIndex - safeSpotifyFetch - RATE_LIMIT_HIT: Spotify says wait ${retryAfter}s`);
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - RATE_LIMIT_HIT: Spotify says wait ${retryAfter}s`, {
                step: "getTrackAtIndex",
                error: `RATE_LIMIT_HIT`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            
            // This is the signal pickRandomSong is waiting for
            return "RATE_LIMIT_HIT"; 
        }

        if(!res.ok){
            console.error("Error: getTrackAtIndex - safeSpotifyFetch blocked")
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - BLOCKED`, {
                step: "getTrackAtIndex",
                error: `GETTRACK_FETCH_BLOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

                if (res && typeof res.text === 'function') {
                const text = await res.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                
            throw new Error(errorData?.error?.message || "Forbidden or Not Found");
                }
            return null
        }
        const data = await res.json()

//console.log("EXACT ITEM CONTENT:", JSON.stringify(data.items[0], null, 2));
        // 2026 Debug: Log the full structure if it's still empty
        if (!data.items || data.items.length === 0) {
            console.log("getTrackAtIndex - Empty items array. Full Response:", data);
            // SEND THE LOG
            logEvent("WARN", `getTrackAtIndex - safeSpotifyFetch - DATA_EMPTY`, {
                step: "getTrackAtIndex",
                error: `GETTRACK_FETCH_DATA_EMPTY`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return null;
        }        
        
        //console.log("Keys available in this object:", Object.keys(data.items));

        // Check if items exists and is not empty
        if (data.items && data.items.length > 0) {

            const container = data.items[0];
            
            // --- THE FIX ---
            // Based on your JSON, the data is inside 'item'
            const track = container.item || container.track; 
            
            if (track && track.uri) {
                console.log("Found Track:", track.name, "URI:", track.uri);
                console.log("Success! Found:", track.name, "by", track.artists[0].name);
            // SEND THE LOG
            logEvent("TRACE", `getTrackAtIndex - safeSpotifyFetch - Success! Found: ${track.name} by ${track.artists[0].name}`, {
                step: "getTrackAtIndex",
                error: `SUCCESS_TRACK_FOUND`,
                track_name: track.name,
                track_artist: track.artists[0].name,
                track_id: track.id,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

                const rawArtist = track.artists[0].name.trim();
                const rawTitle = track.name.trim();
                const cacheartist = cleanMetadataString(rawArtist);
                const cachetitle = cleanMetadataString(rawTitle);
                const cacheKey = `${cacheartist}-${cachetitle}`.toLowerCase();

                // ✅ HYDRATE NEW CACHE SCHEMATIC ROW NATIVELY
                const trackPayload = {
                    found: true,
                    uri: track.uri,
                    alternate_uris: [], // Ready to collect variations on subsequent runs
                    resolved_title: cachetitle,
                    resolved_artist: cacheartist,
                    stations_synced: ["GLOBAL"] // Initialize array with the current station ID tracking block
                }

                globalSongCache[cacheKey] = trackPayload
                pendingCloudCacheUploads[cacheKey] = trackPayload

                // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
                // Save the updated object map right after this station finishes its loop logic pass
                // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
                // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
                // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
                await flushRuntimeCacheToIndexedDb(globalSongCache);

            }

            // 1. Check if the track is playable in your region
            if (track.is_playable === false) {
                console.warn(`Skipping "${track.name}": Not playable in your region.`);
            // SEND THE LOG
            logEvent("WARN", `getTrackAtIndex - OUT_OF_REGION - Skipping "${track.name} - ${track.artists[0].name}": Not playable in your region.`, {
                step: "getTrackAtIndex",
                error: `OUT_OF_REGION`,
                track_name: track.name,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                return null;
            }

            // 2. Check for explicit content restrictions (if you want to avoid 403s on filtered accounts)
            if (track.explicit && localStorage.getItem('filter_explicit') === 'true') {
                console.warn(`Skipping "${track.name}": Explicit content filtered.`);
            // SEND THE LOG
            logEvent("WARN", `getTrackAtIndex - EXPLICIT_CONTENT - Skipping "${track.name}": Explicit content filtered.`, {
                step: "getTrackAtIndex",
                error: `EXPLICIT_CONTENT`,
                track_name: track.name,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                return null;
            }

            // 3. Check for specific 'restrictions' (usually 'market' or 'product')
            if (track.restrictions) {
                console.warn(`Skipping "${track.name}": Restricted (${track.restrictions.reason}).`);
            // SEND THE LOG
            logEvent("WARN", `getTrackAtIndex - TRACK_RESTRICTED - Skipping "${track.name}": Restricted (${track.restrictions.reason}).`, {
                step: "getTrackAtIndex",
                error: `TRACK_RESTRICTED`,
                track_name: track.name,
                restricted_reason: track.restrictions.reason,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                return null;
            }

            // 4. Check for 'Local' files (Web SDK cannot stream these)
            if (track.is_local) {
                console.warn(`Skipping "${track.name}": Local file (cannot stream via SDK).`);
            // SEND THE LOG
            logEvent("WARN", `getTrackAtIndex - LOCAL_FILE - Skipping "${track.name}": Local file (cannot stream via SDK).`, {
                step: "getTrackAtIndex",
                error: `LOCAL_FILE`,
                track_name: track.name,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                return null;
            }

            return track; 
        }
        else {
            console.error("getTrackAtIndex - No track found at this index:", index);
            // SEND THE LOG
            logEvent("WARN", `getTrackAtIndex - NO_TRACK_FOUND - No track found at this index: ${index}`, {
                step: "getTrackAtIndex",
                error: `NO_TRACK_FOUND`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return null;
        }
    } 
    catch(err){
        console.error("Fetch error in getTrackAtIndex:", err);
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - FETCH_ERROR`, {
                step: "getTrackAtIndex",
                error: `GETTRACK_FETCH_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        // If it's a network error, don't just return null, throw it!
        if (err.message.includes('Failed to fetch') || !navigator.onLine) {
            showResult(`%c Network disconnected. Please check your internet.`, "color: #ff0000;")
            visualLog(`%c Getting track from playlist - Network disconnected. Please check your internet.`, "color: #ff0000;")
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - NETWORK_ERROR - Network disconnected. Please check your internet.`, {
                step: "getTrackAtIndex",
                error: `NETWORK_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            if(!navigator.onLine){
            showResult(`%c Network disconnected. !navigator.onLine.`, "color: #ff0000;")
            visualLog(`%c Getting track from playlist - Network disconnected. !navigator.onLine`, "color: #ff0000;")
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - NETWORK_ERROR - Network disconnected. !navigator.onLine`, {
                step: "getTrackAtIndex",
                error: `NETWORK_ERROR_NAV_OFFLINE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            }

            return "NETWORK_ERROR"; 
        }
        return null
    }
}

function getRainbowColor(count, minCount, maxCount) {
 
    // Scale 0 to maxCount onto 0 to 280 (Red to Purple)
    //alert(`${minCount}`)
    let hue = (((count - minCount) / (maxCount - minCount)) * 280);
    return `hsl(${hue}, 90%, 70%)`;
}

function incrementPlaylistCount(playlistId) {
    const playlist = playlists.find(p => p.id === playlistId);
    if (playlist) {
        playlist.pickCount = (playlist.pickCount || 0) + 1;
        renderPlaylists(); // Refresh the rainbow colors
    }
}

function renderStoredMixes() {
    const container = document.getElementById('stored-mixes-list');
    
    // // 1. Grab the big state object
    // const stored = localStorage.getItem("spotifyAppState");
    // if (!stored) return;

    // const state = JSON.parse(stored);
    // const mixes = state.mixes || {}; // This is your object of mixes
    const mixIds = Object.keys(mixes); // These are your mix names/IDs

    // 2. Map through the keys of the mixes object
    container.innerHTML = mixIds.map(id => {
        return `
            <div class="mix-row" style="border-bottom: 1px solid #282828;">
                <input type="checkbox" class="combine-check" value="${id}" 
                       data-name="${mixes[id].name}" onchange="updateNewMixName()">
                <span class="mix-label" style="padding: 10px">${mixes[id].name}</span>
            </div>
        `;
    }).join('');
}

// Pre-populates the input box with "MixA + MixB"
function updateNewMixName() {
    const selectedNames = Array.from(document.querySelectorAll('.combine-check:checked'))
                               .map(cb => cb.dataset.name);
    document.getElementById('combine-mix-name').value = selectedNames.join(' + ');
}

function combineSelectedMixes() {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    const selectedKeys = Array.from(document.querySelectorAll('.combine-check:checked')).map(cb => cb.value);
    const newName = document.getElementById('combine-mix-name').value || "New Combined Mix";
    
    if (selectedKeys.length < 2) return alert("Select at least two mixes to combine.");

    //let combinedPlaylists = new Map();
    let newcombinedPlaylists = []

    selectedKeys.forEach(key => {
        const mixData = mixes[key];
        // Assuming each mix is an array of playlist objects
        console.log(`new key`)
        mixData.playlists.forEach(p => {
            console.log(`${p.name}`)
            // Use Spread Operator to create a shallow CLONE of the playlist
            // This prevents "mutating" the original playlist object
            //combinedPlaylists.set(p.id, { ...p }); 
            const newPlaylist = structuredClone(p)
            newcombinedPlaylists.push(newPlaylist)
        });
    });

    // 1. Create a clean array from your Map
    //const finalPlaylists = Array.from(combinedPlaylists.values());

    // 2. Create the Mix OBJECT (not just an array)
    // const newMixObject = {
    //     name: newName,
    //     playlists: newcombinedPlaylists // Put the array inside the 'playlists' property
    // };


    const newId = Date.now().toString()

    mixes[newId] = {
        name: newName,
        playlists: structuredClone(newcombinedPlaylists),
        selectionMode: "balanced"
    }

    //mixes[newId] = newMixObject;
    activeMixId = newId;
    playlists = structuredClone(mixes[activeMixId].playlists)

    saveAppState()
    renderMixSelector()
    renderPlaylists()
                        // SEND THE LOG
                        logEvent("WARN", `combineSelectedMixes | ${mixes[newId].name}`, {
                            step: "combineSelectedMixes",
                            error: "COMBINE_MIXES",
                            mix_name: mixes[newId].name,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
    
    console.warn(`Created new mix: ${newName}`);
    alert(`Created new mix: ${newName}`);
    renderStoredMixes(); // Refresh the list
}

// Add this button to your existing UI controls
// <button onclick="addActiveToCombineList()">Add Current to Combiner</button>

function addActiveToCombineList() {
    //const activeMixName = document.getElementById('mix-dropdown').value;
    const checkbox = document.querySelector(`.combine-check[value="${activeMixId}"]`);
    

    // const select = document.getElementById("mix-selector")

    // Object.entries(mixes).forEach(([id, mix]) => {
    //     const opt = document.createElement("option")
    //     opt.value = id
    //     opt.textContent = mix.name
    //     if(id === activeMixId) opt.selected = true
    //     select.appendChild(opt)
    // })


    if (checkbox) {
        checkbox.checked = true;
        updateNewMixName();
        // Scroll to the combiner section so the user sees it happened
        document.getElementById('mix-combiner-section').scrollIntoView({ behavior: 'smooth' });
                        // SEND THE LOG
                        logEvent("WARN", `addActiveToCombineList | ${mixes[activeMixId].name}`, {
                            step: "addActiveToCombineList",
                            error: "SELECTED_CURRENT_MIX_COMBINE",
                            mix_name: mixes[activeMixId].name,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
    }
}

function addFolderToConfiguration(name) {
    const newFolder = {
        id: 'folder_' + Date.now(),
        type: 'folder',
        name: name,
        isExpanded: true,
        folderBalancingEnabled: false,
        sliderValue: 50,
        pickCounter: 0,
        isEnabled: true,
        playlists: [] // Loose elements will be dragged into here later
    };
    currentMixConfiguration.nodes.push(newFolder);
    renderMixInterface(); // Refresh layout views
}

function createNewFolder(folderName) {
    if (!folderName.trim()) return;

    // Check if your profile has the folders array initialized (for old setups)
    if (!activeMixProfile.folders) {
        activeMixProfile.folders = [];
    }

    const newFolder = {
        id: 'folder_' + Date.now(),
        name: folderName,
        isExpanded: true,
        folderBalancingEnabled: false, // Default state
        sliderValue: 50,               // Default weight midpoint
        pickCounter: 0,
        isEnabled: true
    };

    activeMixProfile.folders.push(newFolder);
    saveMixToLocalStorage(); // Keep states updated
    
    // Rerender your view
    renderMixInterface();
}

const submitFolderBtn = document.getElementById('submit-folder-btn');
if (submitFolderBtn) {
    submitFolderBtn.addEventListener('click', () => {
        const inputField = document.getElementById('folder-name-input');
        createNewFolder(inputField.value);
        inputField.value = ''; // Reset form input string context
    });
}

function createDefaultMix() {
    console.warn("Creating Default Mix")
    const id = Date.now().toString()

    mixes[id] = {
        name: "Default Mix",
        playlists: structuredClone(playlists),
        selectionMode: "balanced"
    }

    activeMixId = id
    saveAppState()
    renderMixSelector()
}

function renderMixSelector(){
    const select = document.getElementById("mix-selector")
    select.innerHTML = ""

    Object.entries(mixes).forEach(([id, mix]) => {
        //console.log(`here's a mix`)
        const opt = document.createElement("option")
        opt.value = id
        opt.textContent = mix.name
        if(id === activeMixId) opt.selected = true
        select.appendChild(opt)
    })
}


function renderPlaylists() {
    const container = document.getElementById("playlist-list")
    container.innerHTML = ""


    const maxCount = Math.max(...playlists.map(p => p.pickCount || 0));
    const minCount = Math.min(...playlists.map(p => p.pickCount || 0));
    let maxPercentage = Math.max(...playlists.map(p => p.sliderValue || 0))
    maxPercentage += (maxPercentage / 100 * 50);
    maxPercentage = Math.min(maxPercentage, 100)
    if(selectionMode !== "percentage") maxPercentage = 100
    //maxPercentage = 100

    let maxPlaylistNameLength = Math.max(...playlists.map(p => p.name.length || 0))
  
    playlists.forEach((playlist, index) => {

        // When loading or adding a playlist
        playlist.pickCount = playlist.pickCount || 0;
        
        playlist._renderColor = getPlaylistColorByIndex(index)
        
        const div = document.createElement("div")
        div.className = "playlist-row"
        //div.draggable = true; //enable dragging
        div.dataset.index = index; // store the original position


        // //Add styling for the "drag handle" look
        // div.style.padding = "8px";
        // //div.style.display = "flex"
        // div.style.borderBottom = "1px solid #282828";
        // div.style.cursor = "grab";
        // div.style.alignItems = "center"; 
        // div.style.gap = "10px"; 
        // div.style.marginBottom = "20px"; 
        // div.style.justifyContent = "center";
        // div.style.flexGrow = "1"
        // div.style.overflowX = "auto";

// Parent Styling for Horizontal Scroll
div.style.display = "flex"; // Must be flex
div.style.flexWrap = "nowrap"; // Force everything onto one line
div.style.padding = "8px";
div.style.borderBottom = "1px solid #282828";
div.style.cursor = "grab";
div.style.alignItems = "center";
div.style.gap = "15px"; // Give items room
div.style.width = "100%"; // Container fills viewport, content expands past it


        // Create your handle
        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.innerHTML = '☰';
        handle.style.cssText = "color: #535353; margin-right: 10px; cursor: grab;";

        const color = getRainbowColor(playlist.pickCount , minCount, maxCount);



div.innerHTML = `
    <!-- LEFT AREA: No shrink, fixed at its content size -->
    <div class="controls-left" style="display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-width: max-content;">
        <input type="checkbox" class="playlist-enabled" ${playlist.enabled ? "checked" : ""}>
        <button class="playlist-solo-btn" style="background: transparent; border: none; cursor: pointer; font-size: 1.1rem; padding: 0;" data-id="${playlist.id}" title="Solo this playlist">🎯</button>

        <div class="slider-group" style="display: flex; align-items: center; gap: 5px; width: 250px;">
            <button class="step-btn step-down" data-index="${index}">◀</button>
            <input type="range" min="0" max="${maxPercentage}" value="${playlist.sliderValue ?? 50}" style="cursor: pointer; flex-grow: 1;" class="playlist-slider"  data-index="${index}">
            <button class="step-btn step-up" data-index="${index}">▶</button>
        </div>
    </div>

    <!-- RIGHT AREA: Also forced not to shrink -->
    <div class="playlist-info-right" style="display: flex; align-items: center; gap: 15px; flex-shrink: 0; min-width: max-content;">
        <div class="slider-val-del-button" style="display: flex; align-items: center; gap: 10px;">
            <span class="slider-value" style="width: 45px; text-align: right; font-family: monospace;"></span>
            <button class="delete-btn">Delete</button>
            <span class="pick-counter" style="width: 30px; text-align: center; padding: 2px; background: #1a1a1a; color: ${color}; font-weight: bold;">
                ${playlist.pickCount}
            </span>
        </div>
        <!-- Name will now expand to its full length without wrapping -->
    <span style="flex-grow: 1; text-align: center; font-weight: 500; width: ${maxPlaylistNameLength + 5}ch">
        ${playlist.name} (${playlist.trackCount}) songs
    </span>
    </div>
`;

        // 5. Put the handle at the very beginning of the row
        div.prepend(handle);

        // div.innerHTML = `
        //         <input type="checkbox" class="playlist-enabled" ${playlist.enabled ? "checked" : ""}>
        //         <input type="range" min="0" max="100" value="${playlist.sliderValue ?? 50}" class="playlist-slider" data-index="${index}">
        //         <span class="slider-value"></span>
        //         <button class="delete-btn">Delete</button>
        //         ${playlist.name} (${playlist.trackCount}) songs
        // `

        // --- THE LOGIC: ONLY DRAG ON HANDLE ---
        handle.addEventListener('mousedown', () => {
            div.setAttribute('draggable', 'true');
        });

        // If they let go without dragging, turn it back off
        handle.addEventListener('mouseup', () => {
            div.setAttribute('draggable', 'false');
        });

        // --- ATTACH DRAG EVENTS ---
        div.addEventListener('dragstart', handleDragStart);
        div.addEventListener('dragover', handleDragOver);
        div.addEventListener('drop', handleDrop);
        div.addEventListener('dragend', handleDragEnd);
        // Add this to your event listeners in the loop:
        div.addEventListener('dragenter', (e) => e.preventDefault());

        // Add your touch listeners for mobile
        addTouchListeners(div);

        const checkBox = div.querySelector("input[type='checkbox']")
        const slider = div.querySelector(".playlist-slider")
        //disable slider when in balanced mode
        const sliderDisabled = selectionMode === "balanced"
        //slider.disabled = sliderDisabled || !playlist.enabled
        slider.disabled = false
        slider.style.opacity = slider.disabled ? 0.4 : 1
        slider.style.pointerEvents = sliderDisabled ? "none" : "auto"
        slider.style.pointerEvents = "auto"
        
        const display = div.querySelector(".slider-value")
        

        //display.textContent = `${playlist.enabled ? playlist.sliderValue ?? 50 : 0}`
        //display.textContent = playlist.sliderValue ?? 50
	    display.textContent = playlist.sliderValue ?? (selectionMode === "balanced" ? "Eq" : 50); //Set the initial text for the slider value so it isn't blank on load

        // Checkbox change
        checkBox.onchange = () => {
            //selectionMode = "weighted"
            playlists[index].enabled = checkBox.checked
            //slider.disabled = !checkBox.checked   // <- NEW LINE

            if(selectionMode === "percentage"){
                normalizePercentagesAfterToggle()
                syncSlidersFromState()
                console.log(`normalize ${Date.now().toString()}`)
            }

            saveAppState()
            renderPlaylists()
        }

        // Slider change
        //slider.oninput = () => {
        slider.addEventListener("input", () => {


            if(isProgrammaticSliderUpdate) return

            playlist.sliderValue = Math.min(100, Number(slider.value))
            display.textContent = slider.value

            //If in normal mode, moving slider switches to slider mode
            if((selectionMode === "normal")){
                selectionMode = "relative"
                setSelectionMode(selectionMode)
                syncSlidersFromState()
                updateSliderDisplay(slider)

                //update radio button
                //document.querySelector('input[value="percentage"]').checked = true
                //normalizePercentagesAfterToggle() //REMOVED - This will snap values back instead of using the user's slider value
                console.log(`%c Relative mode enabled when you moved the slider`, "color: #0004ff;")
                showResult(`%c Relative mode enabled when you moved the slider`, "color: #0004ff;")
                visualLog(`%c Relative mode enabled when you moved the slider`, "color: #0004ff;")
            }
            //If in normal mode, moving slider switches to slider mode
            if((selectionMode === "balanced")){
                selectionMode = "percentage"
                setSelectionMode(selectionMode)
                syncSlidersFromState()
                updateSliderDisplay(slider)

                //update radio button
                //document.querySelector('input[value="percentage"]').checked = true
                //normalizePercentagesAfterToggle() //REMOVED - This will snap values back instead of using the user's slider value
                console.log(`%c Percentage mode enabled when you moved the slider`, "color: #0004ff;")
                showResult(`%c Percentage mode enabled when you moved the slider`, "color: #0004ff;")
                visualLog(`%c Percentage mode enabled when you moved the slider`, "color: #0004ff;")
            }

            if(selectionMode === "percentage"){
                rebalancePercentagesByIndex(index)
                syncSlidersFromState()
                updateSliderDisplay(slider)
                //renderPlaylists();
            }
                        
            //Slider at 0 disables playlist
            if(playlist.sliderValue <= 0){
                playlist.enabled = false
                checkBox.checked = false
            }
            // else{
            //     playlist.enabled = true
            //     checkBox.checked = true
            // }
            saveAppState()
        })

        // //slider.onchange = () => {
        // slider.addEventListener("change", () => {
        //     isProgrammaticSliderUpdate = true
        //     syncSlidersFromState()
        //     //saveAppState()
        //     isProgrammaticSliderUpdate = false
        // })

        // Delete Playlist
        const deleteBtn = div.querySelector(".delete-btn")
        deleteBtn.onclick = () => {
            playlists.splice(index, 1)
            saveAppState()
            renderPlaylists()
            
            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 
        }

        // Inside your renderPlaylists loop:
        const refreshBtn = document.createElement("button");
        refreshBtn.textContent = "🔄";
        refreshBtn.onclick = () => refreshPlaylistCount(playlist.id, index);
        div.appendChild(refreshBtn);

        const playBtn = document.createElement("button");
        playBtn.textContent = "▶";
        playBtn.onclick = () => playFromSpecificPlaylist(playlist);
        div.appendChild(playBtn);


        container.appendChild(div)
    })

}

let draggedItem = null;

function addTouchListeners(item) {
    item.addEventListener('touchstart', (e) => {
        draggedItem = item;
        item.style.opacity = '0.5';
        // Prevent scrolling while dragging
        e.preventDefault(); 
    }, { passive: false });

    item.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        // Find which element is under the finger
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        const closestItem = target?.closest('.playlist-item');

        if (closestItem && closestItem !== draggedItem) {
            const container = closestItem.parentNode;
            const rect = closestItem.getBoundingClientRect();
            const next = (touch.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
            container.insertBefore(draggedItem, next ? closestItem.nextSibling : closestItem);
        }
    }, { passive: false });

    item.addEventListener('touchend', () => {
        draggedItem.style.opacity = '1';
        draggedItem = null;
        savePlaylistOrder(); // Your function to sync with localStorage
    });
}

let dragSourceIndex = null;

function handleDragStart(e) {
    dragSourceIndex = this.dataset.index;
    this.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
}

// Update your handleDragOver to be explicit:
function handleDragOver(e) {
    e.preventDefault(); // REQUIRED: Tells the browser "this is a valid drop zone"
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDrop(e) {
    if (e.preventDefault) e.preventDefault();
    e.stopPropagation();
    
    const targetIndex = parseInt(this.dataset.index);
    const sourceIndex = parseInt(dragSourceIndex);

    if (sourceIndex !== targetIndex) {
        // --- THE FIX ---
        // Use the same 'playlists' array that renderPlaylists uses
        const movedItem = playlists.splice(sourceIndex, 1)[0];
        playlists.splice(targetIndex, 0, movedItem);

        // If you are using a Mix system, make sure the Mix is updated too
        if (mixes && activeMixId) {
            mixes[activeMixId].playlists = playlists;
        }

        saveAppState();
        renderPlaylists(); 
    }
    return false;
}

function handleDragEnd() {
    this.style.opacity = '1';
    // Remove any visual "hover" indicators you might add later
    this.setAttribute('draggable', 'false'); // Reset here
}

function addTouchListeners(item) {
    const handle = item.querySelector('.drag-handle');
    
    // Change 'item' to 'handle' for the touchstart trigger
    handle.addEventListener('touchstart', (e) => {
        draggedItem = item;
        item.style.opacity = '0.5';
        // e.preventDefault(); // Keep this if you want to block scrolling while dragging
    }, { passive: false });

    // The move and end listeners should still track the finger globally
    item.addEventListener('touchmove', (e) => {
        if (!draggedItem) return; // Only move if we started on a handle
        e.preventDefault();
        // ... rest of your touchmove logic ...
    }, { passive: false });
}

//Save playlists array to localStorage
//No longer used
function savePlaylists(){
    localStorage.setItem('playlists', JSON.stringify(playlists))
}


document.getElementById('add-playlist').onclick = async () => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    const input = document.getElementById('new-playlist-name').value.trim();
    let playlistData;

    // Robust Spotify ID extraction using Regex
    const spotifyIdRegex = /(?:playlist[:\/])([a-zA-Z0-9]{22})/;
    const match = input.match(spotifyIdRegex);

    if (match && match[1]) {
        const id = match[1]; // match[1] is the captured 22-character ID
        showResult(`%c Fetching Spotify data... ${id}`, "color: #000000;")
        visualLog(`%c Fetching Spotify data... ${id}`, "color: #000000;")
        console.log(`Fetching Spotify data... ${id}`);
        playlistData = await getSpotifyPlaylistData(id);
    } else if (input.length === 22 && !input.includes(' ')) {
        // Fallback: If they just paste the raw 22-character ID
        showResult(`%c Fetching Spotify data... ${id}`, "color: #000000;")
        visualLog(`%c Fetching Spotify data... ${id}`, "color: #000000;")
        console.log(`Fetching Spotify data... ${id}`);
        playlistData = await getSpotifyPlaylistData(input);
    } else {        // Fallback to manual entry if it's just a name
        const count = parseInt(document.getElementById('new-playlist-count').value);
        if (!input || isNaN(count)) return alert("Enter name and count OR a Spotify Link");
        
        playlistData = {
            id: Date.now().toString(),
            name: input,
            trackCount: count,
            enabled: true,
            sliderValue: 50
        };
    }

    if (playlistData) {
        playlists.push(playlistData);
        saveAppState();
        renderPlaylists();
        document.getElementById('new-playlist-name').value = '';
        document.getElementById('new-playlist-count').value = '';
    }
}
document.getElementById('add-playlist').oncancel = () => {
    const nameInput = document.getElementById('new-playlist-name')
    const countInput = document.getElementById('new-playlist-count')

    const name = nameInput.value.trim()
    const count = parseInt(countInput.value)

    if(!name || isNaN(count) || count < 1) {
        alert("Enter valid name and track count")
        return
    }

    const newID = Date.now().toString() // unique ID
    playlists.push({
        id: newID, 
        name: name, 
        trackCount: count, 
        enabled: true, 
        sliderValue: 50
    })
    saveAppState()
    renderPlaylists()

    //clear input
    //nameInput.value = ''
    //countInput.value = ''
}

function deleteCurrentMix() {
    const mixName = mixes[activeMixId].name;
    
    // 1. Safety Confirmation (Always a good idea for destructive actions)
    if (!confirm(`Are you sure you want to permanently delete the mix "${mixName}"?`)) {
        return;
    }

    // 2. Remove the mix from your memory object
    delete mixes[activeMixId];

    // 3. Find a new mix to switch to
    const remainingIds = Object.keys(mixes);
    if (remainingIds.length > 0) {
        activeMixId = remainingIds[0];
    } else {
        // If all are gone, create a fresh default mix
        createDefaultMix(); 
    }

    renderStoredMixes();  // Update the combiner list too!

    // 4. Commit changes to localStorage and refresh UI
    saveAppState();
    renderMixSelector(); // Update the dropdown list
    renderPlaylists();    // Update the playlist view for the new active mix
    
    console.log(`%c Deleted mix: ${mixName}`, "color: #0004ff;")
    showResult(`%c Deleted mix: ${mixName}`, "color: #0004ff;")
    visualLog(`%c Deleted mix: ${mixName}`, "color: #0004ff;")
}

function generateShareLink() {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    if (!activeMixId || !mixes[activeMixId]) return alert("Select a mix first!");

    const mixData = mixes[activeMixId];
    // We stringify the mix and encode it so it's safe for a URL
    const jsonString = JSON.stringify(mixData);
    //const base64Data = btoa(unescape(encodeURIComponent(jsonString))); 
    
    //const shareUrl = `${window.location.origin}/?import_mix=${base64Data}`;

    // // Copy to clipboard
    // navigator.clipboard.writeText(shareUrl).then(() => {
    //     showResult("Share link copied to clipboard!");
    //     alert("Share link copied! Send this URL to a friend.");
    // }).catch(err => {
    //     console.error("Link copy failed:", err);
    //     alert("Copy failed. Here is your link: " + shareUrl);
    // });
    // Copy to clipboard or show in a prompt
    navigator.clipboard.writeText(jsonString).then(() => {
                        // SEND THE LOG
                        logEvent("WARN", `generateShareLink | Mix Code copied! Paste this on your other device.`, {
                            step: "generateShareLink",
                            error: "GENERATE_SHARE_LINK_SUCCESS",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
        showResult(`%c Mix Code copied! Paste this on your other device.`, "color: #0004ff;")
        visualLog(`%c Mix Code copied! Paste this on your other device.`, "color: #0004ff;")
        alert("Mix Code copied! Paste this on your other device.");
    }).catch(err => {
                        // SEND THE LOG
                        logEvent("ERROR", `generateShareLink | Mix copy failed: ${err}`, {
                            step: "generateShareLink",
                            error: "GENERATE_SHARE_LINK_FAIL",
                            stack_trace: new Error().stack, // Auto-trace errors
                            error_message: err,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
        console.error("Mix copy failed:", err);
        alert("Mix Copy failed.");
    });
}

async function importMix() {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    try {
        // Request text from the system clipboard
        const text = await navigator.clipboard.readText();
        if (!text) {
            showResult(`%c 📋 Clipboard is empty.`, "color: #ff8800;")
            visualLog(`%c 📋 Clipboard is empty.`, "color: #ff8800;")
            alert("📋 Clipboard is empty.");
            return;
        }
        // Decode from Base64
        const sharedMix = JSON.parse(text);
        
        // Give it a unique ID so it doesn't overwrite existing mixes
        const newId = "shared_" + Date.now();
        
        loadAppState()
        // Add to your global mixes object
        if (!mixes) mixes = {}; 
        mixes[newId] = sharedMix;
        activeMixId = newId;

        playlists = structuredClone(mixes[activeMixId].playlists)
            // CRITICAL: Save to storage immediately so loadAppState() doesn't overwrite it
            //localStorage.setItem('mixes', JSON.stringify(mixes)); 
            //localStorage.setItem('activeMixId', newId);
            // CRITICAL: Save to storage immediately so loadAppState() doesn't overwrite it
            // Save and clean the URL
            saveAppState();
            renderMixSelector();
                        // SEND THE LOG
                        logEvent("WARN", `importMix | Mix imported successfully! Refreshing...`, {
                            step: "importMix",
                            error: "IMPORT_MIX_SUCCESS",
                            mix_name: sharedMix.name,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
        alert("Mix imported successfully! Refreshing...");
        console.log(`%c Imported Mix: ${sharedMix.name}`, "color: #0004ff;")
        showResult(`%c Imported Mix: ${sharedMix.name}`, "color: #0004ff;")
        visualLog(`%c Imported Mix: ${sharedMix.name}`, "color: #0004ff;")
        //window.location.reload();
    }
    catch (e) {
                        // SEND THE LOG
                        logEvent("ERROR", `importMix | Failed to import shared mix: ${e}`, {
                            step: "importMix",
                            error: "IMPORT_MIX_FAIL",
                            stack_trace: new Error().stack, // Auto-trace errors
                            error_message: e,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
        console.error("Failed to import shared mix:", e);
        showResult(`%c Error: Invalid share link.`, "color: #ff0000;")
        visualLog(`%c Error: Invalid share link.`, "color: #ff0000;")
        alert("Invalid Mix Code. Please try again.");
    }
}

async function fetchUserPlaylists() {
    const token = localStorage.getItem('access_token');
    if (!token) return;

    try {
        const response = await safeSpotifyFetch('https://api.spotify.com', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();

        // Map Spotify's data format to your app's format
        playlists = data.items.map(item => ({
            id: item.id,
            name: item.name,
            trackCount: item.tracks.total,
            enabled: true,
            sliderValue: 50
        }));

        renderPlaylists();
        saveAppState(); // Save these real playlists to your 'Mix'
        showResult(`Loaded ${playlists.length} playlists from Spotify`);
    } catch (err) {
        console.error("Failed to fetch playlists:", err);
    }
}

// --- FIX THIS FUNCTION ---
async function xgetSpotifyPlaylistData(playlistId) {
    const token = localStorage.getItem('access_token');
    if (!token) return null;

    // USE BACKTICKS ` and include /v1/playlists/
    const url = `https://api.spotify.com/v1/playlists/${playlistId}`;

    try {
        showResult(`await fetch(${url}` )
        const response = await safeSpotifyFetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            // Handle common 404 or 403 errors for private playlists
            throw new Error(errorData.error.message || "Playlist not found");
        }
        
        const data = await response.json();
        console.log("Spotify API Response:", data); // OPEN YOUR CONSOLE (F12) TO SEE THIS
        console.log("Full Tracks Object:", data.tracks); // Check if this is an object or a number
        return {
            id: data.id,
            name: data.name,
            // Change this:
            //trackCount: data.tracks.total,

            // To this (safer for 2026):
            //trackCount: data.tracks ? data.tracks.total : (data.items ? data.items.length : 0)
            // Fix: Spotify 2026 now uses 'items' instead of 'tracks' for the count
            //trackCount: data.items ? data.items.total : (data.tracks ? data.tracks.total : 0),
            // Try this specific nesting which is the standard for the Get Playlist endpoint
            //trackCount: data.tracks?.total || data.items?.total || 0,
            // Fix: Access tracks.total specifically
            trackCount: (data.tracks && typeof data.tracks === 'object') ? data.tracks.total : 0,
            enabled: true,
            sliderValue: 50        };
            } catch (err) {
        alert("Error fetching Spotify playlist: " + err.message);
        return null;
    }
}
async function getSpotifyPlaylistData(playlistId) {
    const token = localStorage.getItem('access_token');
    if (!token) return null;
    const currentUserId = localStorage.getItem('spotify_user_id') || await getCurrentUserId();

    // Use the /items endpoint - it's more direct for track data in 2026
    //const url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=1`;
    // Fetch the main playlist metadata, NOT the items/tracks sub-endpoint
    //const url = `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks.total`;
    //const url = `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,total`;
    //const url = `https://api.spotify.com/v1/playlists/${playlistId}`;
    let url = `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,owner.id,tracks.total`;

    try {
        console.log(`await fetch(${url}` )
        let response = await safeSpotifyFetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if(response === "MAX_CALLS_PER_MINUTE"){
            console.warn("getSpotifyPlaylistData - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "getSpotifyPlaylistData",
                error: `MAX_CALLS_PER_MINUTE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "SOFT_LOCKED"){
            console.warn("getSpotifyPlaylistData - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "getSpotifyPlaylistData",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "429_MAX_STRIKES"){
            console.warn("getSpotifyPlaylistData - safeSpotifyFetch - 429_MAX_STRIKES")
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "getSpotifyPlaylistData",
                error: `429_MAX_STRIKES`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "429_STRIKE"){
            console.warn("getSpotifyPlaylistData - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - safeSpotifyFetch - 429_STRIKE`, {
                step: "getSpotifyPlaylistData",
                error: `429_STRIKE`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "401_TOKEN_EXPIRED"){
            console.warn("getSpotifyPlaylistData - safeSpotifyFetch - 401_TOKEN_EXPIRED")
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - safeSpotifyFetch - 401_TOKEN_EXPIRED`, {
                step: "getSpotifyPlaylistData",
                error: "401_TOKEN_EXPIRED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        if(!response.ok){
            console.log(`Error grabbing new Playlist data`, "color: #ff00c800")
            visualLog(`Error grabbing new Playlist data`, "color: #ff00c800")
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - safeSpotifyFetch - BLOCKED`, {
                step: "getSpotifyPlaylistData",
                error: `GETPLAYLISTDATA_FETCH_BLOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                
            throw new Error(errorData?.error?.message || "Forbidden or Not Found");
                }
        }
        const data = await response.json();

        let namedata

        console.log("Spotify API Response:", data); // OPEN YOUR CONSOLE (F12) TO SEE THIS
        console.log("Keys available in this object:", Object.keys(data));
        console.log("Full Tracks Object:", data.tracks); // Check if this is an object or a number
        console.log("Full Tracks Object:", data.total); // Check if this is an object or a number
        console.log("Full Tracks Object:", data.tracks?.total); // Check if this is an object or a number
        console.log("Full Tracks Object:", data.total_tracks); // Check if this is an object or a number
        
        // CHECK OWNERSHIP
        const isOwner = data.owner.id === currentUserId;

        // Use the /items endpoint we fixed earlier to get the real count
        url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=1`;

        try {
            response = await safeSpotifyFetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if(response === "MAX_CALLS_PER_MINUTE"){
                console.warn("getSpotifyPlaylistData checkOwnership - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            }
            if(response === "SOFT_LOCKED"){
                console.warn("getSpotifyPlaylistData checkOwnership - safeSpotifyFetch - SOFT_LOCKED")
            }
            if(response === "429_MAX_STRIKES"){
                console.warn("getSpotifyPlaylistData checkOwnership - safeSpotifyFetch - 429_MAX_STRIKES")
            }
            if(response === "429_STRIKE"){
                console.warn("getSpotifyPlaylistData checkOwnership - safeSpotifyFetch - 429_STRIKE")
            }
            if(response === "401_TOKEN_EXPIRED"){
                console.warn("getSpotifyPlaylistData - safeSpotifyFetch - 401_TOKEN_EXPIRED")
            }

            namedata = await response.json();
            
            if (namedata.total !== undefined) {
                //showResult(`Updated ${data.name} to ${namedata.total} songs.`);
                visualLog(`%c Updated ${data.name} to ${namedata.total} songs.`, "color: #000000;")
                console.log(`%c Updated ${data.name} to ${namedata.total} songs.`, "color: #000000;")
            }
        } catch (err) {
            console.error("getSpotifyPlaylistData - Refresh failed:", err);
        }

        // We also need the playlist NAME, so we do one more quick fetch 
        // or just use the ID as a placeholder if name isn't critical yet.
        // const nameRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name`, {
        //     headers: { 'Authorization': `Bearer ${token}` }
        // });
        //const nameData = await nameRes.json();
        console.log("Spotify API Response:", data); // OPEN YOUR CONSOLE (F12) TO SEE THIS
        console.log("nameData:", data.name); // Check if this is an object or a number

        if (!isOwner) {
            // SEND THE LOG
            logEvent("WARN", `getSpotifyPlaylistData - NOT_OWNER`, {
                step: "getSpotifyPlaylistData",
                error: `NOT_OWNER`,
                playlist: data.name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            const confirmDup = confirm(
                `You don't own "${data.name}". Due to Spotify's 2026 rules, I can't read the songs unless you duplicate it to your account. \n\n
                Would you like me to try and create a copy for you? \n\n
                Note that this will only create an empty playlist with the same name, you will still need to manually (in spotify or spotify app itself) "Select All" tracks from the original playlist and "Add to" your new empty playlist that YOU own. \n\n
                This will merely create an empty playlist as a placeholder`
            );
            if (confirmDup) {
                return await duplicatePlaylist(playlistId, data.name);
            }
            return null; 
        }

            // SEND THE LOG
            logEvent("INFO", `getSpotifyPlaylistData - SUCCESS - ${data.name}`, {
                step: "getSpotifyPlaylistData",
                error: `SUCCESS`,
                playlist: data.name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return {
            id: playlistId,
            name: data.name || "Spotify Playlist",
            //trackCount: data.total || 0, // 'total' is a top-level field in the /tracks endpoint
            // This 'total' field is usually available even for unowned playlists
            trackCount: namedata?.total || namedata.total_tracks || 0,
            enabled: true,
            sliderValue: 50
        };
    }
    catch (err) {
        console.warn("getSpotifyPlaylistData - Error: " + err.message);
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - ERROR - ${err.message}`, {
                step: "getSpotifyPlaylistData",
                error: `ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                error_message: err.message,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        return null;
    }
}

async function duplicatePlaylist(oldId, oldName) {
    const token = localStorage.getItem('access_token');
    const userId = localStorage.getItem('spotify_user_id');

    //const response = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
    const response = await safeSpotifyFetch(`https://api.spotify.com/v1/me/playlists`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            name: `${oldName} (Mixer Copy)`,
            description: "Created by Ben Burt's Mixer to allow playback.",
            public: true
        })
    });
    
    const newPlaylist = await response.json();
            // SEND THE LOG
            logEvent("INFO", `duplicatePlaylist - DUPLLICATE_SUCCESS`, {
                step: "getSpotifyPlaylistData",
                error: `DUPLLICATE_SUCCESS`,
                playlist: newPlaylist.name,
                playlist_id: newPlaylist.id,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    alert(`Success! Created "${newPlaylist.name}". \n\nFinal Step: Open Spotify, go to the original playlist, select all songs, and add them to this new one.`);
    
    return {
        id: newPlaylist.id,
        name: newPlaylist.name,
        trackCount: 0, // Will update once they add songs
        enabled: true,
        sliderValue: 50
    };
}

async function refreshPlaylistCount(playlistId, playlistIndex) {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 
    // 1. Add the IDs to a Set
    const restrictedIds = new Set([
    "757OVZ8V0JdzE8eA05qaLa",
    "3HPDlPwGtZi5bxBYOGLEWd",
    "3ZrUs8aPnGwj0XohRQpcvh",
    "7nMQh4vmn567gapArxDiLQ",
    "2nDRY8T9SruY4U0Dy4OkTS",
    "0zMyia0KzbLTi0pEse7i0c",
    "5oe5s6xIGEITr0YHzlc0Ey"
    ]);

    //if(!restrictedIds.has(playlistId)){ //keep the radio stations updated always
    if(!stationNetwork.some(station => station.playlistId === playlistId)){ //keep the radio stations updated always
        if(SessionPlaylistTrackCountUpdated[`${activeMixId}${playlistId}`]?.updated){
            console.log(`%c Playlist already updated: ${playlists[playlistIndex].name}`, "color: #ff0000;")
            return; //it's already been updated once this session.
        }
    }

    const token = localStorage.getItem('access_token');
    // Use the /items endpoint we fixed earlier to get the real count
    const url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=1`;

    try {
        const response = await safeSpotifyFetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if(response === "MAX_CALLS_PER_MINUTE"){
            console.warn("refreshPlaylistCount - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `refreshPlaylistCount - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "refreshPlaylistCount",
                error: `MAX_CALLS_PER_MINUTE`,
                stack_trace: new Error().stack, // Auto-trace errors
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "SOFT_LOCKED"){
            console.warn("refreshPlaylistCount - safeSpotifyFetch - SOFT_LOCKED")
            // SEND THE LOG
            logEvent("ERROR", `refreshPlaylistCount - safeSpotifyFetch - SOFT_LOCKED`, {
                step: "refreshPlaylistCount",
                error: `SOFT_LOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "429_MAX_STRIKES"){
            console.warn("refreshPlaylistCount - safeSpotifyFetch - 429_MAX_STRIKES")
            // SEND THE LOG
            logEvent("ERROR", `refreshPlaylistCount - safeSpotifyFetch - 429_MAX_STRIKES`, {
                step: "refreshPlaylistCount",
                error: `429_MAX_STRIKES`,
                stack_trace: new Error().stack, // Auto-trace errors
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "429_STRIKE"){
            console.warn("refreshPlaylistCount - safeSpotifyFetch - 429_STRIKE")
            // SEND THE LOG
            logEvent("ERROR", `refreshPlaylistCount - safeSpotifyFetch - 429_STRIKE`, {
                step: "refreshPlaylistCount",
                error: `429_STRIKE`,
                stack_trace: new Error().stack, // Auto-trace errors
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        if(response === "401_TOKEN_EXPIRED"){
            console.warn("refreshPlaylistCount - safeSpotifyFetch - 401_TOKEN_EXPIRED")
            // SEND THE LOG
            logEvent("ERROR", `refreshPlaylistCount - safeSpotifyFetch - 401_TOKEN_EXPIRED`, {
                step: "refreshPlaylistCount",
                error: "401_TOKEN_EXPIRED",
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        if(!response.ok){
            console.error("Error: refreshPlaylistCount - safeSpotifyFetch blocked")
            // SEND THE LOG
            logEvent("ERROR", `refreshPlaylistCount - safeSpotifyFetch - BLOCKED`, {
                step: "refreshPlaylistCount",
                error: `REFRESHPLAYLIST_FETCH_BLOCKED`,
                stack_trace: new Error().stack, // Auto-trace errors
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                
                //throw new Error(errorData.error.message || "Forbidden or Not Found");
            }
            
            return
        }
        const data = await response.json();
        
        if (data.total !== undefined) {
            console.log(`Updated ${playlists[playlistIndex].name} from ${playlists[playlistIndex].trackCount} to ${data.total} songs.`);
            //showResult(`Updated ${playlists[playlistIndex].name} from ${playlists[playlistIndex].trackCount} to ${data.total} songs.`);
            if(data.total !== playlists[playlistIndex].trackCount) visualLog(`%c Updated ${playlists[playlistIndex].name} from ${playlists[playlistIndex].trackCount} to ${data.total} songs.`, "color: #d400ff;")

            playlists[playlistIndex].trackCount = data.total;
            saveAppState();
            renderPlaylists();
            // SEND THE LOG
            logEvent("TRACE", `refreshPlaylistCount - REFRESHPLAYLIST_SUCCESS - Updated ${playlists[playlistIndex].name} to ${data.total} songs.`, {
                step: "refreshPlaylistCount",
                error: `REFRESHPLAYLIST_SUCCESS`,
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        SessionPlaylistTrackCountUpdated[`${activeMixId}${playlistId}`] = {
            updated: true
        }
        console.log(`%c Playlist updated: ${playlists[playlistIndex].name}`, "color: #ff0000;")


    } catch (err) {
        console.error("refreshPlaylistCount - Refresh failed:", err);
            // SEND THE LOG
            logEvent("ERROR", `refreshPlaylistCount - REFRESHPLAYLIST_ERROR`, {
                step: "refreshPlaylistCount",
                error: `REFRESHPLAYLIST_ERROR`,
                stack_trace: new Error().stack, // Auto-trace errors
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
}

function loadAppState() {
    const stored = localStorage.getItem("spotifyAppState")
    if(stored){
        const state = JSON.parse(stored)
        mixes = state.mixes || {}
        activeMixId = state.activeMixId || null
        playlistContextEnabled = state.syncContextEnabled
    }

    if(!activeMixId){
        createDefaultMix()
    } 
    else{
        console.log(`loadapp mix: ${mixes[activeMixId].name}`)
        if(!mixes[activeMixId].playlists){
            createDefaultMix();
        }
        playlists = structuredClone(mixes[activeMixId].playlists)
    }

    saveAppState()
}

function saveAppState() {
    if (!activeMixId || !mixes[activeMixId]){
        console.warn("No active mix - creating default")
        createDefaultMix()
    }
    mixes[activeMixId].playlists = structuredClone(playlists)
    mixes[activeMixId].selectionMode = selectionMode; // Save the mode!

    localStorage.setItem("spotifyAppState", JSON.stringify({mixes, activeMixId}))
}

function updateUI(state) {
    if (!state) return;

    const {
        paused,
        position,
        duration,
        track_window: { current_track }
    } = state;

    // Update Metadata
    document.getElementById('track-name').textContent = current_track.name;
    document.getElementById('playlist-name').textContent = queuePlaylistsMap.get(current_track.id)?.name;
    document.getElementById('track-artist').textContent = current_track.artists[0].name;
    document.getElementById('album-art').src = current_track.album.images[0].url;
    document.getElementById('play-pause-btn').textContent = (paused || !devicePoweredOn) ? "▶" : "⏸";
    document.getElementById('play-pause-btn').style.background = "#1DB954"; // Spotify Green

    // // 3. Sync the Play/Pause Button icon
    // const playBtn = document.getElementById('play-pause-button');
    // playBtn.textContent = paused ? '▶️' : '⏸️';

    // 4. Snap the Progress Bar
    // This is critical for visibilitychange so the bar doesn't "jump"
    const progressBar = document.getElementById('progress-bar');
    progressBar.max = duration;
    progressBar.value = position;

    // 5. Update Timers (0:45 / 3:20)
    document.getElementById('current-time').textContent = formatTime(position);
    document.getElementById('duration-time').textContent = formatTime(duration);

    // 4. Volume Control
    const volumeBar = document.getElementById('volume-bar');
    player.getVolume().then(v => {
        volumeBar.value = v * 100
        //console.log(`%cVolume UI set: ${volumeBar.value}`, "color: #ff00c8;");
    });

}

let lastState = {
    position: 0,
    duration: 0,
    paused: true,
    timestamp: 0
};

function updateProgressBar() {
    //console.log(`updating`)
    if (!lastState.paused && !isDraggingProgress) {
        // Calculate how much time has passed since the last official SDK update
        const elapsedSinceUpdate = performance.now() - lastState.timestamp;
        const currentPosition = Math.min(lastState.position + elapsedSinceUpdate, lastState.duration);
        
        const progressPercent = (currentPosition / lastState.duration) * 100;

        // Update your UI elements
        const bar = document.getElementById('progress-bar');
        const timeDisplay = document.getElementById('current-time');

        //if (bar) bar.style.width = `${progressPercent}%`;
        if (bar) bar.value = currentPosition
        if (timeDisplay) timeDisplay.textContent = formatTime(currentPosition);
    }

    // Keep the loop running
    requestAnimationFrame(updateProgressBar);
}


// function showResult(text){
//     document.getElementById("result").textContent = text
// }
// function showResult(text) {
//     const resultEl = document.getElementById("result");
    
//     // Using innerHTML allows you to pass strings like "Status: <br> <b>Ready</b>"
//     resultEl.innerHTML = text;

//     // Optional: Auto-scroll to the bottom if it's a long log
//     resultEl.scrollTop = resultEl.scrollHeight;
// }
function showResult(message, ...styles) {
    const parts = message.split('%c');
    let resultHTML = '';
    let currentStyleIndex = 0;

    //console.log(`parts`, parts)

    // 1. Start with only the FIRST segment (before any %c)
    // Using parts instead of the whole 'parts' array prevents comma injection
    resultHTML += parts[0];

    // 2. Loop through subsequent segments, applying the next available style
    for (let i = 1; i < parts.length; i++) {
        const style = styles[currentStyleIndex] || '';
        parts[i] = parts[i].trim()
        resultHTML += `<span style="${style}">${parts[i]}</span>`;
        currentStyleIndex++;
    }
    //console.log(`%c resultHTML: ${resultHTML}`, "color: #0004ff;")
    const resultEl = document.getElementById("result");
    // Using innerHTML allows you to pass strings like "Status: <br> <b>Ready</b>"
    resultEl.innerHTML = resultHTML;
}


function toggleTouchBlock(enable) {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

    const shield = document.getElementById('screen-shield');
    const masterBtn = document.getElementById('touch-block-btn');

    if (enable) {
        shield.style.display = 'block';
        masterBtn.textContent = "Touch Block: ON";
        masterBtn.classList.add('btn-active');
        requestWakeLock(); // Keep screen alive
    } else {
        shield.style.display = 'none';
        masterBtn.textContent = "Touch Block: OFF";
        masterBtn.classList.remove('btn-active');
        releaseWakeLock(); // Allow screen to sleep
    }
}
// Screen Wake Lock API (Official)
// Modern Chrome supports a specific API just for this. It’s cleaner than the video hack but can "release" if you switch apps.
let wakeLock = null;
async function requestWakeLock() {
    // If we already have an active lock, don't request another one
    if (wakeLock !== null) {
        console.warn("Screen Wake is already locked")
        return;
    }
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.warn("🟢 Screen Wake Lock is aquired and active");
            // --- THE FIX: Listen for the system releasing the lock ---
            wakeLock.addEventListener('release', () => {
                console.log("🟡 Wake Lock was released by the system.");
                wakeLock = null; // Clear it so we can re-request later
            });
        }
        else{
            console.warn("No wakeLock in navigator");
        }
    } catch (err) {
        console.error(`❌ Wake Lock Error: ${err.name}, ${err.message}`);
        wakeLock = null;
    }
}
// Function to release Wake Lock
function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release();
        wakeLock = null;
        console.log("Wake Lock released.");
    }
}
// Re-request when the user comes back to the tab
document.addEventListener('visibilitychange', async () => {

    if (document.visibilityState === 'visible') {

        appVisible = true

        console.warn("App visibility changed - VISIBLE")
                    // SEND THE LOG
                    logEvent("DEBUG", `visibilitychange - App visibility changed: VISIBILE`, {
                        step: "visibilitychange",
                        error: `VISIBILITY_CHANGE_VISIBLE`,
                        strikeCount: rateLimitStrikes,
                        activeMix: activeMixId
                    });

        // 1. Manually pull the latest state from the SDK
        // This forces the SDK to talk to Spotify's servers and tell your app exactly where the song is,
        // which "wakes up" your progress bar.
        //if(player && musicPlayingOnDevice){
        if(player && devicePoweredOn){
            player.getCurrentState().then(async state => {

                // This behavior is likely caused by the Web Playback SDK's background timeout, 
                // which automatically terminates sessions after approximately 30 seconds of no playback to conserve system resources.
                // The situation you described—where connect() is successful but getCurrentState() returns null 
                // and the Media Session buttons fail—indicates a desynchronization between your app's state and Spotify's servers.
                // Queue Clearing: The Spotify queue does not update consistently when using the Web Playback SDK. 
                // When a player disconnects due to a timeout, the session ends. 
                // Reconnecting may not reliably transfer the previous queue or offset back to the SDK instance.

                // Recommended Fixes
                // Refill the Queue on Reconnect: Because the SDK does not reliably maintain passive connections indefinitely, 
                // you should proactively refill the queue once a user interacts with the app again after a disconnection.

                if (!state && musicStartedOnDevice){

                    isRecoveringFromBackground = true; // Set the flag for the 'ready' listener
                    musicPlayingOnDevice = false
                    //console.error(`********* TRUE isRecoveringFromBackground ${isRecoveringFromBackground}`)
                    visualLog(`%c 🔌 VISIBLE - Player disconnected while away. Reconnecting...`, "color: #ff7300ff; background: #ffffff;")
                    console.log("visibilitychange VISIBLE - 🔌 Player disconnected while away. Reconnecting...");
                        logEvent("WARN", `visibilitychange VISIBLE - 🔌 Player disconnected while away. Reconnecting...`, {
                            step: "visibilitychange",
                            error: "VISIBILITY_CHANGE_VISIBLE_PLAYER_DISCONNECTED_RECONNECT",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    // Only reconnect if the state is gone
                    await player.connect().then(async success => {
                        if (success) {
                            console.warn(`%c 🔌 VISIBLE - Player reconnected successfully`, "color: #2d8a02")
                            visualLog(`%c 🔌 VISIBLE - Player reconnected successfully`, "color: #2d8a02")
                        // SEND THE LOG
                        logEvent("WARN", `visibilitychange VISIBLE | Connection request sent to Spotify! SUCCESS`, {
                            step: "visibilitychange",
                            error: "VISIBILITY_CHANGE_VISIBLE_PLAYER_CONNECTION_SUCCESS",
                            stack_trace: new Error().stack, // Auto-trace errors
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });


                        } 
                        else {
                            visualLog(`%c 🔌 VISIBLE - Player Re-Connection failed.`, "color: #ff0000;");
                            showResult(`%c 🔌 VISIBLE - Player Re-Connection failed.`, "color: #ff0000;");
                            console.error(`%c 🔌 VISIBLE - Player Re-Connection failed.`, "color: #ff0000;");
                        // SEND THE LOG
                        logEvent("ERROR", `visibilitychange VISIBLE | Connection request sent to Spotify! FAIL`, {
                            step: "visibilitychange",
                            error: "VISIBILITY_CHANGE_VISIBLE_PLAYER_CONNECTION_FAIL",
                            stack_trace: new Error().stack, // Auto-trace errors
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                        }
                    });

                    pollForReadyState()
                }
                
            
                // 2. Snap your UI elements to the current time/song
                updateUI(state);
                // Start the loop once
                requestAnimationFrame(updateProgressBar);

                console.log("👀 Welcome back! UI synced with player.");
            });
        }
        else{
            console.warn("App visibility changed - VISIBLE - player disconnected")
                    // SEND THE LOG
                    logEvent("DEBUG", `visibilitychange - App visibility changed: VISIBILE - player disconnected`, {
                        step: "visibilitychange",
                        error: `VISIBILITY_CHANGE_VISIBLE_DISCONNECTED`,
                        strikeCount: rateLimitStrikes,
                        activeMix: activeMixId
                    });
        }
    }
    if (document.visibilityState === 'hidden') {

        appVisible = false

        console.warn("App visibility changed - HIDDEN")
        const expiry = localStorage.getItem('token_expiry');
        const remainingMs = expiry - Date.now();
        const minutes = Math.floor(remainingMs / 60000);
        const seconds = Math.floor((remainingMs % 60000) / 1000);
        console.warn(`Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`);
        if (Date.now() > expiry) {
            console.warn(`App visibility changed - HIDDEN - past expire timer - refreshing access token. Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`)
            // SEND THE LOG
            logEvent("DEBUG", `visibilitychange - App visibility changed: HIDDEN - past expire timer - refreshing access token. Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`, {
                step: "visibilitychange",
                error: `VISIBILITY_CHANGE_HIDDEN_REFRESHACCESS`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            await refreshAccessToken();
        }
        else{
            console.warn(`App visibility changed - HIDDEN - not past expire timer. Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`)
            // SEND THE LOG
            logEvent("DEBUG", `visibilitychange - App visibility changed: HIDDEN - not past expire timer. Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`, {
                step: "visibilitychange",
                error: `VISIBILITY_CHANGE_HIDDEN_NOREFRESHACCESS`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        // 1. Manually pull the latest state from the SDK
        // This forces the SDK to talk to Spotify's servers and tell your app exactly where the song is,
        // which "wakes up" your progress bar.
        //if(player && musicStartedOnDevice){
        if(player && devicePoweredOn){
            player.getCurrentState().then(async state => {

                // This behavior is likely caused by the Web Playback SDK's background timeout, 
                // which automatically terminates sessions after approximately 30 seconds of no playback to conserve system resources.
                // The situation you described—where connect() is successful but getCurrentState() returns null 
                // and the Media Session buttons fail—indicates a desynchronization between your app's state and Spotify's servers.
                // Queue Clearing: The Spotify queue does not update consistently when using the Web Playback SDK. 
                // When a player disconnects due to a timeout, the session ends. 
                // Reconnecting may not reliably transfer the previous queue or offset back to the SDK instance.

                // Recommended Fixes
                // Refill the Queue on Reconnect: Because the SDK does not reliably maintain passive connections indefinitely, 
                // you should proactively refill the queue once a user interacts with the app again after a disconnection.

                if (!state && musicStartedOnDevice){

                    isRecoveringFromBackground = true; // Set the flag for the 'ready' listener
                    musicPlayingOnDevice = false
                    //console.error(`********* TRUE isRecoveringFromBackground ${isRecoveringFromBackground}`)
                    visualLog(`%c 🔌 HIDDEN - Player disconnected while away. Reconnecting...`, "color: #ff7300ff; background: #ffffff;")
                    console.log("visibilitychange HIDDEN - 🔌 Player disconnected while away. Reconnecting...");
                        logEvent("WARN", `visibilitychange HIDDEN - 🔌 Player disconnected while away. Reconnecting...`, {
                            step: "visibilitychange",
                            error: "VISIBILITY_CHANGE_PLAYER_HIDDEN_DISCONNECTED_RECONNECT",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    // Only reconnect if the state is gone
                    await player.connect().then(async success => {
                        if (success) {
                            console.warn(`%c 🔌 HIDDEN - Player reconnected successfully`, "color: #2d8a02")
                            visualLog(`%c 🔌 HIDDEN - Player reconnected successfully`, "color: #2d8a02")
                        // SEND THE LOG
                        logEvent("WARN", `visibilitychange HIDDEN | Connection request sent to Spotify! SUCCESS`, {
                            step: "visibilitychange",
                            error: "VISIBILITY_CHANGE_HIDDEN_PLAYER_CONNECTION_SUCCESS",
                            stack_trace: new Error().stack, // Auto-trace errors
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });


                        } 
                        else {
                            visualLog(`%c 🔌 HIDDEN - Player Re-Connection failed.`, "color: #ff0000;");
                            showResult(`%c 🔌 HIDDEN - Player Re-Connection failed.`, "color: #ff0000;");
                            console.error(`%c 🔌 HIDDEN - Player Re-Connection failed.`, "color: #ff0000;");
                        // SEND THE LOG
                        logEvent("ERROR", `visibilitychange HIDDEN | Connection request sent to Spotify! FAIL`, {
                            step: "visibilitychange",
                            error: "VISIBILITY_CHANGE_HIDDEN_PLAYER_CONNECTION_FAIL",
                            stack_trace: new Error().stack, // Auto-trace errors
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                        }
                    });


                    pollForReadyState()

                }
                
            
                // // 2. Snap your UI elements to the current time/song
                // updateUI(state);
                // // Start the loop once
                // requestAnimationFrame(updateProgressBar);

                console.log("👀 HIDDEN BUT PLAYER EXISTS.");
            });
        }
        else{
        console.warn("App visibility changed - HIDDEN - player disconnected")
                    // SEND THE LOG
                    logEvent("DEBUG", `visibilitychange - App visibility changed: HIDDEN - player disconnected`, {
                        step: "visibilitychange",
                        error: `VISIBILITY_CHANGE_HIDDEN_DISCONNECTED`,
                        strikeCount: rateLimitStrikes,
                        activeMix: activeMixId
                    });
        }


    }
    if (document.visibilityState === 'prerender') {
        // : A less common state where the browser loads the page in the background before the 
        // user actually clicks it (like a "top hit" in a search result). 
        // You usually want to keep the app "quiet" here until it moves to visible. 
        console.warn("App visibility changed - PRERENDER")
            // SEND THE LOG
            logEvent("DEBUG", `visibilitychange - App visibility changed: PRERENDER`, {
                step: "visibilitychange",
                error: `VISIBILITY_CHANGE_PRERENDER`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }

    if (wakeLock !== null && document.visibilityState === 'visible') {
        requestWakeLock();
    }
});



initBtn = document.getElementById('init-player');
playPauseBtn = document.getElementById('play-pause');

document.addEventListener("DOMContentLoaded", async () => {

    // Tab-unique ID (In memory only)
    SESSION_ID = crypto.randomUUID();
    APP_DEVICE_ID = localStorage.getItem('app_device_id');
    if (!APP_DEVICE_ID) {
        APP_DEVICE_ID = crypto.randomUUID();
        localStorage.setItem('app_device_id', APP_DEVICE_ID);
    }

    // You are using https://api.ipify.org?format=json in your application to verify and bypass geographic location streaming blocks.
    // Why You Have It in Your Code
    // You ran into an issue where your application or an online radio stream blocked you because
    // it couldn't verify your location, or it mistakenly thought you were in a restricted area 
    // due to an active VPN session.
    // You integrated this endpoint into your script execution logic to:
    // Log the active IP address to determine exactly where your outbound connection is routing 
    // from before hitting the radio APIs.
    // Bypass region filters by checking if you need to prompt a manual location reset or adjust 
    // your proxy routing parameters to verify that you are currently in Utah.
    fetch("https://api.ipify.org?format=json")
        .then(response => response.json())
        .then(data => {
            // Store this globally to include in all future logs
            CURRENT_USER_IP = data.ip;
    });

    await fetchUserProfile()
    console.log(`DOM content loaded`)
    
    const toggleBtn = document.getElementById('settings-toggle-btn');
    const settingsMenu = document.getElementById('settings-menu');

    if (toggleBtn && settingsMenu) {
        toggleBtn.addEventListener('click', () => {
            // Toggles the 'hidden' class: adding it if missing, removing if present
            settingsMenu.classList.toggle('hidden');

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

        });
    }

    // Initialize the PWA install button logic
    initInstallButton();

    //logEvent("WARN", "App Loaded - onSpotifyWebPlaybackSDKReady", {
    logEvent("WARN", "App Loaded - DOMContentLoaded", {
        error: "APP_LOADED",
        step: "DOMContentLoaded",
        screenSize: `${window.innerWidth}x${window.innerHeight}`
    });
    
    // 1. FIRST: Check for a new login code from Spotify
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const existingRefreshToken = localStorage.getItem('refresh_token');

    let returnRefreshAccessToken = false

    // 1. If we have a code BUT we already have a session, IGNORE the code.
    if (code && existingRefreshToken) {
        console.warn("Stale login code detected in URL, but we have a session. Cleaning URL...");
        window.history.replaceState({}, document.title, "/");
        // Proceed to refresh the existing session instead
        returnRefreshAccessToken = await refreshAccessToken();
    } 
    // 2. If it's a brand new login (Code present, No Refresh Token)
    else if(code) {
        console.warn("New login detected. Swapping code for token...");
        visualLog(`%c New login detected. Good to go!`, "color: #15ff00; background: #ffffff;")
            // SEND THE LOG
            logEvent("WARN", `New Login Detected - Swapping login code for token`, {
                step: "newlogin",
                error: `NEW_LOGIN_DETECTED`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        //await getToken(code); // This saves the initial tokens
        await getAccessToken();
        // Clean the URL immediately so we don't process this code again
        window.history.replaceState({}, document.title, "/");

        // Change button text to show user is logged in
        document.getElementById('login-button').textContent = "Logged In";
        document.getElementById('login-button').disabled = true;
        document.getElementById('login-button').style.background = "#1DB954";
    }
    // 3. Normal return to app (No code, but has session)    
    else {
        // Only try to refresh if we AREN'T currently processing a login code
        returnRefreshAccessToken = await refreshAccessToken();

        // // Change button text to show user is logged in
        // document.getElementById('login-button').textContent = "Logged In";
        // //document.getElementById('login-button').disabled = true;
        // document.getElementById('login-button').style.background = "#1DB954";
    }
    // 2. SECOND: Now that the URL is clean, check if we need to refresh an old session
    const refreshToken = localStorage.getItem('refresh_token');
    const accessToken = localStorage.getItem('access_token');

    if (refreshToken && !accessToken) { 
        // Only proactive refresh if we have a refresh token but NO access token
        console.warn("Returning user detected. Refreshing session...");
        console.warn("Session recovery needed...");
            // SEND THE LOG
            logEvent("INFO", `Returning user detected. Refreshing session...`, {
                step: "return_user",
                error: `RETURN_USER_DETECTED`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        returnRefreshAccessToken = await refreshAccessToken();
    }



    // 3. THIRD: Handle the Shared Mix Import (if any)
    const sharedMixBase64 = urlParams.get('import_mix');
    if (sharedMixBase64) {
        try {
            // Decode the Base64 back into a Javascript object
            const decoded = decodeURIComponent(escape(atob(sharedMixBase64)));
            const sharedMix = JSON.parse(decoded);
            
            // Give it a unique ID so it doesn't overwrite existing mixes
            const newId = "shared_" + Date.now();
            
            loadAppState()
            // Add to your global mixes object
            if (!mixes) mixes = {}; 
            mixes[newId] = sharedMix;
            activeMixId = newId;

            playlists = structuredClone(mixes[activeMixId].playlists)

            // CRITICAL: Save to storage immediately so loadAppState() doesn't overwrite it
            //localStorage.setItem('mixes', JSON.stringify(mixes)); 
            //localStorage.setItem('activeMixId', newId);
            // CRITICAL: Save to storage immediately so loadAppState() doesn't overwrite it
            // Save and clean the URL
            saveAppState();

            window.history.replaceState({}, document.title, "/");
            console.log(`%c Imported Mix: ${sharedMix.name}`, "color: #0004ff;")
            showResult(`%c Imported Mix: ${sharedMix.name}`, "color: #0004ff;")
            visualLog(`%c Imported Mix: ${sharedMix.name}`, "color: #0004ff;")
            // SEND THE LOG
            logEvent("WARN", `Imported Mix from URL: ${sharedMix.name}`, {
                step: "import_mix_url",
                error: `IMPORT_MIX_URL_SUCCESS`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        } catch (e) {
            console.error("Failed to import shared mix:", e);
            showResult(`%c Error: Invalid share link.`, "color: #ff0000;")
            visualLog(`%c Error: Invalid share link.`, "color: #ff0000;")
            // SEND THE LOG
            logEvent("WARN", `Failed to import shared mix: ${e}`, {
                step: "import_mix_url",
                error: `IMPORT_MIX_URL_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                error_message: e,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
    }
    // --- END IMPORT LOGIC ---

    //document.getElementById('login-button').onclick = redirectToSpotifyAuth
    document.getElementById('login-button').onclick = loginWithSpotify


    // const token = localStorage.getItem('access_token');
    // if (token) {
    //     // Change UI state
    //     const loginBtn = document.getElementById('login-button');
    //     if (loginBtn) {
    //         loginBtn.textContent = "Logged In";
    //         loginBtn.disabled = true;
    //     }

    //     // FETCH REAL DATA
    //     await fetchUserPlaylists();
    // }


    initBtn = document.getElementById('init-player');
    playPauseBtn = document.getElementById('play-pause');

    let currentTrackId = null;
    let currentTrackIdISRC = null;
    let currentTrackURI = null;
    let currentTrackIdChanging = false;

    let songStartTime = 0;

    if (initBtn) {
        initBtn.onclick = async () => {

            // If already online, act as the Emergency Stop
            if (device_id || devicePoweredOn) {
                emergencyStop();
                return;
            }

            await requestWakeLock();


            localStorage.removeItem('last_active_device')
            device_id = null
            device_ready = false;
            isPlayerReady = false

            //isRecoveringFromBackground = false;
            //musicStartedOnDevice = false
            musicPlayingOnDevice = false
            isRefreshing = false
            //userInitiatedPause = false //leave this for reconnect
            autoPlayBlocked = false
            ghostPauseRecovery = false
            //internalQueue = []
            //playbackHistory = []
            historyIndex = -1
            buttonPreviousNext = false
            //don't care about queuePlaylistMap
            //keep the logMap
            isDraggingProgress = false
            apiCallCounter = 0
            refreshTokenCallCounter = 0
            fetchUserProfileCallCounter = 0
            isSoftLocked = false
            isSoftLockedISRC = false //not used anymore
            fetch401 = false
            loggingLocked = false
            rateLimitStrikes = 0
            rateLimitStrikesISRC = 0 //not used anymore

            await refreshAccessToken();

            //alert("CLICK DETECTED!"); // <--- ADD THIS TEMPORARILY
            const currentToken = localStorage.getItem('access_token');
            if (!currentToken) {
                visualLog(`%c Please login to Spotify first!`, "color: #3a3836ff; background: #ff7b00d2;")
                return alert("Please login to Spotify first!");
            }

            console.warn("Button Clicked: Initializing Player...");

            player = new Spotify.Player({
                name: "Ben's Mixer Lab",
                getOAuthToken: cb => { 
                    // Always fetch from storage so it gets the refreshed one!
                    const token = localStorage.getItem('access_token');
                    cb(token); 
                },
                volume: 0.5
            });

            player.activateElement(); 

            if (!player) {
                console.error("Player not initialized yet. Wait for SDK.");
            // SEND THE LOG
            logEvent("ERROR", `PowerOn - Failed to initialize player`, {
                step: "PowerOn",
                error: `PLAYER_INIT_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                return;
            }




            // try {
            //     const video = document.getElementById('keep-alive-video');
            //     if (video) {
            //         // Ensure the source filename matches what you put in your directory!
            //         //video.src = "./silent-wake.mp4"; 
                    
            //         // Firing this inside the click event satisfies the "User Gesture" policy
            //         await video.play();
            //         console.log("🟢 Repos-hosted Video Wake Lock Active");

            //         video.addEventListener('timeupdate', () => {
            //             // This log will flood your console if the video is running successfully
            //             console.log(`🌀 Wake lock actively cycling. Current time: ${video.currentTime}`);
                    
            //         // Optional: Update your "showResult" UI string to give you visual feedback
            //         // showResult(`System active (Lock progress: ${keepAliveVideo.currentTime.toFixed(1)}s)`);
            //         });
            //     }
                
            //     // Continue with standard Spotify initialization...
            //     player.activateElement();
            // } catch (err) {
            //     console.warn("❌ Workplace security policy blocked physical video playback:", err);
            // }

    
            // // // Add this to your Power On click handler
            // // const silencer = document.createElement('video');
            // // silencer.src = "https://githubusercontent.com";
            // // silencer.loop = true;
            // // silencer.muted = true; // Muted video still counts as 'active' for the browser
            // // silencer.play().catch(e => console.log("Silent video blocked until next click."));
            // try {
            //     // Prevent creating duplicate video nodes if one already exists
            //     if (document.getElementById('wake-lock-video')) return;

            //     const video = document.createElement('video');
            //     video.id = 'wake-lock-video';
            //     video.src = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAAAAGlzb21pc28yYXZjMQAAAAhmcmVlAAAAG21kYXTeBAAAbGlieDI2NCAtIGNvcmUgMTY0IAAAAApmoW9vcHMAAAAALW1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAABidHJrawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAIAAAACAAAAAABAAAAAAUlbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAABAAAAVVYfUAAAAAAAAMWhkbHIAAAAAAAAAAHZpZGVvAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAVxtaW5mAAAAFHZtYmhkAAAAAQAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASVzdGJsAAAAd3N0c2QAAAAAAAAAAQAAAGdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAgACABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAALmF2Y2MBQsAr/+EAFWfEArAtvA8AAAMAAQAAAwAyDxArpSABAAZIDpAgAAAAEHBhc3AAAAABAAAAAQAAABhzdHRzAAAAAAAAAAEAAAABAAAAQAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAAIAAAAAQAAABRzdGNvAAAAAAAAAAEAAAA0AAAAYXVkdGEAAABZTWV0YQAAAAAAAAAhSGRscgAAAAAAAAAAbWRpcgAAAAAAAAAAAAAAAAAAAAAALWlsc3QAAAApAKW5hbQAAACFEYXRhAFVudGl0bGVkIChIUCBNZWRpYSBTdHJlYW0pAAAAEGlkYXQAAAAAAAAAAQ==';
                
            //     video.loop = true;
            //     video.muted = true;
            //     video.setAttribute('playsinline', ''); 
            //     video.style.display = 'none'; 
                
            //     document.body.appendChild(video);
                
            //     // This execution succeeds because it runs inside a direct user-click timeline
            //     await video.play();
            //     console.log("🟢 Hidden Video Wake Lock (Base64) Active");
            // } catch (err) {
            //     console.warn("🟡 Hidden Video Hack failed:", err);
            // }


            // try {
            //     // Avoid duplicating the node
            //     if (document.getElementById('wake-lock-audio')) return;

            //     const audio = document.createElement('audio');
            //     audio.id = 'wake-lock-audio';
                
            //     // A 1-second completely silent MP3 base64 string
            //     audio.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAAATGFtZTMuOTguMgAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAAABGcmFtZQAAAAAWAAAAQUgAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAAABGcmFtZQAAAAAWAAAAQUgAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAAABGcmFtZQAAAAAWAAAAQUgAAAAAAAAAAAAA';
                
            //     audio.loop = true;
            //     audio.muted = true;
            //     audio.style.display = 'none';
                
            //     document.body.appendChild(audio);
                
            //     // Play immediately inside your user click handler
            //     await audio.play();
            //     console.log("🟢 Hidden Audio Wake Lock Active");
            // } catch (err) {
            //     console.warn("🟡 Hidden Audio Hack failed:", err);
            // }            


            // Since the video approach is being blocked, let's switch to the "Silent Audio Heartbeat" method. It's often more compatible with mobile Chrome because it uses the Web Audio API to generate a signal, which avoids codec errors entirely. 
            // The "Silent Audio Heartbeat" Strategy
            // This code creates a continuous, silent audio stream. Android Chrome will see this as "Active Media," making it much less likely to kill your tab when the screen is off. 

            /// Why the AudioContext Heartbeat is Crucial for Mobile and ChromeEven when autoplay is successfully enabled, 
            // this silent oscillator serves essential performance functions:
            // 1. Preventing "Tab Sleeping" (Chrome & Mobile)Mobile 
            // operating systems and desktop Chrome aggressively pause background tabs to conserve RAM and battery. 
            // If your mixer is minimized or your phone screen dims, Chrome will freeze your background loops 
            // (including your 30-second context check).The Benefit: An active AudioContext registers your PWA as a Live Audio Utility. 
            // This prevents Chrome from freezing your background loops, allowing your interval timer to continue checking progress_ms 
            // and firing your context changes cleanly.
            // 2. Keeping the Spotify "Playback Pipe" PrimeThe Spotify Web Playback SDK utilizes Web Assembly (WASM) and local audio 
            // nodes to process decryption keys. If the browser detects no local audio output activity for an extended period, it may 
            // shut down the audio channel pipeline.The Benefit: The heartbeat acts as a low-level signal loop, keeping the browser 
            // audio engine open and preventing the Spotify SDK connection from timing out when songs switch.
            // 3. Bypassing Mobile Background Audio ThrottlingOn mobile devices (iOS Safari and mobile Chrome), your navigator.wakeLock 
            // keeps the phone screen illuminated, but it does not stop the browser from restricting background data fetch chains.
            // The Benefit: The Audio Heartbeat handles the audio processing side, while the Wake Lock handles the screen side. 
            // Together, they create a robust framework for running code while your phone is in your pocket.
            let audioHeartbeat = null;
            //async function enableWakeLock() {
                try {
                    // Create an AudioContext
                    const AudioContext = window.AudioContext || window.webkitAudioContext;
                    audioHeartbeat = new AudioContext();

                    // Create a silent oscillator
                    const oscillator = audioHeartbeat.createOscillator();
                    const gainNode = audioHeartbeat.createGain();

                    oscillator.type = 'sine';
                    oscillator.frequency.setValueAtTime(440, audioHeartbeat.currentTime);
                    
                    // Volume = 0 (Pure Silence)
                    gainNode.gain.setValueAtTime(0, audioHeartbeat.currentTime);

                    oscillator.connect(gainNode);
                    gainNode.connect(audioHeartbeat.destination);

                    // Start the heartbeat
                    oscillator.start();
                    console.log("🔊 Silent Audio Heartbeat active (Safe for Mobile)");
            // SEND THE LOG
            logEvent("DEBUG", `Audio_Heartbeat - Silent Audio Heartbeat active (Safe for Mobile)`, {
                step: "Audio_Heartbeat",
                error: `AUDIO_HEARBEAT_SUCCESS`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                } catch (err) {
                    console.warn("🟡 Audio Heartbeat failed:", err);
            // SEND THE LOG
            logEvent("WARN", `Audio_Heartbeat - Audio Heartbeat failed: ${err}`, {
                step: "Audio_Heartbeat",
                error: `AUDIO_HEARBEAT_FAIL`,
                stack_trace: new Error().stack, // Auto-trace errors
                error_message: err,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                }
           // }

            
            // // Alternative: Silent Audio Context
            // // If your system is extremely restricted and blocks even large data URIs, you can use the Web Audio API to generate "silence." It’s less effective for keeping the screen on than video, but it’s great for preventing Chrome from suspending the "playback pipe".            
            // //function startSilentAudio() {
            //     const context = new (window.AudioContext || window.webkitAudioContext)();
            //     const oscillator = context.createOscillator();
            //     const gainNode = context.createGain();

            //     oscillator.type = 'sine';
            //     oscillator.frequency.setValueAtTime(440, context.currentTime); // Standard tone
            //     gainNode.gain.setValueAtTime(0, context.currentTime); // Volume = 0 (Silence)

            //     oscillator.connect(gainNode);
            //     gainNode.connect(context.destination);

            //     oscillator.start();
            //     console.warn("🔊 Silent Audio Context Active");
            // //}

            // Ready
            player.addListener('ready', async ({ device_id: id }) => {
                console.warn('Ready with Device ID', id);
                showResult(`%c Mixer is Online`, "color: #ffffff; background: #009213;")
                visualLog(`%c Mixer is Online`, "color: #ffffff; background: #009213;")
                device_id = id;
                device_ready = true
                isPlayerReady = true
                localStorage.setItem('last_active_device', id); // Keep a record
                initBtn.textContent = "Mixer Online 🟢";
                initBtn.style.background = "#1DB954";
                document.getElementById('init-player').textContent = "Mixer Online 🟢";
                document.getElementById('play-pause').style.display = "inline-block";

                // SEND THE LOG
                logEvent("WARN", `ready listener - device_id: ${device_id}`, {
                    step: "ready_listener",
                    error: "READY_LISTENER",
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

                recoverFromBackground();
            });

            // Add this listener to handle temporary drops
            player.addListener('not_ready', ({ device_id }) => {
                console.warn("Device has gone offline:", device_id);
                showResult(`%c Player not_ready - Connection lost. Trying to reconnect...`, "color: #ff0000;")
                visualLog(`%c Player not_ready - Connection lost. Trying to reconnect...`, "color: #ff0000;")
                // // The SDK will try to reconnect itself, but we can nudge it:
                // player.connect().then(success => {
                //     if (success) {
                //         console.warn("Connection request sent to Spotify!");
                //     } else {
                //         console.error("Connection failed. Check your Premium status.");
                //     }
                // });


                // SEND THE LOG
                logEvent("WARN", `not_ready listener - Device has gone offline - device_id: ${device_id}`, {
                    step: "not_ready_listener",
                    error: "NOT_READY_LISTENER",
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

                resumeOnThisDevice();
            });

            player.addListener('autoplay_failed', () => {


                console.warn("AUTOPLAY BLOCKED: The browser stopped the next song from starting.");
                showResult(`%c Browser blocked autoplay. Tap 'Play' to resume the mixer.`, "color: #b700ff;")
                visualLog(`%c Browser blocked autoplay. Tap 'Play' to resume the mixer.`, "color: #b700ff;")
                
                // SEND THE LOG
                logEvent("WARN", `autoplay_failed - AUTOPLAY BLOCKED: The browser stopped the next song from starting.`, {
                    step: "autoplay_failed",
                    error: "AUTOPLAY_FAILED",
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

                userInitiatedPause = true; //spotify pauses music when next song comes in
                autoPlayBlocked = true;

                // Optional: Make the Play/Pause button glow or shake to get the user's attention
                const playBtn = document.getElementById('play-pause');
                if (playBtn) {
                    playBtn.style.border = "2px solid #1DB954";
                    playBtn.style.boxShadow = "0 0 15px #1DB954";
                }
            });

            // Merged Initialization Error Handler
            player.addListener('initialization_error', ({ message }) => {
                // 1. Log the error to the console (covers your second listener's job)
                console.error("Spotify SDK Initialization Error:", message);

                // 2. Specific check for the "Lost Connection" case (covers your first listener's job)
                if (message.includes("initialized") || message.includes("connection")) {
                    console.error("Critical: SDK lost internal connection.");
                    showResult(`%c Playback Engine Error. Please refresh the page.`, "color: #ff0000;")
                    visualLog(`%c Playback Engine Error. Please refresh the page.`, "color: #ff0000;")
                } else {
                    // Handle other random init errors (like DRM issues)
                    console.error(`%c Error starting player: ${message}`, "color: #ff0000;")
                    showResult(`%c Error starting player: ${message}`, "color: #ff0000;")
                    visualLog(`%c Error starting player: ${message}`, "color: #ff0000;")
                }
                // SEND THE LOG
                logEvent("ERROR", `initialization_error - Spotify SDK Initialization Error: ${message}`, {
                    step: "initialization_error",
                    error: "INITIALIZATION_ERROR",
                    error_message: message,
                    stack_trace: new Error().stack, // Auto-trace errors
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

            });
            player.addListener('authentication_error', ({ message }) => { console.error(message); });
            player.addListener('account_error', ({ message }) => { alert("Premium account required!"); });

            player.addListener('authentication_error', async ({ message }) => {
                console.error(`SDK Authentication Error: ${message} | visibility: ${document.visibilityState}`);
                // If the SDK says we aren't authorized, force a token refresh immediately
                
                const expiry = localStorage.getItem('token_expiry');
                const remainingMs = expiry - Date.now();
                const minutes = Math.floor(remainingMs / 60000);
                const seconds = Math.floor((remainingMs % 60000) / 1000);
                console.warn(`Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`);

                console.warn(`%c Session expired. Re-authenticating...`, "color: #00eeff;")
                showResult(`%c Session expired. Re-authenticating...`, "color: #00eeff;")
                visualLog(`%c Session expired. Re-authenticating...`, "color: #00eeff;")
                await refreshAccessToken();
                // After refresh, tell the player to try connecting again
                // if (document.visibilityState === 'visible') {
                //     player.connect(); // Only try to reconnect if the screen is on
                // }
                // In your authentication_error listener, you are likely triggering a full reconnection. On a locked phone, this is a "heavy" task that gets the app killed.
                // The Fix: If an authentication_error happens while document.visibilityState === 'hidden', do not reconnect immediately.
                // The Move: Just refresh the token in localStorage. Then, let the visibilitychange listener handle the player.connect() the moment the user unlocks the phone.
                player.connect().then(success => {
                    if (success) {
                        console.warn(`%c authentication_error - Refreshing Authentication - Player reconnected`, "color: #00a30e;")
                        showResult(`%c Refreshing Authentication - Player reconnected`, "color: #00a30e;")
                        visualLog(`%c Refreshing Authentication - Player reconnected`, "color: #00a30e;")
                        // SEND THE LOG
                        logEvent("WARN", `authentication_error - SDK Authentication Error: ${message} | visibility: ${document.visibilityState} | Session expired. Re-authenticating... | Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds} | Player Reconnected! SUCCESS`, {
                            step: "authentication_error",
                            error: "AUTHENTICATION_ERROR_REAUTH_SUCCESS",
                            stack_trace: new Error().stack, // Auto-trace errors
                            error_message: message,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    } 
                    else {
                        console.error(`%c authentication_error - Refreshing Authentication - Player reconnect failed`, "color: #ff0000;")
                        showResult(`%c Refreshing Authentication - Player reconnect failed`, "color: #ff0000;")
                        visualLog(`%c Refreshing Authentication - Player reconnect failed`, "color: #ff0000;")
                        // SEND THE LOG
                        logEvent("WARN", `authentication_error - SDK Authentication Error: ${message} | visibility: ${document.visibilityState} | Session expired. Re-authenticating... | Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds} | Connection failed. FAIL`, {
                            step: "authentication_error",
                            error: "AUTHENTICATION_ERROR_REAUTH_FAIL",
                            stack_trace: new Error().stack, // Auto-trace errors
                            error_message: message,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    }
                });
            });

            // Add this inside your initBtn.onclick, near your other listeners:
            player.addListener('player_state_changed', async (state) => {
                if (!state) return;

                const {
                    paused,
                    position,
                    duration,
                    is_active,
                    playback_id,
                    track_window: {current_track}
                } = state;

                console.log(`%c player_state_changed: ${state}`, "colo: #0099ff")

                    // const theprogressBar = document.getElementById('progress-bar');
                    // theprogressBar.max = duration;
                    // theprogressBar.value = position;
                    // document.getElementById('current-time').textContent = formatTime(position);
                    // document.getElementById('duration-time').textContent = formatTime(duration);


                lastState = {
                    position: state.position,
                    duration: state.duration,
                    paused: state.paused,
                    timestamp: performance.now() // Precise local time
                };

                // 2. Snap your UI elements to the current time/song
                updateUI(state);
                // Start the loop once
                requestAnimationFrame(updateProgressBar);


                // Check if another device (like the Spotify App) took over
                //if (state.playback_id === "" && !state.is_paused) {
                if (state.playback_id === "" && !state.paused) {
                    // This usually means the 'Session' moved elsewhere
                    console.warn("Playback hijacked by another device.");
                        // SEND THE LOG
                        logEvent("INFO", `playback_hijacked - Playback hijacked by another device.`, {
                            step: "playback_hijacked",
                            error: "PLAYBACK_HIJACKED_NOPLAYBACK",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    showResumeOverlay(true);
                } 
                else if (state.is_active === false) {
                    console.warn("Mixer is no longer the active device.");
                        // SEND THE LOG
                        logEvent("INFO", `playback_hijacked - Mixer is no longer the active device.`, {
                            step: "playback_hijacked",
                            error: "PLAYBACK_HIJACKED_NOTACTIVE",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    showResumeOverlay(true);
                } 
                else {
                    // If we are active again, hide the overlay
                    showResumeOverlay(false);
                }

                const playPauseBtn = document.getElementById('play-pause');
                if (playPauseBtn) {

                    // MUSIC PAUSED
                    if (state.paused && musicStartedOnDevice && devicePoweredOn) {
                        //console.log(`player_state_changed FALSE musicPlayingOnDevice`)
                        musicPlayingOnDevice = false
                        if (!userInitiatedPause) {


                            if(!ghostPauseRecovery) visualLog(`%c Ghost pause detected! Forcing music to resume...`, "color: #ff8800; background: #ffffff;")
                            console.warn("Ghost pause detected! Forcing music to resume...");
                        // SEND THE LOG
                        logEvent("INFO", `ghost_pause - Ghost pause detected! Forcing resume...`, {
                            step: "ghost_pause",
                            error: "GHOST_PAUSE",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                            setTimeout(() => {
                                player.resume();
                                //musicStartedOnDevice = true
                            }, 1000);
                        }

                            ghostPauseRecovery = true;
                            safeTimeout(() => ghostPauseRecovery = false, 15000); // Reset count after 15s
                        
                        if(userInitiatedPause && isRecoveringFromBackground){
                            // Catch forced pause after resume
                            isRecoveringFromBackground = false;
                            //  console.error(`********* FALSE isRecoveringFromBackground ${isRecoveringFromBackground} userInitiatedPause`)
                        }
                        // If music is paused, show "Play" button (Green)
                        playPauseBtn.textContent = "▶ Play";
                        playPauseBtn.style.background = "#1DB954"; // Spotify Green
                        document.getElementById('play-pause-btn').textContent = "▶";
                        document.getElementById('play-pause-btn').style.background = "#1DB954"; // Spotify Green
                    }

                    // MUSIC PLAYING
                    else {
                        //console.warn(`player_state_changed TRUE musicPlayingOnDevice`)
                        musicPlayingOnDevice = true

                    
                        //console.error(`********* userInitiatedPause ${userInitiatedPause}`)
                        //console.error(`********* player_state_changed CHECKING isRecoveringFromBackground ${isRecoveringFromBackground}`)
                        //if(isRecoveringFromBackground){
                            if(userInitiatedPause){
                            //setTimeout(() => {
                                
                                console.log(`%cStarting in paused state`, "color: #e5ff00; background: #2b2b2bff;")
                                player.pause()
                                //player.togglePlay()
                            //}, 1000);
                        playPauseBtn.textContent = "▶ Play";
                        playPauseBtn.style.background = "#1DB954"; // Spotify Green
                        document.getElementById('play-pause-btn').textContent = "▶";
                        document.getElementById('play-pause-btn').style.background = "#1DB954"; // Spotify Green
                            }
                            else{ //music recovering is indication we're done recovering
                                isRecoveringFromBackground = false; // Reset the flag
                                //console.error(`********* FALSE isRecoveringFromBackground ${isRecoveringFromBackground}`)
                                // actual player_state_changed will handle this if TRUE userInitiatedPause
                        playPauseBtn.textContent = "⏸ Pause";
                        playPauseBtn.style.background = "#FF5722"; // Deep Orange
                        document.getElementById('play-pause-btn').textContent = "⏸";
                        document.getElementById('play-pause-btn').style.background = "#1DB954"; // Spotify Green
                            }
                        //}
                        // Reset the flag whenever the music is actually playing
                        // if(!isRecoveringFromBackground){
                        //     //console.log(`!isRecoveringFromBackground - Forcing userInitiatedPause FALSE`)
                        //     userInitiatedPause = false;
                        // }
                        //console.error(`player_state_changed - state.NOT-paused - userInitiatedPause ${userInitiatedPause}`)
                        // If music is playing, show "Pause" button (Orange/Red)
                    }
                }

                const now = Date.now()

                if(!current_track){
                    console.warn("player state changed but no currentTrack")
                    return;
                }

                //////////////////////////////////////////
                //contextSyncedForCurrentTrack = false; // Reset for new song
                // 2. Logic to trigger the swap
                playlistContextEnabled = document.getElementById('sync-context-check').checked;
                let progressSecs = state.position / 1000
                const targetPlaylist = `spotify:playlist:${queuePlaylistsMap.get(currentTrackIdISRC)?.playlist}`; // Or a dynamic variable

                // Calculate how much time has passed since the last official SDK update
                //progressSecs = (performance.now() - lastState.timestamp) / 1000;

                if (playlistContextEnabled && appVisible && !contextSyncedForCurrentTrack && progressSecs > 10) {
                    console.log("Song established. Syncing context...");
                    console.log(`%c playlistContextEnabled ${playlistContextEnabled} targetPlaylist: ${targetPlaylist}`, "color: #51ff00ff;")
                    syncSpotifyContext(targetPlaylist, currentTrackURI, state.position);
                }

                if(!contextSyncedForCurrentTrack){
                    updateSyncIndicator(false)
                }
                //////////////////////////////////////////

                // --- THE LINKED TRACK LOGIC ---
                // If it's relinked, use the original ID. If not, use the current one.
                let originalTrackId = current_track.linked_from?.id || current_track.id;
        
                //console.log(`current_track.id: ${current_track.id} currentTrackId: ${currentTrackId}`)

                // 1. Check if the song has actually changed to a new ID
                if (current_track.id !== currentTrackId){
                    if(!currentTrackIdChanging){
                        currentTrackIdChanging = true; //only check ISRC ID once - so we don't get rate limited

                        console.log("New track detected:", current_track.name);
                        // SEND THE LOG
                        logEvent("TRACE", `current_track.id changed - New track detected: ${current_track.name}`, {
                            step: "current_track_id_changed",
                            error: "CURRENT_TRACK_ID_CHANGED",
                            track: current_track.name,
                            track_artist: current_track.artists[0].name,
                            track_id: current_track.id,
                            previous_track_id: currentTrackId,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });

                        const rawArtist = current_track.artists[0].name.trim();
                        const rawTitle = current_track.name.trim();
                        const cacheartist = cleanMetadataString(rawArtist);
                        const cachetitle = cleanMetadataString(rawTitle);
                        const cacheKey = `${cacheartist}-${cachetitle}`.toLowerCase();

                        // ✅ HYDRATE NEW CACHE SCHEMATIC ROW NATIVELY
                        const trackPayload = {
                            found: true,
                            uri: current_track.uri,
                            alternate_uris: [], // Ready to collect variations on subsequent runs
                            resolved_title: cachetitle,
                            resolved_artist: cacheartist,
                            stations_synced: ["GLOBAL"] // Initialize array with the current station ID tracking block
                        }

                        globalSongCache[cacheKey] = trackPayload
                        pendingCloudCacheUploads[cacheKey] = trackPayload

                        if(current_track.linked_from?.id){
                            console.warn(`linked_from.id ${current_track.linked_from?.id} ${lastTrackId}`);
                            console.warn("currentTrackIdISRC:", currentTrackIdISRC)
                            
                            console.log("Played ID:", current_track.id);
                            console.log("Original ID:", current_track.linked_from?.id);

                            currentTrackId = current_track.id //so we won't check ISRC more than once
                            currentTrackIdISRC = current_track.linked_from?.id
                            currentTrackURI = current_track.linked_from?.uri
                            lastPickTime = Date.now() //reset timer for new song

                            const rawArtist = current_track.artists[0].name.trim();
                            const rawTitle = current_track.name.trim();
                            const cacheartist = cleanMetadataString(rawArtist);
                            const cachetitle = cleanMetadataString(rawTitle);
                            const cacheKey = `${cacheartist}-${cachetitle}`.toLowerCase();

                            // ✅ HYDRATE NEW CACHE SCHEMATIC ROW NATIVELY
                            if(!globalSongCache[cacheKey].alternate_uris) globalSongCache[cacheKey].alternate_uris = []
                            globalSongCache[cacheKey].alternate_uris.push(current_track.linked_from?.uri)
                        } //endif
                        else{

                            currentTrackId = current_track.id //so we won't check ISRC more than once
                            currentTrackIdISRC = current_track.id //but this will be current instead of linked_from ()
                            currentTrackURI = current_track.uri
                            lastPickTime = Date.now() //reset timer for new song
                            //return; //exit: we just started a song, don't pick a new one!
                            // Update your 'Now Playing' UI here if needed
                        }

                        // 💾 MASTER PERSISTENT LOCALSTORAGE WRITEBACK
                        // Save the updated object map right after this station finishes its loop logic pass
                        // localStorage.setItem('spotify_global_song_cache', JSON.stringify(globalSongCache));
                        // ✅ Fix: Flush the synchronous globalSongCache object straight to IndexedDB.
                        // Completely bypasses the 5MB browser sandbox limit with zero data layout changes!
                        await flushRuntimeCacheToIndexedDb(globalSongCache);
                    }
                }
                else {
                    // 2. Only flip back to false when the IDs are identical
                    if (currentTrackIdChanging) {
                        console.log("Track ID synced.");
                        currentTrackIdChanging = false;
                    }
                }                
                // 2. Detect the REAL end of the track
                // We check if it's paused, at the end (position 0), and 
                // ensure we don't trigger if it's just the 'start' event.
                const isAtEnd = paused && position === 0 && duration > 0;

                // 2. The "Cooldown" Check
                // If we picked a song less than 5 seconds ago, ignore this event.
                // This stops the 'New Track Loading' event from triggering a loop.
                const isRecentPick = (now - lastPickTime) < 5000;
                
                // Safety check: Did this song play for at least 5 seconds?
                // This prevents the "Loading -> Pick -> Loading -> Pick" loop.
                const hasPlayedEnough = (Date.now() - lastPickTime) > 5000;


                if (isAtEnd && hasPlayedEnough) { //gotta catch when autoplay block stops it
                    console.log("Track naturally finished. Picking next...");

                    // // If the song that just started is the one at the top of our queue, remove it
                    // if (internalQueue.length > 0 && internalQueue[0].id === currentTrackIdISRC) {
                    //     internalQueue.shift(); 
                    //     renderQueue();
                    // }

                    // Force a small interaction signal
                    player.getVolume().then(v => {
                        player.setVolume(v > 0.1 ? v - 0.05 : v + 0.05).then(() => {
                            player.setVolume(v); // Quickly set it back
                        });
                    });

                    // --- THE KEY FIX ---
                    // 1. Re-activate the element to satisfy autoplay rules
                    // Nudge the browser to keep the audio context alive
                    if(player){
                    player.activateElement(); 
                    player.connect().then(success => {
                        if (success) {
                            console.warn(`%c player_state_change - end of song - Player reconnected successfully`, "color: #2d8a02")
                        } 
                        else {
                            console.error(`%c player_state_change - end of song - Player Connection failed.`, "color: #ff0000; background: #ffffff;")
                            visualLog(`%c Player Connection failed.`, "color: #ff0000; background: #ffffff;")
                            showResult(`%c Player Connection failed.`, "color: #ff0000; background: #ffffff;")
                        // SEND THE LOG
                        logEvent("ERROR", `player_state_changed - Track naturally finished - Error: PLAYER_CONNECTION_FAIL`, {
                            step: "player_state_changed",
                            error: `PLAYER_CONNECTION_FAIL`,
                            stack_trace: new Error().stack, // Auto-trace errors
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                            console.error("player_state_changed - Track naturally finished - Error: PLAYER_CONNECTION_FAIL.");
                        }
                    });
                    }
                    
                    // Small trick: Set volume to current level to trigger an 'interaction' event
                    player.getVolume().then(v => player.setVolume(v));
                    // 2. The "Nudge": Slightly change volume and back to trigger an interaction
                    player.getVolume().then(v => {
                        player.setVolume(v + 0.01).then(() => player.setVolume(v));
                    });

                    // 2. Explicitly resume the player so it's in a 'playing' state 
                    // before the new URI arrives
                    if(!autoPlayBlocked){
                        console.log(`autoPlayBlocked not blocked: ${autoPlayBlocked}`)
                        await player.resume(); 

                        const returnPickRandom = await pickRandomSong(); 
                        if(returnPickRandom !== "SUCCESS"){
                            console.warn("player_state_changed - end of song - pickRandomSong - FAIL:", returnPickRandom)
                        }

                        lastPickTime = now; // Mark the time of this pick
                        // Clear the ID so the next track can be detected as a change
                        //currentTrackId = null; 
                        //player.activateElement(); 
                        //pickRandomSong();                     
                    }
                    else{
                        // if(autoPlayBlockRecovered){

                        console.log(`autoPlayBlocked blocked: ${autoPlayBlocked}`)
                        
                        // userInitiatedPause = false
                        // player.activateElement();
                        // await player.resume(); 

                        // autoPlayBlockRecovered = false
                        // const returnPickRandom = await pickRandomSong(); 
                        // if(returnPickRandom !== "SUCCESS"){
                        //     console.warn("player_state_changed - end of song - pickRandomSong - FAIL:", returnPickRandom)
                        // }

                        // lastPickTime = now; // Mark the time of this pick
                        // // Clear the ID so the next track can be detected as a change
                        // //currentTrackId = null; 
                        // //player.activateElement(); 
                        // //pickRandomSong();         
                        // }            
                    }
                    //musicStartedOnDevice = true


                }
                
                // --- THE FIX: Detect a new song has started ---
                //console.log(`currentTrackIdISRC: ${currentTrackIdISRC} lastTrackID: ${lastTrackId}`)
                if (currentTrackIdISRC !== lastTrackId) {

                    // If the song that just started is the one at the top of our queue, remove it
                    if (internalQueue.length > 0) {
                        //internalQueue.shift(); 
                        // Find the position of the song that just started in our internal queue
                        const playingIndex = internalQueue.findIndex(item => item.id === lastTrackId);

                        if (playingIndex !== -1) {
                            // Remove the playing song AND any songs above it (in case we skipped)
                            internalQueue.splice(0, playingIndex + 1 );
                        }
                        renderQueue();
                    }   

                    contextSyncedForCurrentTrack = false; // Reset for new song

                    console.warn("New song detected:", current_track.name);
                    //console.warn("lastTrackId - Detected new song:", lastTrackId, current_track.name)
                        // SEND THE LOG
                        logEvent("TRACE", `currentTrackIdISRC changed - New song detected: ${current_track.name}`, {
                            step: "currentTrackIdISRC_changed",
                            error: "currentTrackIdISRC_CHANGED",
                            track: current_track.name,
                            track_artist: current_track.artists[0].name,
                            track_id: current_track.id,
                            track_id_isrc: currentTrackIdISRC,
                            previous_track_id: currentTrackId,
                            previous_track_id_isrc: lastTrackId,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    
                    // Update UI (Now Playing, etc.)
                    //updateUI(currentTrack);
                    nowPlayingText = `%c Now Playing: ${current_track.name} by ${current_track.artists[0].name} ${(queuePlaylistsMap.get(currentTrackIdISRC)?.name != null) ? ("- " + queuePlaylistsMap.get(currentTrackIdISRC)?.name) : "---"}`
                    console.log(`%c Now Playing: ${current_track.name} by ${current_track.artists[0].name} ${(queuePlaylistsMap.get(currentTrackIdISRC)?.name != null) ? ("- " + queuePlaylistsMap.get(currentTrackIdISRC)?.name) : "---"}`, "color: #28a801;")
                    showResult(`%c Now Playing: ${current_track.name} by ${current_track.artists[0].name} ${(queuePlaylistsMap.get(currentTrackIdISRC)?.name != null) ? ("- " + queuePlaylistsMap.get(currentTrackIdISRC)?.name) : "---"}`, "color: #28a801;")
                    visualLog(`%c Now Playing: ${current_track.name} by ${current_track.artists[0].name} ${(queuePlaylistsMap.get(currentTrackIdISRC)?.name != null) ? ("- " + queuePlaylistsMap.get(currentTrackIdISRC)?.name) : "---"}`, "color: #28a801;")
                        // SEND THE LOG
                        logEvent("INFO", `now_playing - Now Playing: ${current_track.name} by ${current_track.artists[0].name} ${(queuePlaylistsMap.get(currentTrackIdISRC)?.name != null) ? ("- " + queuePlaylistsMap.get(currentTrackIdISRC)?.name) : "---"}`, {
                            step: "now_playing",
                            error: "NOW_PLAYING",
                            track: current_track.name,
                            track_artist: current_track.artists[0].name,
                            playlist: queuePlaylistsMap.get(currentTrackIdISRC)?.name,
                            track_id: current_track.id,
                            track_id_isrc: currentTrackIdISRC,
                            previous_track_id: currentTrackId,
                            previous_track_id_isrc: lastTrackId,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });

                        let playlists_text = ""
                        playlists.forEach((playlist, index) => {
                            if(playlist.enabled){
                                playlists_text += `[${playlist.name}] `
                            }
                        })
                        //console.warn(`playlists_text: (${playlists_text})`)
                        // SEND THE LOG
                        logEvent("INFO", `ACTIVE_MIX | ${mixes[activeMixId].name}`, {
                            step: "ACTIVE_MIX",
                            error: "ACTIVE_MIX",
                            mix_name: mixes[activeMixId].name,
                            playlists_enabled: playlists_text,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    
                    if(queuePlaylistsMap.get(currentTrackIdISRC)?.name === queuePlaylistsMap.get(lastTrackId)){
                        console.error(`%c Playlist names match. currentTrackIdISRC: ${currentTrackIdISRC} lastTrackId: ${lastTrackId}, "color: #ff00bf; background: #121212;"`)
                        // SEND THE LOG
                        logEvent("ERROR", `Playlist names match. currentTrackIdISRC: ${currentTrackIdISRC} lastTrackId: ${lastTrackId}`, {
                            step: "now_playing",
                            error: "NOW_PLAYING",
                            stack_trace: new Error().stack, // Auto-trace errors
                            track: current_track.name,
                            track_artist: current_track.artists[0].name,
                            lastTrackId: lastTrackId,
                            currentTrackIdISRC: currentTrackIdISRC,
                            playlist_currentTrackIdISRC: queuePlaylistsMap.get(currentTrackIdISRC)?.name,
                            playlist_lastTrackId: queuePlaylistsMap.get(currentTracklastTrackIdIdISRC)?.name,
                            track_id: current_track.id,
                            track_id_isrc: currentTrackIdISRC,
                            previous_track_id: currentTrackId,
                            previous_track_id_isrc: lastTrackId,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    }

                    // --- ADD TO HISTORY ---
                    addToHistory(current_track, (queuePlaylistsMap.get(currentTrackIdISRC)?.name != null) ? queuePlaylistsMap.get(currentTrackIdISRC)?.name : "");

                    // To keep the music playing when the screen goes off, Android requires a "Foreground Service." Browsers can't do this easily, but there is a hack: The Media Session API. If you "tell" Android that media is playing, it’s less likely to kill the tab.
                    // Add this whenever a song starts:
                    if ('mediaSession' in navigator) {
                        navigator.mediaSession.metadata = new MediaMetadata({
                            title: current_track.name,
                            artist: `${current_track.artists[0].name} - ${queuePlaylistsMap.get(currentTrackIdISRC)?.name}`,
                            album: queuePlaylistsMap.get(currentTrackIdISRC)?.name,
                            chapterTitle: queuePlaylistsMap.get(currentTrackIdISRC)?.name,
                            artwork: [{ src: current_track.album.images[0].url }]
                        });

                        // Update the playback state so the play/pause button looks right
                        navigator.mediaSession.playbackState = "playing";
                    }


                    lastTrackId = currentTrackIdISRC

                    // Force a small interaction signal
                    player.getVolume().then(v => {
                        player.setVolume(v > 0.1 ? v - 0.05 : v + 0.05).then(() => {
                            player.setVolume(v); // Quickly set it back
                        });
                    });

                    // --- THE KEY FIX ---
                    // 1. Re-activate the element to satisfy autoplay rules
                    // Nudge the browser to keep the audio context alive
                    // This may no longer be needed since we switched to a queue
                    //player.activateElement(); 

                    // **************** YA - DON'T DO THIS - THIS CAUSED AN AUTHENTICATION ERROR EVERYTIME!!!
                    // player.connect().then(success => {
                    //     if (success) {
                    //         console.warn("player_state_changed - New song detected - Connection request sent to Spotify!");
                    //     } else {
                    //     // SEND THE LOG
                    //     logEvent("ERROR", `player_state_changed - New song detected - Error: PLAYER_CONNECTION_FAIL`, {
                    //         step: "player_state_changed",
                    //         error: `PLAYER_CONNECTION_FAIL`,
                    //         stack_trace: new Error().stack, // Auto-trace errors
                    //         strikeCount: rateLimitStrikes,
                    //         activeMix: activeMixId
                    //     });
                    //         console.error("player_state_changed - New song detected - Error: PLAYER_CONNECTION_FAIL. Check your Premium status.");
                    //     }
                    // });
                    
                    // Small trick: Set volume to current level to trigger an 'interaction' event
                    player.getVolume().then(v => player.setVolume(v));
                    // 2. The "Nudge": Slightly change volume and back to trigger an interaction
                    player.getVolume().then(v => {
                        player.setVolume(v + 0.01).then(() => player.setVolume(v));
                    });

                    // 2. Explicitly resume the player so it's in a 'playing' state 
                    // before the new URI arrives
                    await player.resume(); 
                    //musicStartedOnDevice = true


                    //player.activateElement(); 




                    safeTimeout(() => {
                //////////////////////////////////////////
                //contextSyncedForCurrentTrack = false; // Reset for new song
                // 2. Logic to trigger the swap
                playlistContextEnabled = document.getElementById('sync-context-check').checked;
                const progressSecs = state.position / 1000
                const targetPlaylist = `spotify:playlist:${queuePlaylistsMap.get(currentTrackIdISRC)?.playlist}`; // Or a dynamic variable

                // Calculate how much time has passed since the last official SDK update
                //progressSecs = (performance.now() - lastState.timestamp) / 1000;

                //if (playlistContextEnabled && appVisible && !contextSyncedForCurrentTrack && progressSecs > 10) {
                if (playlistContextEnabled && appVisible && !contextSyncedForCurrentTrack) {
                    console.log("Song established. Syncing context...");
                    console.log(`%c playlistContextEnabled ${playlistContextEnabled} targetPlaylist: ${targetPlaylist}`, "color: #51ff00ff;")
                    syncSpotifyContext(targetPlaylist, currentTrackURI, (state.position+10000));
                }

                if(!contextSyncedForCurrentTrack){
                    updateSyncIndicator(false)
                }
                //////////////////////////////////////////
                    }, 10000);



                    // REFILL THE QUEUE: Now that we are on Song 2, queue up Song 3
                    // We wait 5 seconds to make sure the transition is stable
                    safeTimeout(() => {
                        prepareNextQueueItem();
                    }, 5000);
                }
                
                // Detect if the song has naturally ended
                // Position 0 and Paused = The track is over
                if (isAtEnd) {
                    console.log("Track finished! But it's a recent pick. Picking next song automatically...");
                    
                    // Reset the ID so the next song can be detected as 'new'
                    //currentTrackId = null; 
        
                    //pickRandomSong(); 
                }

                // Update Metadata
                document.getElementById('track-name').textContent = current_track.name;
                document.getElementById('playlist-name').textContent = queuePlaylistsMap.get(currentTrackIdISRC)?.name;
                document.getElementById('track-artist').textContent = current_track.artists[0].name;
                document.getElementById('album-art').src = current_track.album.images[0].url;
                document.getElementById('play-pause-btn').textContent = (paused || !devicePoweredOn) ? "▶" : "⏸";
                document.getElementById('play-pause-btn').style.background = "#1DB954"; // Spotify Green


                // Update Progress Bar (if not dragging)
                if (!isDraggingProgress) {
                    const progressBar = document.getElementById('progress-bar');
                    progressBar.max = duration;
                    progressBar.value = position;
                    document.getElementById('current-time').textContent = formatTime(position);
                    document.getElementById('duration-time').textContent = formatTime(duration);
                }

            });

            console.warn("Powering on...");
            // Use activateElement for mobile/Android compatibility
            if(player){
                player.activateElement();
                // The SDK will try to reconnect itself, but we can nudge it:
                await player.connect().then(success => {
                    if (success) {
                        visualLog(`%c Powering On - Player reconnected successfully`, "color: #2d8a02")
                        showResult(`%c Powering On - Player reconnected successfully`, "color: #2d8a02")
                        console.warn(`%c initial_player_connection - Powering On - Player reconnected successfully`, "color: #2d8a02")
                        // SEND THE LOG
                        logEvent("WARN", `initial_player_connection - Player reconnect SUCCESS`, {
                            step: "initial_player_connection",
                            error: `INITIAL_PLAYER_CONNECTION_SUCCESS`,
                            stack_trace: new Error().stack, // Auto-trace errors
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    } 
                    else {
                        visualLog(`%c Powering On - Player Re-Connection failed.`, "color: #ff0000;");
                        showResult(`%c Powering On - Player Re-Connection failed.`, "color: #ff0000;");
                        console.error(`%c initial_player_connection - Powering On - Playing song - Player Re-Connection failed.`, "color: #ff0000;");
                        // SEND THE LOG
                        logEvent("WARN", `initial_player_connection - Player reconnect FAIL`, {
                            step: "initial_player_connection",
                            error: `INITIAL_PLAYER_CONNECTION_FAIL`,
                            stack_trace: new Error().stack, // Auto-trace errors
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    }
                });
            }

            await refreshAccessToken()

        // // 1. Re-prime the browser's audio (Required for mobile)
        // await player.activateElement();
        
        // // 2. Tell Spotify to move the active session to this device_id
        // const starttoken = localStorage.getItem('access_token');
        // const res = await safeSpotifyFetch(`https://api.spotify.com/v1/me/player`, {
        //     method: 'PUT',
        //     body: JSON.stringify({ device_ids: [device_id], play: true }),
        //     headers: {
        //         'Content-Type': 'application/json',
        //         'Authorization': `Bearer ${starttoken}`
        //     }
        // });


            // START THE HEARTBEAT ONLY ONCE THE MIXER IS POWERED ON
            // We store it in a variable so 'Emergency Stop' can kill it later
            //if (!window.refreshInterval) {
                window.refreshInterval = setInterval(async () => {
                    if (device_id) { 
                        console.warn("Mixer is active, keeping token warm...");
                        await refreshAccessToken();
                        // SEND THE LOG
                        logEvent("INFO", `50_MIN_REFRESH_TOKEN | Mixer is active, keeping token warm...`, {
                            step: "50_MIN_REFRESH_TOKEN",
                            error: "50_MIN_REFRESH_TOKEN",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    }
                }, 50 * 60 * 1000); // 50 minutes
            //}

            // Add this inside your initBtn.onclick
            setInterval(() => {
                if (device_id && player) {
                    console.warn("Pinging Spotify to keep device active...");
                    player.connect().then(success => {
                        if (success) {
                        console.warn(`%c ping_spotify_connection - Player reconnected successfully`, "color: #2d8a02")
                        // SEND THE LOG
                        logEvent("WARN", `ping_spotify_connection | Connection request sent to Spotify! SUCCESS`, {
                            step: "ping_spotify_connection",
                            error: "PING_SPOTIFY_CONNECTION_SUCCESS",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                        } 
                        else {
                        console.error(`%c ping_spotify_connection - Refreshing Player - Player Re-Connection failed.`, "color: #ff0000;");
                        visualLog(`%c Refreshing Player - Playing song - Player Re-Connection failed.`, "color: #ff0000;");
                        showResult(`%c Refreshing Player - Playing song - Player Re-Connection failed.`, "color: #ff0000;");
                        // SEND THE LOG
                        logEvent("ERROR", `ping_spotify_connection | Connection request sent to Spotify! FAIL`, {
                            step: "ping_spotify_connection",
                            error: "PING_SPOTIFY_CONNECTION_FAIL",
                            stack_trace: new Error().stack, // Auto-trace errors
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                        }
                    });
                }
            }, 15 * 60 * 1000); // Every 15 minutes

            // The "Action Handlers" (The Remote Control)
            // This is the part that usually gets missed. You need to tell the Android OS what to do when the user hits the buttons on their lock screen. Put this in your initBtn.onclick (or anywhere it only runs once).
            if ('mediaSession' in navigator) {
                // When the user hits "Next" on the lock screen
                navigator.mediaSession.setActionHandler('nexttrack', () => {
                    console.warn("Lock screen: Next Track clicked.");
                        // SEND THE LOG
                        logEvent("INFO", `mediaSession_skip_button | Skipped to the next track!`, {
                            step: "mediaSession_skip_button",
                            error: "MEDIA_SESSION_SKIP_BUTTON",
                            skip: "SKIP",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    //pickRandomSong(); 
                    //player.nextTrack();
                    playNextTrack(lastState);
                });

                // When the user hits "Pause"
                navigator.mediaSession.setActionHandler('pause', () => {
                        // SEND THE LOG
                        logEvent("INFO", `mediaSession_pause | Paused playback`, {
                            step: "mediaSession_pause",
                            error: "MEDIA_SESSION_PAUSE",
                            pause: "PAUSE",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    setUserInitiatedPause()
                    
                    if (player) player.pause();
                    navigator.mediaSession.playbackState = "paused";
                });

                // When the user hits "Play"
                navigator.mediaSession.setActionHandler('play', async () => {
                        // SEND THE LOG
                        logEvent("INFO", `mediaSession_play | Resumed playback`, {
                            step: "mediaSession_play",
                            error: "MEDIA_SESSION_PLAY",
                            play: "PLAY",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });

                    if (player){
                        console.log(`Media Session Play Button - player.resume()`)
                        player.resume()
                        showResult(`${nowPlayingText}`, "color: #129900;")
                    }
                    navigator.mediaSession.playbackState = "playing";
                });
            }

        };
    }

    if (playPauseBtn) {
        playPauseBtn.onclick = async () => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

            if (!player || !devicePoweredOn) {
                alert("Powering player on first. Then starting music");
                initBtn.click()

                // Create a promise that resolves when a specific event is heard
                // await new Promise((resolve) => {
                //     initBtn.click();
                //     window.addEventListener('devicePoweredOn', resolve, { once: true });
                // });

                // Wait until devicePoweredOn is true
                await new Promise((resolve) => {
                    const checkInterval = setInterval(() => {
                    console.log(`%c checking devicePoweredOn`, "color: #ff00ffff; background: #000000;");
                        if (player && devicePoweredOn) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100); // check every 100ms
                });
            }
            // Code below will now wait for 'devicePoweredOn'


            if(!player || !devicePoweredOn){
                return
            }

            // Get the current state to see if a song is already loaded
            const state = await player.getCurrentState();

            if (!state && !musicStartedOnDevice) {
                // CASE 1: No song is loaded/playing yet
                console.log("No track detected. Starting first pick...");
                showResult(`%c Initializing first mix...`, "color: #000000;")
                visualLog(`%c Initializing first mix...`, "color: #000000;")
                const returnPickRandom = await pickRandomSong(); 

                if(returnPickRandom !== "SUCCESS"){
                    console.warn("playPauseBtn - pickRandomSong - FAIL:", returnPickRandom)
                }

                    safeTimeout(() => {
                        prepareNextQueueItem();
                    }, 15000);

                    safeTimeout(() => {
                        prepareNextQueueItem();
                    }, 30000);

                    safeTimeout(() => {
                        prepareNextQueueItem();
                    }, 45000);

            } 
            else {
                setUserInitiatedPause()
                // CASE 2: A song exists, so just toggle play/pause
                player.togglePlay().then(() => {
                    console.log('Toggled playback');
                        logEvent("INFO", `playPauseBtn_main | Toggled playback`, {
                            step: "playPauseBtn_main",
                            error: "PLAY_PAUSE_BTN_MAIN",
                            pause: "PAUSE",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                });
                showResult(`${nowPlayingText}`, "color: #129900;")
            }
        }
    }


    // --- INITIALIZE DATA AND UI HERE ---
    await loadAppState();

    await renderStoredMixes(); 


    // renderMixSelector()  
    // renderPlaylists()          
    await setSelectionMode(selectionMode); 
    //document.querySelector(`input[name="selectionMode"][value="${selectionMode}"]`).checked = true;

    if(!activeMixId){
        createDefaultMix();
    }
    
    await renderMixSelector();
    // -----------------------------------
    
if(returnRefreshAccessToken && 0){

        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


    syncRadioSpotifyRateLimit = false
    totalSpotifyRateLimit = false

    let spotifyRadioInterval = 15 //min
    while(1){
        await syncAllRadiosToSpotify()
        console.log(`✅ All stations synced successfully. Next master cycle in ${spotifyRadioInterval} minutes.`);
        await sleep(spotifyRadioInterval * 60 * 1000);
    }



    // setInterval(async () => {
    //     syncAllRadiosToSpotify()
    //     console.log(`✅ All stations synced successfully. Next master cycle in ${spotifyRadioInterval} minutes.`);
    // }, spotifyRadioInterval * 60 * 1000);
}


    //document.getElementById("balance-playlists").onclick = toggleSelectionMode
    document.querySelectorAll('input[name="selectionMode"]').forEach(radio => {
        radio.addEventListener("change", e => {
            setSelectionMode(e.target.value)
        })
    })

    document.getElementById('pick').onclick = async () => {

        if (!player || !devicePoweredOn) {
            alert("Powering player on first. Then starting music");
            initBtn.click()

            // Create a promise that resolves when a specific event is heard
            // await new Promise((resolve) => {
            //     initBtn.click();
            //     window.addEventListener('devicePoweredOn', resolve, { once: true });
            // });

            // Wait until devicePoweredOn is true
            await new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                console.log(`%c checking devicePoweredOn`, "color: #ff00ffff; background: #000000;");
                    if (player && devicePoweredOn) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100); // check every 100ms
            });
        }
        // Code below will now wait for 'devicePoweredOn'

        if(!player || !devicePoweredOn){
            return
        }

        pickRandomSong()
    }
    // document.getElementById('pick').onclick = () => {
    //     alert ("button clicked")
    // }

    document.getElementById('skip-button').onclick = () => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

        if (player) {
            player.nextTrack().then(() => {
                console.log('Skipped to the next track!');
                        // SEND THE LOG
                        logEvent("INFO", `internal_skip_button | Skipped to the next track!  duration:${lastState.duration}`, {
                            step: "internal_skip_button",
                            error: "INTERNAL_SKIP_BUTTON",
                            skip: "SKIP",
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
            }).catch(err => {
                console.error('Skip failed:', err);
                        // SEND THE LOG
                        logEvent("ERROR", `internal_skip_button | Skip failed: ${err}`, {
                            step: "internal_skip_button",
                            error: "INTERNAL_SKIP_BUTTON_ERROR",
                            stack_trace: new Error().stack, // Auto-trace errors
                            error_message: err,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
            });
        }
    };

    document.getElementById('manual-retry-btn').onclick = async () => {
        const uriInput = document.getElementById('manual-uri-input');
        const uri = uriInput.value.trim();

        // Basic validation: Check if it looks like a Spotify track URI
        if (uri.startsWith('spotify:track:') && uri.length > 20) {
            console.log("Manually retrying with URI:", uri);
            showResult(`%c Manual Play: ${uri}`, "color: #0004ff;")
            visualLog(`%c Manual Play: ${uri}`, "color: #0004ff;")
            
            // Use your existing playTrack function
            const playTrackReturn = await playTrack(uri, false);
            if(playTrackReturn !== "SUCCESS"){
                console.warn("manual-retry-btn playTrack - safeSpotifyFetch - FAIL:", playTrackReturn)
            }

            
            // Optional: Clear the input after playing
            uriInput.value = '';
        } else {
            alert("Please enter a valid Spotify track URI (e.g., spotify:track:...)");
        }
    };

    document.getElementById("generate-playlist").onclick = async () => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

        //Force a save and a small wait to ensure all rebalancing math is finished
        isProgrammaticSliderUpdate = false; //emergency reset
        saveAppState() //Force current UI values into the logic state
        await new Promise(r => setTimeout(r, 50)) //Tiny delay for rebalance stability
        generateRandomPlaylist()

        //re-sync the UI one last time after generation
        syncSlidersFromState();
    }

    document.getElementById("save-mix").onclick = () => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

        const name = document.getElementById("new-mix-name").value.trim()
        if(!name){
            alert("Enter a mix name")
            return
        }

        const id = Date.now().toString()

        mixes[id] = {
            name: name,
            playlists: structuredClone(playlists),
            selectionMode: "balanced"
        }

        activeMixId = id
        saveAppState()
        renderMixSelector()
        renderStoredMixes(); // Refresh the list
                        // SEND THE LOG
                        logEvent("WARN", `save_mix | ${name}`, {
                            step: "save_mix",
                            error: "SAVE_MIX",
                            mix_name: name,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });

    }

    document.getElementById("mix-selector").onchange = async(e) => {
        activeMixId = e.target.value
        const selectedMix = mixes[activeMixId];

        playlists = structuredClone(mixes[activeMixId].playlists)
        selectionMode = selectedMix.selectionMode || "balanced" //restore the mode
        setSelectionMode(selectionMode)

        //update the radio buttons to match
        //document.querySelector(`input[name="selectionMode"][value="${selectionMode}"]`).checked = true;

        playlists.forEach((playlist, index) => {
            setTimeout(() => {
        //        refreshPlaylistCount(playlist.id, index);
            }, 2000 * index);
         })
        
        renderPlaylists()
        saveAppState()
    }

    document.getElementById('master-playlist-toggle').addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        
        // 1. Update the 'enabled' state for EVERY playlist in your array
        playlists.forEach(playlist => {
            playlist.enabled = isChecked;
        });

        // 2. Re-render the list so the individual checkboxes reflect the change
        renderPlaylists();

        // 3. Save to localStorage so it persists
        saveAppState();
        
        console.log(`All playlists ${isChecked ? 'enabled' : 'disabled'}`);
                        // SEND THE LOG
                        logEvent("INFO", `master_playlist_toggle | All playlists ${isChecked ? 'enabled' : 'disabled'}`, {
                            step: "master_playlist_toggle",
                            error: "MASTER_PLAYLIST_TOGGLE",
                            enabled: isChecked ? 'enabled' : 'disabled',
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
    });

    // On Load: Set the checkbox state from LocalStorage
    const syncCheck = document.getElementById('sync-context-check');
    const savedSyncState = localStorage.getItem('syncContextEnabled');
    // Convert string 'true' to boolean true, default to false if null
    syncCheck.checked = (savedSyncState === 'true');
    // On Change: Save the new state to LocalStorage
    syncCheck.addEventListener('change', (e) => {
        localStorage.setItem('syncContextEnabled', e.target.checked);
    });

    const importBtn = document.getElementById('import-trigger-btn');
    //const fileInput = document.getElementById('import-file-input');

    document.getElementById('share-mix-btn').onclick = generateShareLink; // don't add () to this function or it assigns this to the button listener and will trigger at the beginning.
    // When you click the pretty button, it "clicks" the hidden file input
    importBtn.onclick = () => importMix();
    // When the user actually picks a file, run the import logic
    //fileInput.onchange = (event) => importMix(event);

    // document.getElementById('toggle-list-btn').onclick = function() {
    //     const list = document.getElementById('playlist-list');
    //     const btn = this;

    //     if (list.style.maxHeight === "200px" || list.style.maxHeight === "") {
    //         // EXPAND
    //         //max-height vs height: Using max-height: 1000px (or none) allows the box to grow only as large as the content inside it.
    //         list.style.maxHeight = "10000px"; // Set to a height larger than your list
    //         list.style.overflowY = "visible";
    //         btn.textContent = "▲ Show Less";
    //     } else {
    //         // COLLAPSE
    //         list.style.maxHeight = "200px";
    //         list.style.overflowY = "auto";
    //         btn.textContent = "▼ Show All";
    //     }
    // };
    // Select all buttons with the class "action-btn"
    const buttons = document.querySelectorAll('.toggle-list-btn-class');

    // Loop through them and add a click event to each
    buttons.forEach(button => {
        button.addEventListener('click', () => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

            console.log("Button clicked! Performing JS code...");

            const list = document.getElementById('playlist-list');
            const btn = this;

            if (list.style.maxHeight === "200px" || list.style.maxHeight === "") {
                // EXPAND
                //max-height vs height: Using max-height: 1000px (or none) allows the box to grow only as large as the content inside it.
                list.style.maxHeight = "none"; // Set to a height larger than your list
                list.style.maxWidth = "none"
                list.style.overflowY = "visible";
                btn.textContent = "▲ Show Less";
            } else {
                // COLLAPSE
                list.style.maxHeight = "200px";
                list.style.overflowY = "auto";
                btn.textContent = "▼ Show All";
            }

            // Sync BOTH buttons at the same time
            buttons.forEach(b => {
                b.textContent = btn.textContent;
            });
        });
    });

    document.getElementById('toggle-list-btn-mix').onclick = function() {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

        const list = document.getElementById('stored-mixes-list');
        const btn = this;

        if (list.style.maxHeight === "50px" || list.style.maxHeight === "") {
            // EXPAND
            //max-height vs height: Using max-height: 1000px (or none) allows the box to grow only as large as the content inside it.
            list.style.maxHeight = "none"; // Set to a height larger than your list
            list.style.overflowY = "visible";
            btn.textContent = "▲ Show Less";
        } else {
            // COLLAPSE
            list.style.maxHeight = "50px";
            list.style.overflowY = "auto";
            btn.textContent = "▼ Show All";
        }
    };

    document.getElementById('playlist-container').addEventListener('click', (e) => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

        if (e.target.classList.contains('playlist-solo-btn')) {
            const targetId = e.target.getAttribute('data-id');
            
            console.log("🎯 Soloing playlist:", targetId);

            // 1. Update the Data: Disable all, enable target
            playlists.forEach(pl => {
                pl.enabled = (pl.id === targetId);
            });

            // 2. Update the UI Checkboxes
            const checkboxes = document.querySelectorAll('.playlist-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = (cb.getAttribute('data-id') === targetId);
            });

            // 3. Save to localStorage so it persists
            saveAppState();
            renderPlaylists();
        }
    });

    document.getElementById('playlist-list').addEventListener('click', (e) => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

        const btn = e.target.closest('.step-btn');
        if (!btn) return;

        const index = Number(btn.dataset.index);
        const slider = btn.parentElement.querySelector('.playlist-slider');

        // 1. Travel UP to find the main row
        const row = e.target.closest('.playlist-row'); 
        // 2. Travel DOWN from that row to find the checkbox
        const checkBox = row.querySelector('.playlist-enabled'); 

        let currentValue = Number(slider.value);

        // Increment or Decrement by 1
        if (btn.classList.contains('step-up')) {
            //currentValue = Math.min(100, currentValue + 1);
            currentValue++
        } else {
            currentValue = Math.max(0, currentValue - 1);
        }

        // 1. Update UI and Data
        slider.value = currentValue;
        playlists[index].sliderValue = currentValue;

        //If in normal mode, moving slider switches to slider mode
        if((selectionMode === "normal") || (selectionMode === "balanced")){
            selectionMode = "percentage"
            setSelectionMode(selectionMode)

            //update radio button
            //document.querySelector('input[value="percentage"]').checked = true
            //normalizePercentagesAfterToggle() //REMOVED - This will snap values back instead of using the user's slider value
            showResult(`%c Percentage mode enabled`, "color: #0004ff;")
            console.log(`%c Percentage mode enabled`, "color: #0004ff;")
            visualLog(`%c Percentage mode enabled`, "color: #0004ff;")
        }

        if (selectionMode === "percentage") {
            rebalancePercentagesByIndex(index);
            syncSlidersFromState()
            renderPlaylists();
        }

        // 2. Trigger your rebalance/display logic
        updateSliderDisplay(slider);
        
        //Slider at 0 disables playlist
        if(playlists[index].sliderValue <= 0){
            playlists[index].enabled = false
            checkBox.checked = false
        }
        
        saveAppState();
    });

    document.getElementById('history-list').addEventListener('click', async (e) => {

            // Log user gesture to keep tab active
            // This "primes" the browser to trust the SDK for the rest of the session
            // Call player.activateElement() on EVERY user interaction
            if(player) player.activateElement(); 

        if (e.target.classList.contains('history-play-btn')) {
            const uri = e.target.getAttribute('data-uri');
            
            console.log("🎯 Manual history play triggered:", uri);
            
            // Use your existing play function
            // This will usually involve a call to 'https://spotify.com'
            const playTrackReturn = await playTrack(uri, false); //retry false

            if(playTrackReturn !== "SUCCESS"){
                console.warn("playfrom-history-list playTrack - safeSpotifyFetch - FAIL:", playTrackReturn)
                
                // SEND THE LOG
                logEvent("ERROR", `playfrom-history-list playTrack - safeSpotifyFetch - FAIL: ${playTrackReturn}`, {
                    step: "playfrom-history-list",
                    error: `PLAY_FROM_HISTORY_LIST_FAIL `,
                    stack_trace: new Error().stack, // Auto-trace errors
                    track_uri: uri,
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
            }
        }
    });

    // Event Listeners
    document.getElementById('touch-block-btn').onclick = () => toggleTouchBlock(true);
    document.getElementById('unlock-btn').onclick = () => toggleTouchBlock(false);

    // Re-acquire Wake Lock if app is minimized and then returned to
    document.addEventListener('visibilitychange', async () => {
        const masterBtn = document.getElementById('touch-block-btn');
        if (masterBtn && wakeLock !== null && document.visibilityState === 'visible') {
            await requestWakeLock();
        }
    });

})

function initApp() {

    // When an OS discards a frozen app to free up memory, the app is killed entirely. 
    // When the user returns, the page performs a full reload. 
    // You can detect this by checking the document.wasDiscarded property during your 
    // app's initialization.

    // Check if we are starting fresh or returning from a discarded state
    if (document.wasDiscarded) {
        console.log("App was previously discarded by the OS. Restoring session...");
        
        // Restore view state and track context from localStorage
        const savedProgress = localStorage.getItem('last_progress_ms');
        const savedTrack = localStorage.getItem('last_track_uri');
        
        if (savedProgress && savedTrack) {
            // Logic to resume playback at the exact point it was killed
            // (e.g., Calling your Spotify PUT /play with position_ms)
        }
    } else {
        console.log("Standard app launch.");
    }
    
    // Standard initialization follows...
}

// Register Service Worker after the page has fully loaded
window.addEventListener('load', () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('Service Worker: Registered (Scope: ' + reg.scope + ')'))
            .catch(err => console.error('Service Worker: Error', err));
    }

    initApp()
});

let deferredPrompt;
const installBtn = document.getElementById('install-pwa-btn');

// window.addEventListener('beforeinstallprompt', (e) => {
//     // 1. Prevent the default "mini-infobar" from appearing on mobile
//     e.preventDefault();
//     // 2. Stash the event so it can be triggered later
//     deferredPrompt = e;
//     // 3. Show our custom install button
//     if (installBtn) installBtn.style.display = 'block';
// });

// installBtn.addEventListener('click', async () => {
//     if (!deferredPrompt) return;
    
//     // 4. Show the install prompt
//     deferredPrompt.prompt();
    
//     // 5. Wait for the user to respond to the prompt
//     const { outcome } = await deferredPrompt.userChoice;
//     console.log(`User response to install prompt: ${outcome}`);
    
//     // 6. We can't use the prompt again, so clear it
//     deferredPrompt = null;
//     installBtn.style.display = 'none';
// });

// Hide the button if the app is already installed
window.addEventListener('appinstalled', () => {
    console.log('PWA was installed');
    installBtn.style.display = 'none';
});

function initInstallButton() {
    const installBtn = document.getElementById('install-pwa-btn');
    if (!installBtn) return;

    const showButton = () => {
        console.log("Showing PWA Install Button");
        installBtn.style.display = 'block';
    };

    // If we already caught the event in the head, show the button now
    if (window.deferredPrompt) {
        showButton();
    }

    // Otherwise, listen for our custom signal
    window.addEventListener('pwa-installable', showButton);

    installBtn.addEventListener('click', async () => {
        if (!window.deferredPrompt) return;
        window.deferredPrompt.prompt();
        const { outcome } = await window.deferredPrompt.userChoice;
        console.log(`User Choice: ${outcome}`);
        window.deferredPrompt = null;
        installBtn.style.display = 'none';
    });
}

window.addEventListener('freeze', (event) => {
    // The browser is about to suspend this page
    console.warn(`%c App FREEZE - Saving App State for recovery`, "color: #ff9100")
    visualLog(`%c The app is being FROZEN by the Operating System - Saving App State for recovery`, "color: #ff9100")
    showResult(`%c The app is being FROZEN by the Operating System - Saving App State for recovery`, "color: #ff9100")
        // SEND THE LOG
        logEvent("WARN", `App FREEZE - Saving App State for recovery`, {
            step: "freezeEvent",
            error: `FREEZE_EVENT`,
            strikeCount: rateLimitStrikes,
            activeMix: activeMixId
        });
    saveAppState();

    if (window.refreshInterval) {
        clearInterval(window.refreshInterval);
        window.refreshInterval = null;
        console.warn("Refresh heartbeat stopped.");
    }

}, { capture: true });
window.addEventListener('resume', async (event) => {
    // 1. Re-initialize state (re-hydrate from localStorage)
    //rehydrateAppState();
    // Would you like help with the specific rehydrateAppState() logic to ensure 
    // your Spotify tokens and current track information are restored accurately after a discard?
    
    // 2. Restart timers/polling
    //startPlaybackPolling();
    
    // 3. Re-establish connections (SDK, WebSockets, etc.)
    console.log("App resumed: Re-establishing connections.");
    console.warn(`%c App RESUME - Re-establishing connections.`, "color: #ff9100")
    visualLog(`%c The app is RESUMING from being FROZEN by the Operating System - Re-establishing connections.`, "color: #ff9100")
    showResult(`%c The app is RESUMING from being FROZEN by the Operating System - Re-establishing connections.`, "color: #ff9100")
        // SEND THE LOG
        logEvent("WARN", `App RESUME - Re-establishing connections.`, {
            step: "resumeEvent",
            error: `RESUME_EVENT`,
            strikeCount: rateLimitStrikes,
            activeMix: activeMixId
        });

    await refreshAccessToken()
    
    if(player){
        // The SDK will try to reconnect itself, but we can nudge it:
        player.connect().then(success => {
            if (success) {
                visualLog(`%c App RESUMING - Player reconnected successfully`, "color: #2d8a02")
                showResult(`%c App RESUMING - Player reconnected successfully`, "color: #2d8a02")
                console.warn(`%c App RESUMING - Player reconnected successfully`, "color: #2d8a02")
        // SEND THE LOG
        logEvent("WARN", `App RESUME - Player reconnect SUCCESS`, {
            step: "resumeEvent",
            error: `RESUME_EVENT_RECONNECT_SUCCESS`,
            strikeCount: rateLimitStrikes,
            activeMix: activeMixId
        });
            } 
            else {
                visualLog(`%c App RESUMING - Player Re-Connection failed.`, "color: #ff0000;");
                showResult(`%c App RESUMING - Player Re-Connection failed.`, "color: #ff0000;");
                console.error(`%c App RESUMING - Player Re-Connection failed.`, "color: #ff0000;");
        // SEND THE LOG
        logEvent("WARN", `App RESUME - Player reconnect FAIL`, {
            step: "resumeEvent",
            error: `RESUME_EVENT_RECONNECT_FAIL`,
            strikeCount: rateLimitStrikes,
            activeMix: activeMixId
        });
            }
        });
    }

}, { capture: true });

// 1. Detect when the connection is LOST
window.addEventListener('offline', () => {
    console.log("🚀 Internet connection lost.");
    visualLog(`%c 🚀 Internet connection lost.`, "color: #ff0000; background: #ffffff;")
    
    // Store the "down time" locally since we can't fetch right now
    localStorage.setItem('last_offline_time', Date.now());
                // SEND THE LOG
                logEvent("WARN", `offline_listener - 🚀 Internet connection lost.`, {
                    step: "offline_listener",
                    error: "OFFLINE_LISTENER",
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

    // Stop the progress bar heartbeat so it doesn't "ghost" forward
    if (window.refreshInterval) clearInterval(window.refreshInterval);
    
    // Optional: Show a UI notification to the user
    showOfflineOverlay(true);
});

// 2. Detect when the connection is RESTORED
window.addEventListener('online', async () => {

    // Calculate how long we were gone
    const wentOfflineAt = localStorage.getItem('last_offline_time');
    let durationSeconds = 0;
    if (wentOfflineAt) {
        durationSeconds = Math.floor((Date.now() - wentOfflineAt) / 1000);
    }
    console.log(`🌐 Internet connection restored. Reconnecting... | offlineDurationSeconds: ${durationSeconds}`);
    visualLog(`%c 🌐 Internet connection restored. Reconnecting... | offlineDurationSeconds: ${durationSeconds}`, "color: #00ccff; background: #ffffff;")
                // SEND THE LOG
                logEvent("WARN", `online_listener - 🌐 Internet connection restored. Reconnecting... | offlineDurationSeconds: ${durationSeconds}`, {
                    step: "online_listener",
                    error: "ONLINE_LISTENER",
                    offlineDurationSeconds: durationSeconds,
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

    // 1. Refresh token first so the connection attempt doesn't fail
    const expiry = localStorage.getItem('token_expiry');
    const remainingMs = expiry - Date.now();
    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);
    console.warn(`Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`);
    if (Date.now() > expiry) {
        console.warn(`online_listener - past expire timer - refreshing access token. Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`)
        // SEND THE LOG
        logEvent("DEBUG", `online_listener - past expire timer - refreshing access token. Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`, {
            step: "online_listener",
            error: `ONLINE_LISTENER_REFRESHACCESS`,
            strikeCount: rateLimitStrikes,
            activeMix: activeMixId
        });
        await refreshAccessToken();
    }
    // Hide the notification
    showOfflineOverlay(false);
    
    // Re-verify the player connection
    // Check if player exists AND is initialized
    if (typeof player !== 'undefined' && player !== null) {
        // 2. Try to reconnect the socket
        const connected = await player.connect();
        
        if (connected) {
            // 3. Force a state check to wake up the UI
            setTimeout(() => {
                player.getCurrentState().then(state => {
                    if (state) {
                        updateUI(state);
                        if (wakeLock !== null) {
                            requestWakeLock();
                        }

                        // 1. Clear any old heartbeats to prevent "double-timers"
                        if (window.refreshInterval) clearInterval(window.refreshInterval);

                        // 2. Start a new interval (usually 1000ms for a progress bar)
                        window.refreshInterval = setInterval(async () => {
                            player.getCurrentState().then(state => {
                                if (state && !state.paused) {
                                    // This is the function we wrote to update your bar & timers
                                    updateUI(state); 
                                }
                            });
                            if (device_id) { 
                                console.warn("Mixer is active, keeping token warm...");
                                await refreshAccessToken();
                                // SEND THE LOG
                                logEvent("INFO", `50_MIN_REFRESH_TOKEN | Mixer is active, keeping token warm...`, {
                                    step: "50_MIN_REFRESH_TOKEN",
                                    error: "50_MIN_REFRESH_TOKEN",
                                    strikeCount: rateLimitStrikes,
                                    activeMix: activeMixId
                                });
                            }
                        }, 50 * 60 * 1000); //50min
                    } else {
                        logEvent("WARN", "Player connected but state is null");
                    }
                });
            }, 1000); // Give the SDK a second to breathe
        }    } 
    else {
        console.log("SDK not ready yet; skipping re-sync.");
    }
});

// Simple UI Toggle Helper
function showOfflineOverlay(show) {
    const overlay = document.getElementById('offline-status');
    if (overlay) {
        overlay.style.display = show ? 'flex' : 'none';
    }
}

// import express from "express"

// const app = express()
// app.use(express.json())
// app.post("/spotify-proxy", async(req, res) => {
//     const spotifyResponse = await fetch(req.body.url, {
//         method: req.body.method || "GET",
//         headers: {
//             Authorization: req.body.authorization,
//             "Content-Type": "application/json"
//         },
//         body: req.body.body
//             ? JSON.stringify(req.body.body)
//             : undefined
//     });

//     const retryAfter = spotifyResponse.headers.get("retry-after")

//     const text = await spotifyResponse.text()

//     res.set(
//         "Access-Control-Expose-Headers",
//         "Retry-After"
//     )

//     if(retryAfter){
//         res.set("Retry-After", retryAfter)
//     }

//     res.status(spotifyResponse.status).send(text)
// })

// app.listen(3000)
