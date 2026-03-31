//alert("app.js loaded")

let player;
let device_id;
let lastPickTime = 0;

window.onSpotifyWebPlaybackSDKReady = () => {
    console.log("Spotify SDK is ready to initialize!");
    const token = localStorage.getItem('access_token');
};

async function playTrack(trackUri) {
    const token = localStorage.getItem('access_token');
    if (!device_id) return alert("Click 'Power On' first!");

    try {
        const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device_id}`, {
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

        if (response.status === 403) {
            console.warn("403: Song restricted. Skipping to a new one...");
            showResult("Song restricted by Spotify. Picking another...");
            //alert("Spotify Premium is required for this feature.");
            // AUTO-RECOVERY: Just trigger a new pick!
            setTimeout(() => pickRandomSong(), 500); 
        } else if (response.status === 204) {
            // Wait 300ms for Spotify's servers to process the change, 
            // then force the local player to start.
            setTimeout(async () => {
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
        <span style="font-size: 0.8em; color: #535353;">— ${playlistName}</span>
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

    const response = await fetch("https://accounts.spotify.com/api/token", payload);
    const data = await response.json();

        if (response.ok) {
            window.localStorage.setItem('access_token', data.access_token);
            // Clean the URL so the code isn't reused on refresh
            window.history.replaceState({}, document.title, "/");
        } else {
            // Log the actual error message from Spotify (e.g., "invalid_grant")
            console.error("Token Error:", data.error, data.error_description);
        }

    // if (data.access_token) {
    //     window.localStorage.setItem('access_token', data.access_token);
    //     // Optional: setup a 'refresh_token' to keep the user logged in longer
    // }
}

async function getCurrentUserId() {
    const token = localStorage.getItem('access_token');
    const response = await fetch('https://api.spotify.com/v1/me', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    localStorage.setItem('spotify_user_id', data.id);
    return data.id;
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
    "#caffbf"  //mint
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

    // real Spotify playback...
    const token = localStorage.getItem('access_token');
    const track = await getTrackAtIndex(token, chosenplaylist.id, index)
    
    if (track === "NETWORK_ERROR"){
        console.log("pickRandomSong: NETWORK_ERROR, stopping loop")
        return; // Stop the loop immediately!
    }
    
    // Safety check: only call playTrack if we actually got a track back
    if (track && track.uri) {
        console.log("Playing:", track.name);
        showResult(`Now Playing: ${track.name} by ${track.artists[0].name}`);
        
        // --- ADD TO HISTORY ---
        addToHistory(track, chosenplaylist.name);

        playTrack(track.uri);
    } else {
        console.log("Could not fetch that specific track. Try again!");
        // If track was null (failed safety checks), try again!
        console.log("Track was restricted or null. Retrying pick attempt " + (attempt + 1) + "...");
        pickRandomSong(attempt + 1);
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
        const res = await fetch(

    `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}&market=from_token&additional_types=track`,
            {
                headers: { Authorization: `Bearer ${token}` }
            }
        )

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
        div.innerHTML = `
                <input type="checkbox" class="playlist-enabled" ${playlist.enabled ? "checked" : ""}>
                <input type="range" min="0" max="100" value="${playlist.sliderValue ?? 50}" class="playlist-slider" data-index="${index}">
                <span class="slider-value"></span>
                <button class="delete-btn">Delete</button>
                ${playlist.name} (${playlist.trackCount}) songs
        `

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

async function fetchUserPlaylists() {
    const token = localStorage.getItem('access_token');
    if (!token) return;

    try {
        const response = await fetch('https://api.spotify.com', {
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
        const response = await fetch(url, {
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
        const response = await fetch(url, {
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
    const response = await fetch(`https://api.spotify.com/v1/me/playlists`, {
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
        const response = await fetch(url, {
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


document.addEventListener("DOMContentLoaded", async () => {

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
        initBtn.onclick = () => {
            //alert("CLICK DETECTED!"); // <--- ADD THIS TEMPORARILY
            const currentToken = localStorage.getItem('access_token');
            if (!currentToken) return alert("Please login to Spotify first!");

            console.log("Button Clicked: Initializing Player...");

            player = new Spotify.Player({
                name: "Ben's Mixer Lab",
                getOAuthToken: cb => { cb(currentToken); },
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

            // Ready
            player.addListener('ready', ({ device_id: id }) => {
                console.log('Ready with Device ID', id);
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

            // Add this to catch the 'Melody' 401/500 errors
            player.addListener('initialization_error', ({ message }) => {
                if (message.includes("initialized")) {
                    console.error("SDK lost its internal connection. A page refresh is likely needed.");
                    showResult("Playback Engine Error. Please refresh the page.");
                }
            });            

            // Error handling
            player.addListener('initialization_error', ({ message }) => { console.error(message); });
            player.addListener('authentication_error', ({ message }) => { console.error(message); });
            player.addListener('account_error', ({ message }) => { alert("Premium account required!"); });

            // Add this inside your initBtn.onclick, near your other listeners:
            player.addListener('player_state_changed', async (state) => {
                if (!state) return;

                const {
                    paused,
                    position,
                    duration,
                    track_window: {current_track}
                } = state;

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

            console.log("Powering on...");
            // Use activateElement for mobile/Android compatibility
            player.activateElement(); 
            player.connect().then(success => {
                if (success) {
                    console.log("Connection request sent to Spotify!");
                } else {
                    console.error("Connection failed. Check your Premium status.");
                }
            });
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


    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');

    if (code) {
        // We just returned from Spotify; swap the code for a token
        await getToken(code);
        // Clean the URL so the 'code' doesn't stay in the address bar
        window.history.replaceState({}, document.title, "/");

        // Change button text to show user is logged in
        document.getElementById('login-button').textContent = "Logged In";
        document.getElementById('login-button').disabled = true;
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
            playTrack(uri);
            
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

})
