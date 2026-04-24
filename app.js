//alert("app.js loaded")

let player;
let device_id;
let isRefreshing = false;
let userInitiatedPause = false;
let lastPickTime = 0;
let internalQueue = []; // Array of {id, name, artist, playlistName}
let queuePlaylistName = ""
const queuePlaylistNames = [
  { id: "id1", name: 'Alice' },
  { id: "id2", name: 'Bob' }
];
const queuePlaylistsMap = new Map(queuePlaylistNames.map(obj => [obj.id, obj]));
let lastTrackId

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
    console.warn("EMERGENCY STOP TRIGGERED");
            // SEND THE LOG
            logEvent("ERROR", `EMERGENCY STOP TRIGGERED`, {
                step: "emergencyStop",
                error: `EMERGENCY_STOP`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

    
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
    currentTrackId = null;
    document.getElementById('init-player').textContent = "🔌 Power On Mixer";
    document.getElementById('init-player').style.background = "#ff0000";
    showResult("Mixer Hard-Reset: All processes stopped.");

    if (window.refreshInterval) {
        clearInterval(window.refreshInterval);
        window.refreshInterval = null;
        console.warn("Refresh heartbeat stopped.");
    }
}

async function logEvent(level, message, metadata = {}) {
    const SOURCE_TOKEN = "K77AoFCVGv9iKQyCyLEdvjYe";

    if(!loggingLocked){

        if((currentSpotifyUser === "fail") || (currentSpotifyUser === "guest")){
            await fetchUserProfile();
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
    if(!updatingCurrentSpotifyUser){
        
        updatingCurrentSpotifyUser = true

        const token = localStorage.getItem('access_token');
        //const res = await fetch('https://api.spotify.com/v1/me', {
        const res = await safeSpotifyFetch('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
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

        }
        else{
            console.warn(`fetchUserProfile FAIL`)
            currentSpotifyUser = "fail"
        }

        updatingCurrentSpotifyUser = false;
    }
}


async function playTrack(trackUri, isRetry = false) {
    const token = localStorage.getItem('access_token');
    // If the app just refreshed, device_id might be null, so check storage
    if (!device_id) {
        device_id = localStorage.getItem('last_active_device');
    }
    if (!device_id) alert("Click 'Power On' first!");
    if (!device_id) {
        showResult("No device found. Please Power On.");
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            return("429_STRIKE")
        }

        if (response.status === 404) {
            console.warn("playTrack Device ID not found. Attempting to refresh device list...");
            showResult("Re-syncing with Spotify...");

            // Check if the token is likely the problem
            const expiry = localStorage.getItem('token_expiry');
            if (Date.now() > expiry) {
                showResult("404 Session expired. Refreshing...");
                console.warn("404 Session expired. Refreshing...");
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - 404 Session expired. Refreshing...`, {
                step: "playTrack",
                error: "404_SESSION_EXPIRED",
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                await refreshAccessToken();
            }

            if(!isRetry){

                // Logic to re-fetch devices or re-initialize player
                // 1. Tell the SDK to re-announce itself to Spotify
                await player.connect();
                
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                        return "404_DEVICE_ID_NOT_FOUND.RETRY.FAIL"
                    }
                }, 1000);
            } else {
                console.warn("playTrack - 404 persisted after retry. Stopping loop.");
                showResult("Connection lost. Please Power Off and On again.");
            // SEND THE LOG
            logEvent("WARN", `playTrack - safeSpotifyFetch - 404 persisted after retry. Stopping loop.`, {
                step: "playTrack",
                error: "404_DEVICE_NOT_FOUND",
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
            showResult("Song restricted by Spotify. Picking another...");
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
                        console.log("Local player resumed after URI injection");
                    }).catch(err => {
                        // If this fails, the browser is likely blocking autoplay
                        console.error("Autoplay blocked by browser. Manual click required.", err);
                        showResult("Autoplay blocked by browser. Manual click required.", err);
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
                setTimeout(() => {
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
}

async function playFromSpecificPlaylist(chosenplaylist) {
    const playlistIndex = playlists.findIndex(p => p.id === chosenplaylist.id);

    const index = Math.floor(Math.random() * chosenplaylist.trackCount) // uniform inside playlist
        showResult(`--------------- Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`)        
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
    refreshPlaylistCount(chosenplaylist.id, playlistIndex);
    const track = await getTrackAtIndex(token, chosenplaylist.id, index)
    
    if (track === "NETWORK_ERROR"){
        console.log("playFromSpecificPlaylist: NETWORK_ERROR, stopping loop")
            // SEND THE LOG
            logEvent("ERROR", `playFromSpecificPlaylist - NETWORK_ERROR, stopping loop`, {
                step: "playFromSpecificPlaylist",
                error: `NETWORK_ERROR`,
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
        showResult(`Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`);
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

        queuePlaylistsMap.set(trackISRC, { name: chosenplaylist.name });

        const playTrackReturn = await playTrack(track.uri, false); //retry false

            if(playTrackReturn !== "SUCCESS"){
                console.warn("playFromSpecificPlaylist playTrack - safeSpotifyFetch - FAIL:", playTrackReturn)
            // SEND THE LOG
            logEvent("ERROR", `playFromSpecificPlaylist playTrack - safeSpotifyFetch - FAIL: ${playTrackReturn}`, {
                step: "playFromSpecificPlaylist",
                error: `PLAYTRACK_FAIL`,
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
                    artist: `${track.artists[0].name} ${chosenplaylist.name}`,
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

        // If track was null (failed safety checks), try again!
        // console.log("Track was restricted or null. Retrying pick attempt " + (attempt + 1) + "...");
        // safeTimeout(() => pickRandomSong(attempt + 1), 1000) //setTimeout ensures you never make more than one retry per second 
    }

}

async function prepareNextQueueItem(attempt = 0) {

    // Safety: Don't get stuck in an infinite loop if a playlist is 100% unplayable
    if (attempt > 5) {
        showResult("Error: Hit too many restricted tracks. Try a different playlist.");
        console.log("Error: Hit too many restricted tracks. Try a different playlist.");
            // SEND THE LOG
            logEvent("WARN", `prepareNextQueueItem - Error: Hit too many restricted tracks. Try a different playlist.`, {
                step: "prepareNextQueueItem",
                error: `RESTRICTED_TRACKS_LIMIT`,
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
            // SEND THE LOG
            logEvent("TRACE", `prepareNextQueueItem - Queue Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${randomIndex + 1}`, {
                step: "prepareNextQueueItem",
                error: `QUEUE_TRACK`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        
    refreshPlaylistCount(chosenplaylist.id, playlistIndex);
    const nextTrack = await getTrackAtIndex(token, chosenplaylist.id, randomIndex);


    if (nextTrack === "NETWORK_ERROR"){
        console.warn("prepareNextQueueItem - getTrackAtIndex - NETWORK_ERROR, stopping loop")
            // SEND THE LOG
            logEvent("ERROR", `prepareNextQueueItem - getTrackAtIndex - NETWORK_ERROR, stopping loop`, {
                step: "prepareNextQueueItem",
                error: `NETWORK_ERROR`,
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return; // Don't even attempt a retry loop
        }
        // ... normal restricted track retry logic ...
    }


    if (nextTrack && nextTrack.uri) {

        console.log(`Queued up: ${nextTrack.name} by ${nextTrack.artists[0].name} -  ${chosenplaylist.name} for later.`);
            // SEND THE LOG
            logEvent("TRACE", `prepareNextQueueItem - getTrackAtIndex: Queued up: [${nextTrack.name}  by ${nextTrack.artists[0].name} - ${chosenplaylist.name}] for later.`, {
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return("FAIL")
        }

        incrementPlaylistCount(chosenplaylist.id)

        let trackISRC
        trackISRC = nextTrack.id
        
        queuePlaylistsMap.set(trackISRC, { name: chosenplaylist.name });

        // 2. Add to our visual internal queue
        internalQueue.push({
            id: trackISRC,
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        safeTimeout(() => prepareNextQueueItem(attempt + 1), 1000) //setTimeout ensures you never make more than one retry per second 
    }
}



async function addToQueue(trackUri) {
    const token = await getStoredToken('access_token'); // Using the retry helper
    const url = `https://api.spotify.com/v1/me/player/queue?uri=${trackUri}&device_id=${device_id}`;

    try {
        const response = await safeSpotifyFetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if(response === "MAX_CALLS_PER_MINUTE"){
            console.warn("addToQueue - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "addToQueue",
                error: `MAX_CALLS_PER_MINUTE`,
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
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

    } catch (err) {
        console.error("Queue error:", err);
            // SEND THE LOG
            logEvent("ERROR", `addToQueue - Queue error: ${err}`, {
                step: "addToQueue",
                error: `QUEUE_ERROR`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
    }
}

function renderQueue() {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = internalQueue.map(track => `
        <li class="queue-item">
            <span class="track-info"><strong>${track.name}</strong> - ${track.artist}</span>
            <span class="source-playlist"; style="color: #8352f5;">- ${track.playlist}</span>
        </li>
    `).join('');
}

function addToHistory(track, playlistName) {
    //console.warn("addToHistory")
    const historyList = document.getElementById('history-list');
    if (!historyList) return;

    // Remove the "No songs played yet" placeholder on first play
    if (historyList.innerHTML.includes("No songs played yet")) {
        historyList.innerHTML = "";
    }

    const entry = document.createElement('div');
    entry.style.padding = "5px 0";
    entry.style.borderBottom = "1px solid #282828";
    
    // Format: Song Name - Artist (from Playlist Name)
    entry.innerHTML = `
        <strong style="color: #1DB954;">${track.name}</strong> 
        by ${track.artists[0].name} 
        <span style="font-size: 0.8em; color: #8352f5;">— ${playlistName}</span>
    `;

    // Add to the top of the list
    historyList.prepend(entry);

    // // Keep only the last 10 entries
    // if (historyList.children.length > 10) {
    //     historyList.removeChild(historyList.lastChild);
    // }
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
    player.getCurrentState().then(state => {
        if (!state) return;
        const newPos = Math.max(0, Math.min(state.duration, state.position + offset));
        player.seek(newPos);
        console.log(`Manual seek: ${offsetMs > 0 ? '+' : ''}${offsetMs/1000}s`);
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
const clientId = '3bb9a06bf9a24bc09260891c9d153abd'; // Replace with your actual Client ID
//const redirectUri = 'http://127.0.0.1:8000/'; // Must match your Dashboard EXACTLY
//const redirectUri = 'http://192.168.1.141:8000/'; // Must match your Dashboard EXACTLY
//const redirectUri = 'https://benburtspotifyapp.netlify.app/'; // Must match your Dashboard EXACTLY
//const redirectUri = 'netlifylocation';
const redirectUri = window.location.origin + '/'; 
// This automatically picks http://127.0.0.1 locally 
// AND https://your-app.netlify.app once hosted!
const scope = 'user-read-private user-read-email streaming user-modify-playback-state playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative';

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

// This function starts the process by redirecting the user to Spotify’s secure login page.
async function redirectToSpotifyAuth() {
    const codeVerifier = generateRandomString(64);
    const hashed = await sha256(codeVerifier);
    const codeChallenge = base64encode(hashed);

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
    window.location.href = authUrl.toString(); // Redirects the entire page
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

async function refreshAccessToken() {
    
    if (isRefreshing) return; // Exit if a refresh is already in progress
    isRefreshing = true;

    //const refreshToken = localStorage.getItem('refresh_token');
    const refreshToken = await getStoredToken('refresh_token');
    
    // CHANGE THIS:
    if (!refreshToken) {
        console.warn("No refresh token found. User needs to log in manually.");
            // SEND THE LOG
            logEvent("WARN", `refreshAccessToken - No refresh token found. User needs to log in manually.`, {
                step: "refreshAccessToken",
                error: `NO_REFRESH_TOKEN`,
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
        const response = await safeSpotifyFetch("https://accounts.spotify.com/api/token", payload);

        if(response === "MAX_CALLS_PER_MINUTE"){
            console.warn("refreshAccessToken - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "refreshAccessToken",
                error: `MAX_CALLS_PER_MINUTE`,
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
        
        if(!response.ok){
            console.error("Error: refreshAccessToken - safeSpotifyFetch blocked")
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - safeSpotifyFetch - BLOCKED`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_FETCH_BLOCKED`,
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
            // SEND THE LOG
            logEvent("WARN", `refreshAccessToken - Token Refreshed Successfully! ${data.expires_in} ${expiresAt}`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_SUCCESS`,
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
    } catch (err) {
        console.error("refreshAccessToken - Refresh failed, but staying on page:", err);

        // ONLY clear tokens if it's a definitive "Unauthorized" error from Spotify
        // If 'err' is a TypeError (Network Request Failed), we KEEP the tokens.
        if (err.status === 400 || err.status === 401) {
            console.warn("Session actually expired. Clearing tokens.");
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - Refresh failed, but staying on page, LOGIN NEEDED: ${err}`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_ERROR_LOGIN_NEEDED`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');

            // ... update button to red ...
            // Don't redirect here! Just let the user click 'Login' manually if they need to.
            //localStorage.removeItem('access_token');
            //localStorage.removeItem('refresh_token');
            showResult("Session expired. Please log in again.");
            
            // Change button text to show user is logged in
            document.getElementById('login-button').textContent = "Login with Spotify";
            document.getElementById('login-button').disabled = false;
            document.getElementById('login-button').style.background = "#ff0000";
        } else {
            // It's likely a network flicker. DO NOT DELETE TOKENS.
            console.log("Network flicker detected. Keeping tokens for retry.");
            // SEND THE LOG
            logEvent("ERROR", `refreshAccessToken - Refresh failed, Network flicker detected. Keeping tokens for retry: ${err}`, {
                step: "refreshAccessToken",
                error: `REFRESH_TOKEN_ERROR_RETRY`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        isRefreshing = false;
    }
    isRefreshing = false;
}

async function resumeOnThisDevice() {
    console.warn("Attempting to reclaim playback session...");
    showResumeOverlay(false);
    
    try {
        // 1. Re-prime the browser's audio (Required for mobile)
        await player.activateElement();
        
        // 2. Tell Spotify to move the active session to this device_id
        const token = localStorage.getItem('access_token');
        const res = await safeSpotifyFetch(`https://api.spotify.com/v1/me/player`, {
            method: 'PUT',
            body: JSON.stringify({ device_ids: [device_id], play: true }),
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
        player.connect().then(success => {
            if (success) {
                console.warn("Connection request sent to Spotify!");
            } else {
                console.error("Connection failed. Check your Premium status.");
            }
        });
        showResult("Mixer resumed on this phone.");
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

let isSoftLocked = false;
let loggingLocked = false;
let isSoftLockedISRC = false
let rateLimitStrikes = 0;
let rateLimitStrikesISRC = 0;

const MAX_STRIKES = 3; // 3 strikes and you're out (Emergency Stop)

async function safeSpotifyFetch(url, options) {
            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetch - CALL`, {
                step: "safeSpotifyFetch",
                error: "SAFESPOTIFYFETCH_CALL",
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
            // SEND THE LOG
            logEvent("TRACE", `safeSpotifyFetch - CALL_TOTAL`, {
                step: "safeSpotifyFetch",
                error: "SAFESPOTIFYFETCH_CALL_TOTAL",
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });
    if (apiCallCounter > MAX_CALLS_PER_MINUTE) {
        showResult("Slow down! Too many requests.");
        console.warn("Slow down! Too many requests.");
        console.warn("safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("WARN", `safeSpotifyFetch - MAX_CALLS_PER_MINUTE - Slow down! Too many requests`, {
                step: "safeSpotifyFetch",
                error: "MAX_CALLS_PER_MINUTE",
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
                strikeCount: rateLimitStrikes,
                endpoint: url,
                activeMix: activeMixId
            });

        return "SOFT_LOCKED";
    }

    const res = await fetch(url, options);
    
    if (res.status === 429) {
        rateLimitStrikes++;
        // Soft Lock Logic
        isSoftLocked = true;

        // The primary reason response.headers.get("Retry-After") fails in a browser context is that Spotify's API does not currently include Access-Control-Expose-Headers: Retry-After in its response. 
        let retryAfter = res.headers.get("Retry-After") || 5;
        
        // Calculate delay: 2^attempt * 1000ms (1s, 2s, 4s, 8s...)
        // Add 'jitter' (randomness) to prevent synchronized retries
        retryAfter = (Math.pow(2, attempt) + Math.random()) * 10; // 10s, 20s, 40s, 80s

        showResult(`Rate limited. Waiting ${retryAfter}s...`);
        console.warn(`Rate limited. Waiting ${retryAfter}s...`);
        showResult(`Rate limit hit (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`);
        console.warn(`Rate limit hit (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`);
        // You MUST wait this long before trying again
        
        if (rateLimitStrikes >= MAX_STRIKES) {
            showResult("CRITICAL: Repeated rate limits. Hard-resetting mixer.");
            console.warn("CRITICAL: Repeated rate limits. Hard-resetting mixer.");
            emergencyStop(); // Kill everything
            rateLimitStrikes = 0; // Reset for next Power On
            isSoftLocked = false;
            console.log("Soft Lock lifted.");

            // SEND THE LOG
            logEvent("ERROR", `safeSpotifyFetch - CRITICAL: Repeated rate limits. Hard-resetting mixer. (Strike ${rateLimitStrikesISRC}). Pausing ${retryAfter}s...`, {
                step: "safeSpotifyFetch",
                error: "429_MAX_STRIKES",
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
            showResult("Soft Lock lifted.");
            console.log("Soft Lock lifted.");
            // If we go 2 minutes without another 429, clear a strike
            setTimeout(() => { if(rateLimitStrikes > 0) rateLimitStrikes--; }, 120000);
        }, retryAfter * 1000);
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
            logEvent("ERROR", `safeSpotifyFetch - Rate limit hit (Strike ${rateLimitStrikesISRC}). Pausing ${retryAfter}s...`, {
                step: "safeSpotifyFetch",
                error: "429_STRIKE",
                strikeCount: rateLimitStrikes,
                endpoint: url,
                calculatedWaitSeconds: retryAfter,
                activeMix: activeMixId
            });

        return "429_STRIKE";
    }
    if (res.status === 401) { //Handle expired token
        console.warn("🔐 401 detected: Token expired. Refreshing now...");

        // If your enqueuing logic hits a 401/429 while the screen is locked, 
        // your "Exponential Backoff" might be keeping the CPU awake too long, which triggers the OS "Auto-Kill."
        // It is better to have the music stay paused than to have the whole app crash and reload.
        // if (document.visibilityState === 'hidden') { console.log('Silent fail'); return; }

        // Wait for the refresh to complete
        await refreshAccessToken();
        
        //if (success) {
            // Update the Authorization header with the fresh token
            const newToken = localStorage.getItem('access_token');
            options.headers = {
                ...options.headers,
                'Authorization': `Bearer ${newToken}`
            };
            
            // Retry the EXACT same request one more time
            console.log("🔄 Retrying original request with new token...");
            return safeSpotifyFetch(url, options);
        // } else {
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
            showResult("Soft Lock lifted.");
            console.log("Soft Lock lifted.");
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

    return multipliers[division];
}

//DELETED THESE
//loadAppState()
//setSelectionMode(selectionMode)

//renderMixSelector()
//renderPlaylists() //called in setSelectionMode initial above

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
        showResult("pickRandomTrackInfo")
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

    if(mode === "normal"){
        playlists.forEach(p => {
            if(p.enabled) p.sliderValue = 50
        })
        showResult("Normal mode enabled")
    }
    if(mode === "percentage"){
        normalizePercentagesAfterToggle()
    }
        playlists.forEach((p, index) => {
            setTimeout(() => {
        //        refreshPlaylistCount(p.id, index);
            }, 2000 * index);
        })
    saveAppState()
    renderPlaylists()
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

function rebalancePercentagesByIndex(activeIndex){
try{

    const debug = false

    if(debug) showResult(`Rebalancing ${Date.now().toString()}`)
    const enabled = playlists
        .map((p, i) => ({p, i}))
        .filter(x => x.p.enabled)
    //const enabled = Array.from(document.querySelectorAll('.playlist-row')).filter((row, rowindex) => row.querySelector('.playlist-enabled').checked).map(row => row.querySelector('.playlist-slider'))

    if(enabled.length === 0) return

    //only one enabled playlist - 100
    if(enabled.length === 1){
        playlists[enabled[0].i].sliderValue = 100;
        return;
    }
        showResult(`Rebalancing Enabled ${enabled.length}`)


    const active = playlists[activeIndex]
    const activeValue = Math.max(0, Math.min(100, active.sliderValue ?? 0))
    active.sliderValue = activeValue
    if(debug) console.log(`\nRebalancing activeValue ${active.sliderValue}`)


    const remaining = 100 - activeValue
    let runningTotal = 0

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
            let newValue
            if(currentSum === 0){
                //even split fallback
                newValue = remaining / sliders.length
            }
            else{
                newValue = (Number(slider.value) / currentSum) * remaining
            }

            if(i === sliders.length -1){
                //absorb rounding error
                newValue = remaining - runningTotal
            }
        const roundedValue = Math.max(0, Math.round(newValue))
        slider.value = roundedValue
        const playlistIndex = Number(slider.dataset.index)
        playlists[playlistIndex].sliderValue = roundedValue
        if(debug) console.log(`slider ${playlistIndex} value ${slider.value}`)
        runningTotal += roundedValue
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
    const sliders = Array.from(document.querySelectorAll('.playlist-row')).filter(row => row.querySelector('.playlist-enabled').checked).map(row => row.querySelector('.playlist-slider'))

    if(sliders.length === 0) return

    const equal = Math.floor(100 / sliders.length)
    let remaining = 100

    sliders.forEach((slider, i) => {
        slider.value = (i === sliders.length - 1) ? remaining : equal
        const playlistIndex = Number(slider.dataset.index)
        playlists[playlistIndex].sliderValue = slider.value
        remaining -= slider.value
        updateSliderDisplay(slider)
    })

}

function syncSlidersFromState(){

    const debug = true
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
    const total = activePlaylists.reduce((sum, p) => sum + (p.sliderValue ?? 0), 0)

    // If total is 0, fallback to pickUniformly instead of returning null
    if(total === 0) return pickUniformly(activePlaylists)

    let r = Math.random() * total

    for(const playlist of activePlaylists){
        r -= playlist.sliderValue
        if(r <= 0) return playlist
    }

    return activePlaylists[0] //Final safety fallback
}

function pickByWeightAlgorithm(activePlaylists){
    const weightedCounts = activePlaylists.map(p => p.trackCount * getWeight(p.sliderValue ?? 50, p))

    const total = weightedCounts.reduce((s, v) => s + v, 0)
    if(total <= 0) return null

    let r = Math.random() * total

    for(let i = 0; i < activePlaylists.length; i++){
        r -= weightedCounts[i]
        if(r <= 0) return activePlaylists[i]
    }

    return null
}


async function pickRandomSong(attempt = 0) {


    if (!player){
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - Error: PLAYER_NOT_POWERED_ON`, {
                step: "pickRandomSong",
                error: `PLAYER_NOT_POWERED_ON`,
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
        } else {
        // SEND THE LOG
        logEvent("ERROR", `pickRandomSong - Error: PLAYER_CONNECTION_FAIL`, {
            step: "pickRandomSong",
            error: `PLAYER_CONNECTION_FAIL`,
            strikeCount: rateLimitStrikes,
            activeMix: activeMixId
        });
            console.error("Connection failed. Check your Premium status.");
        }
    });

    lastPickTime = Date.now(); // Update timestamp whenever a pick is made (manual or auto)
    const activePlaylists = playlists.filter(p => p.enabled)

    // Safety: Don't get stuck in an infinite loop if a playlist is 100% unplayable
    if (attempt > 5) {
        showResult("Error: Hit too many restricted tracks. Try a different playlist.");
        console.log("Error: Hit too many restricted tracks. Try a different playlist.");
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - Error: Hit too many restricted tracks. Try a different playlist.`, {
                step: "pickRandomSong",
                error: `RESTRICTED_TRACKS_LIMIT`,
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
        showResult(`--------------- Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`)        
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
    refreshPlaylistCount(chosenplaylist.id, playlistIndex);
    const track = await getTrackAtIndex(token, chosenplaylist.id, index)
    
    if (track === "NETWORK_ERROR"){
        console.log("pickRandomSong - getTrackAtIndex - NETWORK_ERROR, stopping loop")
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong - getTrackAtIndex - NETWORK_ERROR, stopping loop`, {
                step: "pickRandomSong",
                error: `NETWORK_ERROR`,
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
            return "PICKRANDOMSONG_ERROR"; // Don't even attempt a retry loop
        }
        // ... normal restricted track retry logic ...
    }

    // Safety check: only call playTrack if we actually got a track back
    if (track && track.uri) {
        console.log("Playing:", track.name);
        showResult(`Now Playing: ${track.name} by ${track.artists[0].name} - ${chosenplaylist.name}`);
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

        queuePlaylistsMap.set(trackISRC, { name: chosenplaylist.name });

        const playTrackReturn = await playTrack(track.uri, false); //retry false
            
        if(playTrackReturn !== "SUCCESS"){
            console.warn("pickRandomSong playTrack - safeSpotifyFetch - FAIL:", playTrackReturn)
            // SEND THE LOG
            logEvent("ERROR", `pickRandomSong playTrack - safeSpotifyFetch - FAIL: ${playTrackReturn}`, {
                step: "pickRandomSong",
                error: `PICKRANDOM_PLAYTRACK_FAIL`,
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
                artist: `${track.artists[0].name} ${chosenplaylist.name}`,
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

        queuePlaylistsMap.set(lastTrackId, { name: chosenplaylist.name });


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

    showResult(`Generated ${selections.length} tracks`)

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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });

                if (res && typeof res.text === 'function') {
                const text = await res.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                
            throw new Error(errorData?.error?.message || "Forbidden or Not Found");
                }
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
        } else {
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        // If it's a network error, don't just return null, throw it!
        if (err.message.includes('Failed to fetch') || !navigator.onLine) {
            showResult("Network disconnected. Please check your internet.");
            // SEND THE LOG
            logEvent("ERROR", `getTrackAtIndex - safeSpotifyFetch - NETWORK_ERROR - Network disconnected. Please check your internet.`, {
                step: "getTrackAtIndex",
                error: `NETWORK_ERROR`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
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
                            device_id: device_id,
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
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
    }
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
  
    playlists.forEach((playlist, index) => {

        // When loading or adding a playlist
        playlist.pickCount = playlist.pickCount || 0;
        
        playlist._renderColor = getPlaylistColorByIndex(index)
        
        const div = document.createElement("div")
        div.className = "playlist-row"
        div.draggable = true; //enable dragging
        div.dataset.index = index; // store the original position


        //Add styling for the "drag handle" look
        div.style.padding = "8px";
        div.style.borderBottom = "1px solid #282828";
        div.style.cursor = "grab";

        const color = getRainbowColor(playlist.pickCount , minCount, maxCount);


        div.innerHTML = `
                <span style="color: #535353; margin-right: 10px;">☰</span>
                <input type="checkbox" class="playlist-enabled" ${playlist.enabled ? "checked" : ""}>
                <input type="range" min="0" max="100" value="${playlist.sliderValue ?? 50}" class="playlist-slider" data-index="${index}">
                <span class="slider-value"></span>
                <button class="delete-btn">Delete</button>
                <span class="pick-counter" style="padding: 2px;background: #1a1a1a; color: ${color}; font-weight: bold;">
                    ${playlist.pickCount }
                </span>                
                ${playlist.name} (${playlist.trackCount}) songs
        `
        // div.innerHTML = `
        //         <input type="checkbox" class="playlist-enabled" ${playlist.enabled ? "checked" : ""}>
        //         <input type="range" min="0" max="100" value="${playlist.sliderValue ?? 50}" class="playlist-slider" data-index="${index}">
        //         <span class="slider-value"></span>
        //         <button class="delete-btn">Delete</button>
        //         ${playlist.name} (${playlist.trackCount}) songs
        // `

        // --- ATTACH DRAG EVENTS ---
        div.addEventListener('dragstart', handleDragStart);
        div.addEventListener('dragover', handleDragOver);
        div.addEventListener('drop', handleDrop);
        div.addEventListener('dragend', handleDragEnd);
        // Add this to your event listeners in the loop:
        div.addEventListener('dragenter', (e) => e.preventDefault());

        const checkBox = div.querySelector("input[type='checkbox']")
        const slider = div.querySelector(".playlist-slider")
        //disable slider when in balanced mode
        const sliderDisabled = selectionMode === "balanced"
        slider.disabled = sliderDisabled || !playlist.enabled
        slider.style.opacity = slider.disabled ? 0.4 : 1
        slider.style.pointerEvents = sliderDisabled ? "none" : "auto"
        
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
                showResult(`normalize ${Date.now().toString()}`)
            }

            saveAppState()
            renderPlaylists()
        }

        // Slider change
        //slider.oninput = () => {
        slider.addEventListener("input", () => {


            if(isProgrammaticSliderUpdate) return

            playlist.sliderValue = Number(slider.value)
            display.textContent = slider.value

            //If in normal mode, moving slider switches to slider mode
            if((selectionMode === "normal") || (selectionMode === "balanced")){
                selectionMode = "percentage"
                setSelectionMode(selectionMode)

                //update radio button
                //document.querySelector('input[value="percentage"]').checked = true
                //normalizePercentagesAfterToggle() //REMOVED - This will snap values back instead of using the user's slider value
                showResult("Percentage mode enabled")
            }

            if(selectionMode === "percentage"){
                rebalancePercentagesByIndex(index)
                syncSlidersFromState()
                updateSliderDisplay(slider)
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
}

//Save playlists array to localStorage
//No longer used
function savePlaylists(){
    localStorage.setItem('playlists', JSON.stringify(playlists))
}


document.getElementById('add-playlist').onclick = async () => {
    const input = document.getElementById('new-playlist-name').value.trim();
    let playlistData;

    // Robust Spotify ID extraction using Regex
    const spotifyIdRegex = /(?:playlist[:\/])([a-zA-Z0-9]{22})/;
    const match = input.match(spotifyIdRegex);

    if (match && match[1]) {
        const id = match[1]; // match[1] is the captured 22-character ID
        showResult(`Fetching Spotify data... ${id}`);
        playlistData = await getSpotifyPlaylistData(id);
    } else if (input.length === 22 && !input.includes(' ')) {
        // Fallback: If they just paste the raw 22-character ID
        showResult(`Fetching Spotify data... ${input}`);
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
    
    showResult(`Deleted mix: ${mixName}`);
    console.log(`Deleted mix: ${mixName}`);
}

function generateShareLink() {
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
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
        showResult("Mix Code copied! Paste this on your other device.");
        alert("Mix Code copied! Paste this on your other device.");
    }).catch(err => {
                        // SEND THE LOG
                        logEvent("ERROR", `generateShareLink | Mix copy failed: ${err}`, {
                            step: "generateShareLink",
                            error: "GENERATE_SHARE_LINK_FAIL",
                            error_message: err,
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
        console.error("Mix copy failed:", err);
        alert("Mix Copy failed.");
    });
}

async function importMix() {
    try {
        // Request text from the system clipboard
        const text = await navigator.clipboard.readText();
        if (!text) {
            showResult("📋 Clipboard is empty.");
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
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
        alert("Mix imported successfully! Refreshing...");
        showResult(`Imported Mix: ${sharedMix.name}`);
        console.log(`Imported Mix: ${sharedMix.name}`);
        //window.location.reload();
    } catch (e) {
                        // SEND THE LOG
                        logEvent("ERROR", `importMix | Failed to import shared mix: ${e}`, {
                            step: "importMix",
                            error: "IMPORT_MIX_FAIL",
                            error_message: e,
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
            console.error("Failed to import shared mix:", e);
            showResult("Error: Invalid share link.");
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
        showResult(`await fetch(${url}` )
        let response = await safeSpotifyFetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if(response === "MAX_CALLS_PER_MINUTE"){
            console.warn("getSpotifyPlaylistData - safeSpotifyFetch - MAX_CALLS_PER_MINUTE")
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - safeSpotifyFetch - MAX_CALLS_PER_MINUTE`, {
                step: "getSpotifyPlaylistData",
                error: `MAX_CALLS_PER_MINUTE`,
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
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }

        if(!response.ok){
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - safeSpotifyFetch - BLOCKED`, {
                step: "getSpotifyPlaylistData",
                error: `GETPLAYLISTDATA_FETCH_BLOCKED`,
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

            namedata = await response.json();
            
            if (namedata.total !== undefined) {
                showResult(`Updated ${data.name} to ${namedata.total} songs.`);
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
        showResult("getSpotifyPlaylistData - Error: " + err.message);
            // SEND THE LOG
            logEvent("ERROR", `getSpotifyPlaylistData - ERROR - ${err.message}`, {
                step: "getSpotifyPlaylistData",
                error: `ERROR`,
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
    
    if(SessionPlaylistTrackCountUpdated[`${activeMixId}${playlistId}`]?.updated){
        console.log(`%c Playlist already updated: ${playlists[playlistIndex].name}`, "color: #ff0000;")
        return; //it's already been updated once this session.
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
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
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
                playlist: playlists[playlistIndex].name,
                playlist_id: playlistId,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                if (response && typeof response.text === 'function') {
                const text = await response.text(); // Get raw text first (never crashes)
                const errorData = text ? JSON.parse(text) : {}; // Only parse if text exists

                console.error(errorData?.error?.message || "Forbidden or Not Found");  
                
            throw new Error(errorData.error.message || "Forbidden or Not Found");
                }
        }
        const data = await response.json();
        
        if (data.total !== undefined) {
            playlists[playlistIndex].trackCount = data.total;
            saveAppState();
            renderPlaylists();
            console.log(`Updated ${playlists[playlistIndex].name} to ${data.total} songs.`);
            showResult(`Updated ${playlists[playlistIndex].name} to ${data.total} songs.`);
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
        selectionMode = mixes[activeMixId].selectionMode
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
    document.getElementById('play-pause-btn').textContent = paused ? "▶" : "⏸";

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


function showResult(text){
    document.getElementById("result").textContent = text
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
            console.warn("Screen Wake Lock is aquired and active");
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
// Re-request when the user comes back to the tab
document.addEventListener('visibilitychange', async () => {

    if (document.visibilityState === 'visible') {
        // 1. Manually pull the latest state from the SDK
        // This forces the SDK to talk to Spotify's servers and tell your app exactly where the song is,
        // which "wakes up" your progress bar.
        player.getCurrentState().then(state => {
        console.warn("App visibility changed - VISIBLE")
            // SEND THE LOG
            logEvent("DEBUG", `visibilitychange - App visibility changed: VISIBILE`, {
                step: "visibilitychange",
                error: `VISIBILITY_CHANGE_VISIBLE`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        if (!state){
            console.log("visibilitychange - 🔌 Player disconnected while away. Reconnecting...");
                logEvent("WARN", `visibilitychange - 🔌 Player disconnected while away. Reconnecting...`, {
                    step: "visibilitychange",
                    error: "VISIBILITY_CHANGE_PLAYER_DISCONNECTED_RECONNECT",
                    device_id: device_id,
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
            // Only reconnect if the state is gone
            player.connect().then(success => {
                if (success) {
                    console.warn("Connection request sent to Spotify!");
                // SEND THE LOG
                logEvent("WARN", `visibilitychange | Connection request sent to Spotify! SUCCESS`, {
                    step: "visibilitychange",
                    error: "VISIBILITY_CHANGE_PLAYER_CONNECTION_SUCCESS",
                    device_id: device_id,
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
                } else {
                    console.error("Connection failed. Check your Premium status.");
                // SEND THE LOG
                logEvent("ERROR", `visibilitychange | Connection request sent to Spotify! FAIL`, {
                    step: "ping_spotify_covisibilitychangennection",
                    error: "VISIBILITY_CHANGE_PLAYER_CONNECTION_FAIL",
                    device_id: device_id,
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });
                }
            });

        }
        
        // 2. Snap your UI elements to the current time/song
        updateUI(state);
        // Start the loop once
        requestAnimationFrame(updateProgressBar);

        console.log("👀 Welcome back! UI synced with player.");
        });
    }
    if (document.visibilityState === 'hidden') {
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




document.addEventListener("DOMContentLoaded", async () => {

    await fetchUserProfile()
    console.log(`DOM content loaded`)

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

    // 1. If we have a code BUT we already have a session, IGNORE the code.
    if (code && existingRefreshToken) {
        console.warn("Stale login code detected in URL, but we have a session. Cleaning URL...");
        window.history.replaceState({}, document.title, "/");
        // Proceed to refresh the existing session instead
        await refreshAccessToken();
    } 
    // 2. If it's a brand new login (Code present, No Refresh Token)
    else if(code) {
        console.warn("New login detected. Swapping code for token...");
            // SEND THE LOG
            logEvent("WARN", `New Login Detected - Swapping login code for token`, {
                step: "newlogin",
                error: `NEW_LOGIN_DETECTED`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        await getToken(code); // This saves the initial tokens
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
        await refreshAccessToken();

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
        await refreshAccessToken();
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
            showResult(`Imported Mix: ${sharedMix.name}`);
            console.log(`Imported Mix: ${sharedMix.name}`);
            // SEND THE LOG
            logEvent("WARN", `Imported Mix from URL: ${sharedMix.name}`, {
                step: "import_mix_url",
                error: `IMPORT_MIX_URL_SUCCESS`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        } catch (e) {
            console.error("Failed to import shared mix:", e);
            showResult("Error: Invalid share link.");
            // SEND THE LOG
            logEvent("WARN", `Failed to import shared mix: ${e}`, {
                step: "import_mix_url",
                error: `IMPORT_MIX_URL_FAIL`,
                error_message: e,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
        }
    }
    // --- END IMPORT LOGIC ---

    document.getElementById('login-button').onclick = redirectToSpotifyAuth


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


    const initBtn = document.getElementById('init-player');
    const playPauseBtn = document.getElementById('play-pause');

    let currentTrackId = null;
    let currentTrackIdISRC = null;
    let currentTrackIdChanging = false;

    let songStartTime = 0;

    if (initBtn) {
        initBtn.onclick = async () => {

            await requestWakeLock();

            // If already online, act as the Emergency Stop
            if (device_id) {
                emergencyStop();
                return;
            }

            await refreshAccessToken();

            //alert("CLICK DETECTED!"); // <--- ADD THIS TEMPORARILY
            const currentToken = localStorage.getItem('access_token');
            if (!currentToken) return alert("Please login to Spotify first!");

            console.warn("Button Clicked: Initializing Player...");

            player = new Spotify.Player({
                name: "Ben's Mixer Lab",
                getOAuthToken: cb => { 
                    // Always fetch from storage so it gets the refreshed one!
                    const token = localStorage.getItem('access_token');
                    cb(token); 
                },
                volume: 0.2
            });

            player.activateElement(); 

            if (!player) {
                console.error("Player not initialized yet. Wait for SDK.");
            // SEND THE LOG
            logEvent("ERROR", `PowerOn - Failed to initialize player`, {
                step: "PowerOn",
                error: `PLAYER_INIT_FAIL`,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                return;
            }

            // // Add this to your Power On click handler
            // const silencer = document.createElement('video');
            // silencer.src = "https://githubusercontent.com";
            // silencer.loop = true;
            // silencer.muted = true; // Muted video still counts as 'active' for the browser
            // silencer.play().catch(e => console.log("Silent video blocked until next click."));
            try {
                const video = document.createElement('video');
                
                // This is a 1-second, black, silent MP4 in Base64 format
                video.src = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAAAAGlzb21pc28yYXZjMQAAAAhmcmVlAAAAG21kYXTeBAAAbGlieDI2NCAtIGNvcmUgMTY0IAAAAApmoW9vcHMAAAAALW1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAABidHJrawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAIAAAACAAAAAABAAAAAAUlbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAABAAAAVVYfUAAAAAAAAMWhkbHIAAAAAAAAAAHZpZGVvAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAVxtaW5mAAAAFHZtYmhkAAAAAQAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASVzdGJsAAAAd3N0c2QAAAAAAAAAAQAAAGdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAgACABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAALmF2Y2MBQsAr/+EAFWfEArAtvA8AAAMAAQAAAwAyDxArpSABAAZIDpAgAAAAEHBhc3AAAAABAAAAAQAAABhzdHRzAAAAAAAAAAEAAAABAAAAQAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAAIAAAAAQAAABRzdGNvAAAAAAAAAAEAAAA0AAAAYXVkdGEAAABZTWV0YQAAAAAAAAAhSGRscgAAAAAAAAAAbWRpcgAAAAAAAAAAAAAAAAAAAAAALWlsc3QAAAApAKW5hbQAAACFEYXRhAFVudGl0bGVkIChIUCBNZWRpYSBTdHJlYW0pAAAAEGlkYXQAAAAAAAAAAQ==';
                
                video.loop = true;
                video.muted = true;
                video.setAttribute('playsinline', ''); // Essential for iOS/Android background play
                video.style.display = 'none'; // Keep it hidden from the UI
                
                document.body.appendChild(video);
                await video.play();
                console.log("🟢 Hidden Video Wake Lock (Base64) Active");
            } catch (err) {
                console.warn("🟡 Hidden Video Hack failed:", err);
            }

            // Since the video approach is being blocked, let's switch to the "Silent Audio Heartbeat" method. It's often more compatible with mobile Chrome because it uses the Web Audio API to generate a signal, which avoids codec errors entirely. 
            // The "Silent Audio Heartbeat" Strategy
            // This code creates a continuous, silent audio stream. Android Chrome will see this as "Active Media," making it much less likely to kill your tab when the screen is off. 
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
                error_message: err,
                strikeCount: rateLimitStrikes,
                activeMix: activeMixId
            });
                }
           // }

            
            // Alternative: Silent Audio Context
            // If your system is extremely restricted and blocks even large data URIs, you can use the Web Audio API to generate "silence." It’s less effective for keeping the screen on than video, but it’s great for preventing Chrome from suspending the "playback pipe".            
            //function startSilentAudio() {
                const context = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = context.createOscillator();
                const gainNode = context.createGain();

                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(440, context.currentTime); // Standard tone
                gainNode.gain.setValueAtTime(0, context.currentTime); // Volume = 0 (Silence)

                oscillator.connect(gainNode);
                gainNode.connect(context.destination);

                oscillator.start();
                console.warn("🔊 Silent Audio Context Active");
            //}

            // Ready
            player.addListener('ready', ({ device_id: id }) => {
                console.warn('Ready with Device ID', id);
                device_id = id;
                localStorage.setItem('last_active_device', id); // Keep a record
                initBtn.textContent = "Mixer Online 🟢";
                initBtn.style.background = "#1DB954";
                document.getElementById('init-player').textContent = "Mixer Online 🟢";
                document.getElementById('play-pause').style.display = "inline-block";

                // SEND THE LOG
                logEvent("WARN", `ready listener - device_id: ${device_id}`, {
                    step: "ready_listener",
                    error: "READY_LISTENER",
                    device_id: device_id,
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

            });

            // Add this listener to handle temporary drops
            player.addListener('not_ready', ({ device_id }) => {
                console.warn("Device has gone offline:", device_id);
                showResult("Connection lost. Trying to reconnect...");
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
                    device_id: device_id,
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

                resumeOnThisDevice();
            });

            player.addListener('autoplay_failed', () => {
                console.warn("AUTOPLAY BLOCKED: The browser stopped the next song from starting.");
                showResult("Browser blocked autoplay. Tap 'Play' to resume the mixer.");
                
                // SEND THE LOG
                logEvent("WARN", `autoplay_failed - AUTOPLAY BLOCKED: The browser stopped the next song from starting.`, {
                    step: "autoplay_failed",
                    error: "AUTOPLAY_FAILED",
                    device_id: device_id,
                    strikeCount: rateLimitStrikes,
                    activeMix: activeMixId
                });

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
                    showResult("Playback Engine Error. Please refresh the page.");
                } else {
                    // Handle other random init errors (like DRM issues)
                    showResult("Error starting player: " + message);
                    console.error("Error starting player: " + message);
                }
                // SEND THE LOG
                logEvent("ERROR", `initialization_error - Spotify SDK Initialization Error: ${message}`, {
                    step: "initialization_error",
                    error: "INITIALIZATION_ERROR",
                    error_message: message,
                    device_id: device_id,
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

                showResult("Session expired. Re-authenticating...");
                console.warn("Session expired. Re-authenticating...");
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
                        console.warn("Connection request sent to Spotify!");
                        showResult("Player reconnected");
                        // SEND THE LOG
                        logEvent("WARN", `authentication_error - SDK Authentication Error: ${message} | visibility: ${document.visibilityState} | Session expired. Re-authenticating... | Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds} | Connection request sent to Spotify! SUCCESS`, {
                            step: "authentication_error",
                            error: "AUTHENTICATION_ERROR_REAUTH_SUCCESS",
                            error_message: message,
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    } else {
                        console.error("Connection failed. Check your Premium status.");
                        showResult("Player reconnect failed");
                        // SEND THE LOG
                        logEvent("WARN", `authentication_error - SDK Authentication Error: ${message} | visibility: ${document.visibilityState} | Session expired. Re-authenticating... | Session Expire timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds} | Connection failed. Check your Premium status. FAIL`, {
                            step: "authentication_error",
                            error: "AUTHENTICATION_ERROR_REAUTH_FAIL",
                            error_message: message,
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    }
                });
                // showResult("Player reconnected");
                // console.warn("Player reconnected");
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
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    showResumeOverlay(true);
                } else if (state.is_active === false) {
                    console.warn("Mixer is no longer the active device.");
                        // SEND THE LOG
                        logEvent("INFO", `playback_hijacked - Mixer is no longer the active device.`, {
                            step: "playback_hijacked",
                            error: "PLAYBACK_HIJACKED_NOTACTIVE",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    showResumeOverlay(true);
                } else {
                    // If we are active again, hide the overlay
                    showResumeOverlay(false);
                }

                const playPauseBtn = document.getElementById('play-pause');
                if (playPauseBtn) {
                    if (state.paused) {
                        if (!userInitiatedPause) {
                            console.warn("Ghost pause detected! Forcing resume...");
                        // SEND THE LOG
                        logEvent("INFO", `ghost_pause - Ghost pause detected! Forcing resume...`, {
                            step: "ghost_pause",
                            error: "GHOST_PAUSE",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                            setTimeout(() => {
                                player.resume();
                            }, 1000);
                        }
                        // If music is paused, show "Play" button (Green)
                        playPauseBtn.textContent = "▶ Play";
                        playPauseBtn.style.background = "#1DB954"; // Spotify Green
                    } else {
                        // Reset the flag whenever the music is actually playing
                        userInitiatedPause = false;
                        // If music is playing, show "Pause" button (Orange/Red)
                        playPauseBtn.textContent = "⏸ Pause";
                        playPauseBtn.style.background = "#FF5722"; // Deep Orange
                    }
                }

                const now = Date.now()

                if(!current_track){
                    console.warn("player state changed but no currentTrack")
                    return;
                }

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

                        if(current_track.linked_from?.id){
                            console.warn(`linked_from.id ${current_track.linked_from?.id} ${lastTrackId}`);
                            console.warn("currentTrackIdISRC:", currentTrackIdISRC)
                            
                            console.log("Played ID:", current_track.id);
                            console.log("Original ID:", current_track.linked_from?.id);

                            currentTrackId = current_track.id //so we won't check ISRC more than once
                            currentTrackIdISRC = current_track.linked_from?.id
                            lastPickTime = Date.now() //reset timer for new song

                        } //endif
                        else{

                            currentTrackId = current_track.id //so we won't check ISRC more than once
                            currentTrackIdISRC = current_track.id //but this will be current instead of linked_from ()
                            lastPickTime = Date.now() //reset timer for new song
                            //return; //exit: we just started a song, don't pick a new one!
                            // Update your 'Now Playing' UI here if needed
                        }
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


                if (isAtEnd && hasPlayedEnough) {
                    console.log("Track naturally finished. Picking next...");

                    // If the song that just started is the one at the top of our queue, remove it
                    if (internalQueue.length > 0 && internalQueue[0].id === currentTrackIdISRC) {
                        internalQueue.shift(); 
                        renderQueue();
                    }

                    // Force a small interaction signal
                    player.getVolume().then(v => {
                        player.setVolume(v > 0.1 ? v - 0.05 : v + 0.05).then(() => {
                            player.setVolume(v); // Quickly set it back
                        });
                    });

                    // --- THE KEY FIX ---
                    // 1. Re-activate the element to satisfy autoplay rules
                    // Nudge the browser to keep the audio context alive
                    player.activateElement(); 
                    player.connect().then(success => {
                        if (success) {
                            console.warn("Connection request sent to Spotify!");
                        } else {
                        // SEND THE LOG
                        logEvent("ERROR", `player_state_changed - Track naturally finished - Error: PLAYER_CONNECTION_FAIL`, {
                            step: "player_state_changed",
                            error: `PLAYER_CONNECTION_FAIL`,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                            console.error("player_state_changed - Track naturally finished - Error: PLAYER_CONNECTION_FAIL. Check your Premium status.");
                        }
                    });
                    
                    // Small trick: Set volume to current level to trigger an 'interaction' event
                    player.getVolume().then(v => player.setVolume(v));
                    // 2. The "Nudge": Slightly change volume and back to trigger an interaction
                    player.getVolume().then(v => {
                        player.setVolume(v + 0.01).then(() => player.setVolume(v));
                    });

                    // 2. Explicitly resume the player so it's in a 'playing' state 
                    // before the new URI arrives
                    await player.resume(); 


                    lastPickTime = now; // Mark the time of this pick
                    // Clear the ID so the next track can be detected as a change
                    //currentTrackId = null; 
                    //player.activateElement(); 
                    //pickRandomSong();                     
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
                    console.log(`Now Playing: ${current_track.name} by ${current_track.artists[0].name} - ${queuePlaylistsMap.get(currentTrackIdISRC)?.name}`);
                    showResult(`Now Playing: ${current_track.name} by ${current_track.artists[0].name} - ${queuePlaylistsMap.get(currentTrackIdISRC)?.name}`);
                        // SEND THE LOG
                        logEvent("INFO", `now_playing - Now Playing: ${current_track.name} by ${current_track.artists[0].name} - ${queuePlaylistsMap.get(currentTrackIdISRC)?.name}`, {
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
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    
                    if(queuePlaylistsMap.get(currentTrackIdISRC)?.name === queuePlaylistsMap.get(lastTrackId)){
                        console.error(`%c Playlist names match. currentTrackIdISRC: ${currentTrackIdISRC} lastTrackId: ${lastTrackId}, "color: #ff00bf; background: #121212;"`)
                        // SEND THE LOG
                        logEvent("ERROR", `Playlist names match. currentTrackIdISRC: ${currentTrackIdISRC} lastTrackId: ${lastTrackId}`, {
                            step: "now_playing",
                            error: "NOW_PLAYING",
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
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    }

                    // --- ADD TO HISTORY ---
                    addToHistory(current_track, queuePlaylistsMap.get(currentTrackIdISRC)?.name);

                    // To keep the music playing when the screen goes off, Android requires a "Foreground Service." Browsers can't do this easily, but there is a hack: The Media Session API. If you "tell" Android that media is playing, it’s less likely to kill the tab.
                    // Add this whenever a song starts:
                    if ('mediaSession' in navigator) {
                        navigator.mediaSession.metadata = new MediaMetadata({
                            title: current_track.name,
                            artist: `${current_track.artists[0].name} ${queuePlaylistsMap.get(currentTrackIdISRC)?.name}`,
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


                    //player.activateElement(); 



                    // REFILL THE QUEUE: Now that we are on Song 2, queue up Song 3
                    // We wait 5 seconds to make sure the transition is stable
                    setTimeout(() => {
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
                document.getElementById('play-pause-btn').textContent = paused ? "▶" : "⏸";

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
            player.activateElement(); 
            player.connect().then(success => {
                if (success) {
                    console.warn("Connection request sent to Spotify!");
                        // SEND THE LOG
                        logEvent("WARN", `initial_player_connection | Connection request sent to Spotify! SUCCESS`, {
                            step: "initial_player_connection",
                            error: "INITIAL_PLAYER_CONNECTION_SUCCESS",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                } else {
                    console.error("Connection failed. Check your Premium status.");
                        // SEND THE LOG
                        logEvent("ERROR", `initial_player_connection | Connection request sent to Spotify! FAIL`, {
                            step: "initial_player_connection",
                            error: "INITIAL_PLAYER_CONNECTION_FAIL",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                }
            });

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
                            device_id: device_id,
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
                            console.warn("Connection request sent to Spotify!");
                        // SEND THE LOG
                        logEvent("WARN", `ping_spotify_connection | Connection request sent to Spotify! SUCCESS`, {
                            step: "ping_spotify_connection",
                            error: "PING_SPOTIFY_CONNECTION_SUCCESS",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                        } else {
                            console.error("Connection failed. Check your Premium status.");
                        // SEND THE LOG
                        logEvent("ERROR", `ping_spotify_connection | Connection request sent to Spotify! FAIL`, {
                            step: "ping_spotify_connection",
                            error: "PING_SPOTIFY_CONNECTION_FAIL",
                            device_id: device_id,
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
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    //pickRandomSong(); 
                    player.nextTrack();
                });

                // When the user hits "Pause"
                navigator.mediaSession.setActionHandler('pause', () => {
                        // SEND THE LOG
                        logEvent("INFO", `mediaSession_pause | Paused playback`, {
                            step: "mediaSession_pause",
                            error: "MEDIA_SESSION_PAUSE",
                            pause: "PAUSE",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    userInitiatedPause = true;
                    if (player) player.pause();
                    navigator.mediaSession.playbackState = "paused";
                });

                // When the user hits "Play"
                navigator.mediaSession.setActionHandler('play', () => {
                        // SEND THE LOG
                        logEvent("INFO", `mediaSession_play | Resumed playback`, {
                            step: "mediaSession_play",
                            error: "MEDIA_SESSION_PLAY",
                            play: "PLAY",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                    if (player) player.resume();
                    navigator.mediaSession.playbackState = "playing";
                });
            }

        };
    }

    if (playPauseBtn) {
        playPauseBtn.onclick = async () => {
            if (!player){
                alert("Turn player on first")
                return;
            }

            // Get the current state to see if a song is already loaded
            const state = await player.getCurrentState();

            if (!state) {
                // CASE 1: No song is loaded/playing yet
                console.log("No track detected. Starting first pick...");
                showResult("Initializing first mix...");
                const returnPickRandom = await pickRandomSong(); 

                if(returnPickRandom !== "SUCCESS"){
                    console.warn("playPauseBtn - pickRandomSong - FAIL:", returnPickRandom)
                }

                    setTimeout(() => {
                        prepareNextQueueItem();
                    }, 15000);

                    setTimeout(() => {
                        prepareNextQueueItem();
                    }, 30000);

                    setTimeout(() => {
                        prepareNextQueueItem();
                    }, 45000);

            } else {
                userInitiatedPause = true; 
                // CASE 2: A song exists, so just toggle play/pause
                player.togglePlay().then(() => {
                    console.log('Toggled playback');
                        logEvent("INFO", `playPauseBtn_main | Toggled playback`, {
                            step: "playPauseBtn_main",
                            error: "PLAY_PAUSE_BTN_MAIN",
                            pause: "PAUSE",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
                });
            }
        }
    }


    // --- INITIALIZE DATA AND UI HERE ---
    loadAppState();

    renderStoredMixes(); 


    // renderMixSelector()  
    // renderPlaylists()          
    setSelectionMode(selectionMode); 
    //document.querySelector(`input[name="selectionMode"][value="${selectionMode}"]`).checked = true;

    if(!activeMixId){
        createDefaultMix();
    }
    
    renderMixSelector();
    // -----------------------------------
    
    //document.getElementById("balance-playlists").onclick = toggleSelectionMode
    document.querySelectorAll('input[name="selectionMode"]').forEach(radio => {
        radio.addEventListener("change", e => {
            setSelectionMode(e.target.value)
        })
    })

    document.getElementById('pick').onclick = pickRandomSong
    // document.getElementById('pick').onclick = () => {
    //     alert ("button clicked")
    // }

    document.getElementById('skip-button').onclick = () => {
        if (player) {
            player.nextTrack().then(() => {
                console.log('Skipped to the next track!');
                        // SEND THE LOG
                        logEvent("INFO", `internal_skip_button | Skipped to the next track!`, {
                            step: "internal_skip_button",
                            error: "INTERNAL_SKIP_BUTTON",
                            skip: "SKIP",
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
            }).catch(err => {
                console.error('Skip failed:', err);
                        // SEND THE LOG
                        logEvent("ERROR", `internal_skip_button | Skip failed: ${err}`, {
                            step: "internal_skip_button",
                            error: "INTERNAL_SKIP_BUTTON_ERROR",
                            error_message: err,
                            device_id: device_id,
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
            showResult(`Manual Play: ${uri}`);
            
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
        //Force a save and a small wait to ensure all rebalancing math is finished
        isProgrammaticSliderUpdate = false; //emergency reset
        saveAppState() //Force current UI values into the logic state
        await new Promise(r => setTimeout(r, 50)) //Tiny delay for rebalance stability
        generateRandomPlaylist()

        //re-sync the UI one last time after generation
        syncSlidersFromState();
    }

    document.getElementById("save-mix").onclick = () => {
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
                            device_id: device_id,
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
                            device_id: device_id,
                            strikeCount: rateLimitStrikes,
                            activeMix: activeMixId
                        });
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
            console.log("Button clicked! Performing JS code...");

            const list = document.getElementById('playlist-list');
            const btn = this;

            if (list.style.maxHeight === "200px" || list.style.maxHeight === "") {
                // EXPAND
                //max-height vs height: Using max-height: 1000px (or none) allows the box to grow only as large as the content inside it.
                list.style.maxHeight = "10000px"; // Set to a height larger than your list
                list.style.overflowY = "visible";
                btn.textContent = "▲ Show Less";
            } else {
                // COLLAPSE
                list.style.maxHeight = "200px";
                list.style.overflowY = "auto";
                btn.textContent = "▼ Show All";
            }
        });
    });

    document.getElementById('toggle-list-btn-mix').onclick = function() {
        const list = document.getElementById('stored-mixes-list');
        const btn = this;

        if (list.style.maxHeight === "50px" || list.style.maxHeight === "") {
            // EXPAND
            //max-height vs height: Using max-height: 1000px (or none) allows the box to grow only as large as the content inside it.
            list.style.maxHeight = "3000px"; // Set to a height larger than your list
            list.style.overflowY = "visible";
            btn.textContent = "▲ Show Less";
        } else {
            // COLLAPSE
            list.style.maxHeight = "50px";
            list.style.overflowY = "auto";
            btn.textContent = "▼ Show All";
        }
    };

})

// Register Service Worker after the page has fully loaded
window.addEventListener('load', () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('Service Worker: Registered (Scope: ' + reg.scope + ')'))
            .catch(err => console.error('Service Worker: Error', err));
    }
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

// 1. Detect when the connection is LOST
window.addEventListener('offline', () => {
    console.log("🚀 Internet connection lost.");
    
    // Store the "down time" locally since we can't fetch right now
    localStorage.setItem('last_offline_time', Date.now());
                // SEND THE LOG
                logEvent("WARN", `offline_listener - 🚀 Internet connection lost.`, {
                    step: "offline_listener",
                    error: "OFFLINE_LISTENER",
                    device_id: device_id,
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
    console.log("🌐 Internet connection restored. Reconnecting... | offlineDurationSeconds: ${durationSeconds}");
                // SEND THE LOG
                logEvent("WARN", `online_listener - 🌐 Internet connection restored. Reconnecting... | offlineDurationSeconds: ${durationSeconds}`, {
                    step: "online_listener",
                    error: "ONLINE_LISTENER",
                    offlineDurationSeconds: durationSeconds,
                    device_id: device_id,
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
                                    device_id: device_id,
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
