//alert("app.js loaded")

let player;
let device_id;
let lastPickTime = 0;

window.onSpotifyWebPlaybackSDKReady = () => {
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


async function playTrack(trackUri, isRetry = false) {
    const token = localStorage.getItem('access_token');
    if (!device_id) return alert("Click 'Power On' first!");

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

        if (response.status === 404) {
            console.warn("Device ID not found. Attempting to refresh device list...");
            showResult("Re-syncing with Spotify...");

            // Check if the token is likely the problem
            const expiry = localStorage.getItem('token_expiry');
            if (Date.now() > expiry) {
                showResult("Session expired. Refreshing...");
                console.warn("Session expired. Refreshing...");
                await refreshAccessToken();
            }

            if(!isRetry){

                // Logic to re-fetch devices or re-initialize player
                // 1. Tell the SDK to re-announce itself to Spotify
                await player.connect();
                
                // 2. Wait a split second for the 'ready' event to update the device_id
                setTimeout(() => {
                    console.warn("Retrying playback with refreshed device...");
                    playTrack(trackUri, true); // retry = true to prevent infinite loops
                }, 1000);
            } else {
                console.warn("404 persisted after retry. Stopping loop.");
                showResult("Connection lost. Please Power Off and On again.");
                // EXIT HERE. No more setTimeouts.
            }            
            return;
        }

        if (response.status === 403) {
            console.warn("403: Song restricted. Skipping to a new one...");
            showResult("Song restricted by Spotify. Picking another...");
            //alert("Spotify Premium is required for this feature.");
            // AUTO-RECOVERY: Just trigger a new pick!
            safeTimeout(() => pickRandomSong(), 500); 
        } else if (response.status === 204) {
            // Wait 300ms for Spotify's servers to process the change, 
            // then force the local player to start.
            safeTimeout(async () => {
                if (player){
                    await player.resume().then(() => {
                        console.log("Local player resumed after URI injection");
                    }).catch(err => {
                        // If this fails, the browser is likely blocking autoplay
                        console.error("Autoplay blocked by browser. Manual click required.", err);
                    });

                    //player.togglePlay();

                }
            }, 1000);

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

            // To keep the music playing when the screen goes off, Android requires a "Foreground Service." Browsers can't do this easily, but there is a hack: The Media Session API. If you "tell" Android that media is playing, it’s less likely to kill the tab.
            // Add this whenever a song starts:
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track.name,
                    artist: track.artists[0].name,
                    album: chosenplaylist.name,
                    artwork: [{ src: track.album.images[0].url }]
                });

                // Update the playback state so the play/pause button looks right
                navigator.mediaSession.playbackState = "playing";
            }

        }
    } catch (err) {
        console.error("Playback error:", err);
    }
}

function addToHistory(track, playlistName) {
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

    // Keep only the last 10 entries
    if (historyList.children.length > 10) {
        historyList.removeChild(historyList.lastChild);
    }
}


//To securely integrate your app, you should use the Authorization Code Flow with PKCE. This is the modern standard for client-side apps that cannot hide a "Client Secret".
// --- AUTHENTICATION CONFIG ---
//const clientId = 'YOUR_SPOTIFY_CLIENT_ID'; // Replace with your actual Client ID
const clientId = '3bb9a06bf9a24bc09260891c9d153abd'; // Replace with your actual Client ID
//const redirectUri = 'http://127.0.0.1:8000/'; // Must match your Dashboard EXACTLY
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
    const data = await response.json();

        if (response.ok) {
            window.localStorage.setItem('access_token', data.access_token);
            // Clean the URL so the code isn't reused on refresh
            window.history.replaceState({}, document.title, "/");
        } else {
            // Log the actual error message from Spotify (e.g., "invalid_grant")
            console.error("Token Error:", data.error, data.error_description);
        }
        if (data.access_token) {
            window.localStorage.setItem('access_token', data.access_token);
            
            // --- ADD THIS LINE ---
            // Record exactly when this token will die (current time + 3600 seconds)
            const expiryTime = Date.now() + (3600 * 1000); 
            window.localStorage.setItem('token_expiry', expiryTime);            

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

async function refreshAccessToken() {
    
    const refreshToken = localStorage.getItem('refresh_token');
    
    // CHANGE THIS:
    if (!refreshToken) {
        console.warn("No refresh token found. User needs to log in manually.");
        alert("No refresh token found. User needs to log in manually.");
        // Change button text to show user is logged in
        document.getElementById('login-button').textContent = "Login with Spotify";
        document.getElementById('login-button').disabled = false;
        document.getElementById('login-button').style.background = "#ff0000";
        // REMOVE THIS: redirectToSpotifyAuth();
        // The Issue: When Chrome Android "hiccups" or puts a tab to sleep, it can sometimes lose access to the in-memory state. If your refreshAccessToken triggers before the storage is ready, it returns null.
        // The Fix: You must ensure refresh_token is explicitly pulled from localStorage every single time, and add a "Guard" to your refreshAccessToken so it doesn't redirect to login just because of a temporary glitch.        
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
        const data = await response.json();

        if (data.access_token) {
            localStorage.setItem('access_token', data.access_token);
            
            // --- ADD THIS LINE ---
            // Record exactly when this token will die (current time + 3600 seconds)
            const expiryTime = Date.now() + (3600 * 1000); 
            localStorage.setItem('token_expiry', expiryTime);            if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);

            console.warn("Token Refreshed Successfully!");

            // Change button text to show user is logged in
            document.getElementById('login-button').textContent = "Logged In";
            document.getElementById('login-button').disabled = false;
            document.getElementById('login-button').style.background = "#1DB954";
        }
    } catch (err) {
        console.error("Refresh failed, but staying on page:", err);
        // Don't redirect here! Just let the user click 'Login' manually if they need to.
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        showResult("Session expired. Please log in again.");
        
        // Change button text to show user is logged in
        document.getElementById('login-button').textContent = "Login with Spotify";
        document.getElementById('login-button').disabled = false;
        document.getElementById('login-button').style.background = "#ff0000";
    }
}

async function resumeOnThisDevice() {
    console.warn("Attempting to reclaim playback session...");
    
    try {
        // 1. Re-prime the browser's audio (Required for mobile)
        await player.activateElement();
        
        // 2. Tell Spotify to move the active session to this device_id
        const token = localStorage.getItem('access_token');
        await safeSpotifyFetch(`https://api.spotify.com/v1/me/player`, {
            method: 'PUT',
            body: JSON.stringify({ device_ids: [device_id], play: true }),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        
        showResumeOverlay(false);
        showResult("Mixer resumed on this phone.");
        console.warn("Mixer resumed on this phone.");
    } catch (err) {
        console.error("Failed to resume session:", err);
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
    const data = await response.json();
    localStorage.setItem('spotify_user_id', data.id);
    return data.id;
}

let apiCallCounter = 0;
const MAX_CALLS_PER_MINUTE = 30; // Safe threshold for Dev Mode

let isSoftLocked = false;
let rateLimitStrikes = 0;
const MAX_STRIKES = 3; // 3 strikes and you're out (Emergency Stop)

async function safeSpotifyFetch(url, options) {
    if (apiCallCounter > MAX_CALLS_PER_MINUTE) {
        showResult("Slow down! Too many requests.");
        console.warn("Slow down! Too many requests.");
        return null;
    }
    
    apiCallCounter++;
    safeTimeout(() => apiCallCounter--, 60000); // Reset count after 1 min

    if (isSoftLocked) {
        console.warn("Fetch blocked: Soft Lock active.");
        return null;
    }

    const res = await fetch(url, options);
    
    if (res.status === 429) {
        rateLimitStrikes++;
        // Soft Lock Logic
        isSoftLocked = true;
        const retryAfter = res.headers.get("Retry-After") || 5;
        showResult(`Rate limited. Waiting ${retryAfter}s...`);
        console.warn(`Rate limited. Waiting ${retryAfter}s...`);
        showResult(`Rate limit hit (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`);
        console.warn(`Rate limit hit (Strike ${rateLimitStrikes}). Pausing ${retryAfter}s...`);
        // You MUST wait this long before trying again
        
        if (rateLimitStrikes >= MAX_STRIKES) {
            showResult("CRITICAL: Repeated rate limits. Hard-resetting mixer.");
            emergencyStop(); // Kill everything
            rateLimitStrikes = 0; // Reset for next Power On
            return null;
        }


        // Soft Lock: Just wait, don't kill the player
        setTimeout(() => {
            isSoftLocked = false;
            showResult("Soft Lock lifted.");
            console.log("Soft Lock lifted.");
            // If we go 2 minutes without another 429, clear a strike
            setTimeout(() => { if(rateLimitStrikes > 0) rateLimitStrikes--; }, 120000);
        }, wait * 1000);

        return null;
    }
    
    return res;
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
let selectionMode = "normal" // normal | balanced | percentage (mix) | relative (weight)
let isProgrammaticSliderUpdate = false //to prevent infinite loops when sliders rebalance

const multipliers = [0.25, 0.5, 0.75, 1.0, 1.25, 1.75, 2.5];

function getWeight(sliderValue, playlist) {

    if(sliderValue <= 0) return 0

    const divisions = multipliers.length;
    const divisionSize = 100 / divisions; // ~14.285
    let division = Math.floor((sliderValue - 1) / divisionSize); // subtract 1 to avoid 0 snapping
    if (division >= divisions) division = divisions - 1;

    return multipliers[division];
}

//Load playlists array from localStorage
//no longer used
function loadPlaylists(){
    const stored = localStorage.getItem('playlists')
    if(stored){playlists = JSON.parse(stored)}
}

//loadPlaylists() //no longer used

//DELETED THESE
//loadAppState()
//setSelectionMode(selectionMode)

//if(!activeMixId){
//    createDefaultMix()
//}

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
    selectionMode = mode

    if(mode === "normal"){
        playlists.forEach(p => {
            if(p.enabled) p.sliderValue = 50
        })
        showResult("Normal mode enabled")
    }
    if(mode === "percentage"){
        normalizePercentagesAfterToggle()
    }

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
    if(total == 0) return pickUniformly(activePlaylists)

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
    lastPickTime = Date.now(); // Update timestamp whenever a pick is made (manual or auto)
    const activePlaylists = playlists.filter(p => p.enabled)

    // Safety: Don't get stuck in an infinite loop if a playlist is 100% unplayable
    if (attempt > 5) {
        showResult("Error: Hit too many restricted tracks. Try a different playlist.");
        console.log("Error: Hit too many restricted tracks. Try a different playlist.");
        return;
    }

    if(activePlaylists.length === 0){
        alert("Select at least one playlist")
        return
    }

    let cumulative = 0
    let chosenplaylist, index


    chosenplaylist = pickPlaylistByMode()
    if (!chosenplaylist) {
        console.warn("No playlist selected for auto-pick.");
        return; // Don't alert here, just stop
    }
    index = Math.floor(Math.random() * chosenplaylist.trackCount) // uniform inside playlist
        showResult(`--------------- Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`)        
        console.log(`--------------- Playlist ${chosenplaylist.name} ${chosenplaylist.id}, song #${index + 1}`)

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
        console.log("pickRandomSong: NETWORK_ERROR, stopping loop")
        return; // Stop the loop immediately!
    }
    
    // 4. RATE LIMIT CHECK: Stop if safeSpotifyFetch triggered a 429
    if (track === "RATE_LIMIT_HIT") {
        console.log("pickRandomSong: RATE_LIMIT_HIT, stopping loop");
        return;
    }

    if (track === null) {
        if (isSoftLocked) {
            console.log("pickRandomSong: Mixer is soft-locked. Waiting for recovery...");
            return; // Don't even attempt a retry loop
        }
        // ... normal restricted track retry logic ...
    }

    // Safety check: only call playTrack if we actually got a track back
    if (track && track.uri) {
        console.log("Playing:", track.name);
        showResult(`Now Playing: ${track.name} by ${track.artists[0].name}`);
        
        // --- ADD TO HISTORY ---
        addToHistory(track, chosenplaylist.name);

        playTrack(track.uri, false); //retry false
    } else {
        console.log("Could not fetch that specific track. Try again!");
        // If track was null (failed safety checks), try again!
        console.log("Track was restricted or null. Retrying pick attempt " + (attempt + 1) + "...");
        safeTimeout(() => pickRandomSong(attempt + 1), 1000) //setTimeout ensures you never make more than one retry per second 
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
    console.log("getTrackAtIndex");
    const limit = 1
    const offset = Number(index)

    try{
        const res = await safeSpotifyFetch(

    `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}&market=from_token&additional_types=track`,
            {
                headers: { Authorization: `Bearer ${token}` }
            }
        )

        // --- THE RATE LIMIT CHECK ---
        if (res.status === 429) {
            const retryAfter = res.headers.get("Retry-After") || 5;
            console.error(`RATE LIMIT HIT: Spotify says wait ${retryAfter}s`);
            
            // This is the signal pickRandomSong is waiting for
            return "RATE_LIMIT_HIT"; 
        }

        if (!res.ok) return null;

        const data = await res.json()
//console.log("EXACT ITEM CONTENT:", JSON.stringify(data.items[0], null, 2));
        // 2026 Debug: Log the full structure if it's still empty
        if (!data.items || data.items.length === 0) {
            console.log("Empty items array. Full Response:", data);
            return null;
        }        
        
        console.log("Keys available in this object:", Object.keys(data.items));

        // Check if items exists and is not empty
        if (data.items && data.items.length > 0) {

            const container = data.items[0];
            
            // --- THE FIX ---
            // Based on your JSON, the data is inside 'item'
            const track = container.item || container.track; 
            
            if (track && track.uri) {
                console.log("Found Track:", track.name, "URI:", track.uri);
                console.log("Success! Found:", track.name, "by", track.artists[0].name);
            }

            // 1. Check if the track is playable in your region
            if (track.is_playable === false) {
                console.warn(`Skipping "${track.name}": Not playable in your region.`);
                return null;
            }

            // 2. Check for explicit content restrictions (if you want to avoid 403s on filtered accounts)
            if (track.explicit && localStorage.getItem('filter_explicit') === 'true') {
                console.warn(`Skipping "${track.name}": Explicit content filtered.`);
                return null;
            }

            // 3. Check for specific 'restrictions' (usually 'market' or 'product')
            if (track.restrictions) {
                console.warn(`Skipping "${track.name}": Restricted (${track.restrictions.reason}).`);
                return null;
            }

            // 4. Check for 'Local' files (Web SDK cannot stream these)
            if (track.is_local) {
                console.warn(`Skipping "${track.name}": Local file (cannot stream via SDK).`);
                return null;
            }

            return track; 
        } else {
            console.error("No track found at this index:", index);
            return null;
        }
    } catch(err){
        console.error("Fetch error in getTrackAtIndex:", err);
        // If it's a network error, don't just return null, throw it!
        if (err.message.includes('Failed to fetch') || !navigator.onLine) {
            showResult("Network disconnected. Please check your internet.");
            return "NETWORK_ERROR"; 
        }
        return null
    }
}


function renderPlaylists() {
    const container = document.getElementById("playlist-list")
    container.innerHTML = ""

    
    playlists.forEach((playlist, index) => {
        
        playlist._renderColor = getPlaylistColorByIndex(index)
        
        const div = document.createElement("div")
        div.className = "playlist-row"
        div.draggable = true; //enable dragging
        div.dataset.index = index; // store the original position


        //Add styling for the "drag handle" look
        div.style.padding = "8px";
        div.style.borderBottom = "1px solid #282828";
        div.style.cursor = "grab";

        div.innerHTML = `
                <span style="color: #535353; margin-right: 10px;">☰</span>
                <input type="checkbox" class="playlist-enabled" ${playlist.enabled ? "checked" : ""}>
                <input type="range" min="0" max="100" value="${playlist.sliderValue ?? 50}" class="playlist-slider" data-index="${index}">
                <span class="slider-value"></span>
                <button class="delete-btn">Delete</button>
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
            if(selectionMode === "normal"){
                selectionMode = "percentage"

                //update radio button
                document.querySelector('input[value="percentage"]').checked = true
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


        container.appendChild(div)
    })

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

function generateShareLink() {
    if (!activeMixId || !mixes[activeMixId]) return alert("Select a mix first!");

    const mixData = mixes[activeMixId];
    // We stringify the mix and encode it so it's safe for a URL
    const jsonString = JSON.stringify(mixData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString))); 
    
    const shareUrl = `${window.location.origin}/?import_mix=${base64Data}`;

    // Copy to clipboard
    navigator.clipboard.writeText(shareUrl).then(() => {
        showResult("Share link copied to clipboard!");
        alert("Share link copied! Send this URL to a friend.");
    }).catch(err => {
        console.error("Link copy failed:", err);
        alert("Copy failed. Here is your link: " + shareUrl);
    });
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
    const url = `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,owner.id,tracks.total`;

    try {
        showResult(`await fetch(${url}` )
        const response = await safeSpotifyFetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!response.ok) {
            const errorBody = await response.json();
            throw new Error(errorBody.error.message || "Forbidden or Not Found");
        }
        const data = await response.json();
        console.log("Spotify API Response:", data); // OPEN YOUR CONSOLE (F12) TO SEE THIS
        console.log("Keys available in this object:", Object.keys(data));
        console.log("Full Tracks Object:", data.tracks); // Check if this is an object or a number
        console.log("Full Tracks Object:", data.total); // Check if this is an object or a number
        console.log("Full Tracks Object:", data.tracks?.total); // Check if this is an object or a number
        console.log("Full Tracks Object:", data.total_tracks); // Check if this is an object or a number
        
        // CHECK OWNERSHIP
        const isOwner = data.owner.id === currentUserId;


        // We also need the playlist NAME, so we do one more quick fetch 
        // or just use the ID as a placeholder if name isn't critical yet.
        // const nameRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name`, {
        //     headers: { 'Authorization': `Bearer ${token}` }
        // });
        //const nameData = await nameRes.json();
        console.log("Spotify API Response:", data); // OPEN YOUR CONSOLE (F12) TO SEE THIS
        console.log("nameData:", data.name); // Check if this is an object or a number

        if (!isOwner) {
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

        return {
            id: playlistId,
            name: data.name || "Spotify Playlist",
            //trackCount: data.total || 0, // 'total' is a top-level field in the /tracks endpoint
            // This 'total' field is usually available even for unowned playlists
            trackCount: data.tracks?.total || data.total_tracks || 0,
            enabled: true,
            sliderValue: 50
        };
    } catch (err) {
        showResult("Error: " + err.message);
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
    const token = localStorage.getItem('access_token');
    // Use the /items endpoint we fixed earlier to get the real count
    const url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=1`;

    try {
        const response = await safeSpotifyFetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        if (data.total !== undefined) {
            playlists[playlistIndex].trackCount = data.total;
            saveAppState();
            renderPlaylists();
            showResult(`Updated ${playlists[playlistIndex].name} to ${data.total} songs.`);
        }
    } catch (err) {
        console.error("Refresh failed:", err);
    }
}

function loadAppState() {
    const stored = localStorage.getItem("spotifyAppState")
    if(stored){
        const state = JSON.parse(stored)
        mixes = state.mixes || {}
        activeMixId = state.activeMixId || null
    }

    if(!activeMixId){
        createDefaultMix()
    } 
    else{
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

function createDefaultMix() {
    console.warn("Creating Default Mix")
    const id = Date.now().toString()

    mixes[id] = {
        name: "Default Mix",
        playlists: structuredClone(playlists)
    }

    activeMixId = id
    saveAppState()
    renderMixSelector()
}

function renderMixSelector(){
    const select = document.getElementById("mix-selector")
    select.innerHTML = ""

    Object.entries(mixes).forEach(([id, mix]) => {
        const opt = document.createElement("option")
        opt.value = id
        opt.textContent = mix.name
        if(id === activeMixId) opt.selected = true
        select.appendChild(opt)
    })
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
document.addEventListener('visibilitychange', () => {
    console.warn("App visibility changed")
    if (wakeLock !== null && document.visibilityState === 'visible') {
        requestWakeLock();
    }
});




document.addEventListener("DOMContentLoaded", async () => {

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
    else if (code) {
        console.warn("New login detected. Swapping code for token...");
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
        } catch (e) {
            console.error("Failed to import shared mix:", e);
            showResult("Error: Invalid share link.");
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
    let songStartTime = 0;

    if (initBtn) {
        initBtn.onclick = async () => {

            await requestWakeLock();

            // If already online, act as the Emergency Stop
            if (device_id) {
                emergencyStop();
                return;
            }
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
                } catch (err) {
                    console.warn("🟡 Audio Heartbeat failed:", err);
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
                initBtn.textContent = "Mixer Online 🟢";
                initBtn.style.background = "#1DB954";
                document.getElementById('init-player').textContent = "Mixer Online 🟢";
                document.getElementById('play-pause').style.display = "inline-block";
            });

            // Add this listener to handle temporary drops
            player.addListener('not_ready', ({ device_id }) => {
                console.warn("Device has gone offline:", device_id);
                showResult("Connection lost. Trying to reconnect...");
                // The SDK will try to reconnect itself, but we can nudge it:
                player.connect(); 
            });

            player.addListener('autoplay_failed', () => {
                console.warn("AUTOPLAY BLOCKED: The browser stopped the next song from starting.");
                showResult("Browser blocked autoplay. Tap 'Play' to resume the mixer.");
                
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
            });
            player.addListener('authentication_error', ({ message }) => { console.error(message); });
            player.addListener('account_error', ({ message }) => { alert("Premium account required!"); });

            player.addListener('authentication_error', async ({ message }) => {
                console.error('SDK Authentication Error:', message);
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
                player.connect();
                showResult("Player reconnected");
                console.warn("Player reconnected");
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

                // Check if another device (like the Spotify App) took over
                if (state.playback_id === "" && !state.is_paused) {
                    // This usually means the 'Session' moved elsewhere
                    console.warn("Playback hijacked by another device.");
                    showResumeOverlay(true);
                } else if (state.is_active === false) {
                    console.warn("Mixer is no longer the active device.");
                    showResumeOverlay(true);
                } else {
                    // If we are active again, hide the overlay
                    showResumeOverlay(false);
                }

                const now = Date.now()

                // 1. Check if the song has actually changed to a new ID
                if (current_track.id !== currentTrackId) {
                    console.log("New track detected:", current_track.name);
                    currentTrackId = current_track.id;
                    lastPickTime = Date.now() //reset timer for new song
                    return; //exit: we just started a song, don't pick a new one!
                    // Update your 'Now Playing' UI here if needed
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
                //if (isAtEnd) {
                    console.log("Track naturally finished. Picking next...");

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
                    currentTrackId = null; 
                    player.activateElement(); 
                    pickRandomSong();                     
                }   
                
                // Detect if the song has naturally ended
                // Position 0 and Paused = The track is over
                if (isAtEnd) {
                    console.log("Track finished! But it's a recent pick. Picking next song automatically...");
                    
                    // Reset the ID so the next song can be detected as 'new'
                    //currentTrackId = null; 
        
                    //pickRandomSong(); 
                }
            });

            console.warn("Powering on...");
            // Use activateElement for mobile/Android compatibility
            player.activateElement(); 
            player.connect().then(success => {
                if (success) {
                    console.warn("Connection request sent to Spotify!");
                } else {
                    console.error("Connection failed. Check your Premium status.");
                }
            });

            // START THE HEARTBEAT ONLY ONCE THE MIXER IS POWERED ON
            // We store it in a variable so 'Emergency Stop' can kill it later
            if (!window.refreshInterval) {
                window.refreshInterval = setInterval(async () => {
                    if (device_id) { 
                        console.warn("Mixer is active, keeping token warm...");
                        await refreshAccessToken();
                    }
                }, 50 * 60 * 1000); // 50 minutes
            }

            // Add this inside your initBtn.onclick
            setInterval(() => {
                if (device_id && player) {
                    console.warn("Pinging Spotify to keep device active...");
                    player.connect();
                }
            }, 15 * 60 * 1000); // Every 15 minutes

            // The "Action Handlers" (The Remote Control)
            // This is the part that usually gets missed. You need to tell the Android OS what to do when the user hits the buttons on their lock screen. Put this in your initBtn.onclick (or anywhere it only runs once).
            if ('mediaSession' in navigator) {
                // When the user hits "Next" on the lock screen
                navigator.mediaSession.setActionHandler('nexttrack', () => {
                    console.warn("Lock screen: Next Track clicked.");
                    pickRandomSong(); 
                });

                // When the user hits "Pause"
                navigator.mediaSession.setActionHandler('pause', () => {
                    if (player) player.pause();
                    navigator.mediaSession.playbackState = "paused";
                });

                // When the user hits "Play"
                navigator.mediaSession.setActionHandler('play', () => {
                    if (player) player.resume();
                    navigator.mediaSession.playbackState = "playing";
                });
            }

        };
    }

    if (playPauseBtn) {
        playPauseBtn.onclick = () => {
        console.log("PlayPauseBtn");
            if (player){
                console.log("togglePlay");
                player.togglePlay();
            }
        };
    }


    // --- INITIALIZE DATA AND UI HERE ---
    loadAppState();
    setSelectionMode(selectionMode); 
    
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

    document.getElementById('manual-retry-btn').onclick = () => {
        const uriInput = document.getElementById('manual-uri-input');
        const uri = uriInput.value.trim();

        // Basic validation: Check if it looks like a Spotify track URI
        if (uri.startsWith('spotify:track:') && uri.length > 20) {
            console.log("Manually retrying with URI:", uri);
            showResult(`Manual Play: ${uri}`);
            
            // Use your existing playTrack function
            playTrack(uri, false);
            
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
            name,
            playlists: structuredClone(playlists)
        }

        activeMixId = id
        saveAppState()
        renderMixSelector()
    }

    document.getElementById("mix-selector").onchange = e => {
        activeMixId = e.target.value
        const selectedMix = mixes[activeMixId];

        playlists = structuredClone(mixes[activeMixId].playlists)
        selectionMode = selectedMix.selectionMode || "normal" //restore the mode

        //update the radio buttons to match
        document.querySelector(`input[name="selectionMode"][value="${selectionMode}"]`).checked = true;

        renderPlaylists()
        saveAppState()
    }

    document.getElementById('share-mix-btn').onclick = generateShareLink;

    document.getElementById('toggle-list-btn').onclick = function() {
        const list = document.getElementById('playlist-list');
        const btn = this;

        if (list.style.maxHeight === "200px" || list.style.maxHeight === "") {
            // EXPAND
            //max-height vs height: Using max-height: 1000px (or none) allows the box to grow only as large as the content inside it.
            list.style.maxHeight = "1000px"; // Set to a height larger than your list
            list.style.overflowY = "visible";
            btn.textContent = "▲ Show Less";
        } else {
            // COLLAPSE
            list.style.maxHeight = "200px";
            list.style.overflowY = "auto";
            btn.textContent = "▼ Show All";
        }
    };

})
