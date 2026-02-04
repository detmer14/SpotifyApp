//alert("app.js loaded")

const MOCK_MODE = true

let playlists = [
    {id: "A", enabled: true, name: "Playlist A", trackCount: 10},
    {id: "B", enabled: true, name: "Playlist B", trackCount: 1},
    {id: "C", enabled: true, name: "Playlist C", trackCount: 1}
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

let nextColorIndex = 0

function generatePlaylistColor() {
    const color = playlistColorPalette[nextColorIndex % playlistColorPalette.length]
    nextColorIndex++
    return color
}

let mixes = {}
let activeMixId = null


const multipliers = [0.25, 0.5, 0.75, 1.0, 1.25, 1.75, 2.5];

function getWeight(sliderValue, playlist) {
    if (sliderValue <= 0) {
        playlist.enabled = false;
        return 0;
    } else {
        playlist.enabled = true;
    }

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
loadAppState()

if(!activeMixId){
    createDefaultMix()
}

renderMixSelector()
renderPlaylists()

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
    const activePlaylists = playlists.filter(p => p.enabled)
    if (activePlaylists.length === 0) return null

    const weightedCounts = activePlaylists.map(
        p => p.trackCount * getWeight(p.sliderValue ?? 50, p)
    )

    const total = weightedCounts.reduce((s, v) => s + v, 0)
    let r = Math.random() * total

    for (let i = 0; i < activePlaylists.length; i++) {
        if (r < weightedCounts[i]) {
            const playlist = activePlaylists[i]
            const index = Math.floor(Math.random() * playlist.trackCount)
            return { playlist, index }
        }
        r -= weightedCounts[i]
    }

    return null
}

// =========================
// Balance playlist probabilities
// =========================
function balancePlaylists() {
    const enabled = playlists.filter(p => p.enabled)

    if (enabled.length < 2) {
        alert("Enable at least two playlists to balance")
        return
    }

    // Pick a target effective weight
    const TARGET = 100

    enabled.forEach(p => {
        // weight ≈ TARGET / trackCount
        let rawWeight = TARGET / p.trackCount

        // Convert weight → slider value
        // Find closest matching slider division
        let bestIndex = 0
        let bestDiff = Infinity

        multipliers.forEach((m, i) => {
            const diff = Math.abs(m - rawWeight)
            if (diff < bestDiff) {
                bestDiff = diff
                bestIndex = i
            }
        })

        // Map division back into slider range
        const divisionSize = 100 / multipliers.length
        p.sliderValue = Math.round(bestIndex * divisionSize + divisionSize / 2)

        // Safety clamps
        p.sliderValue = Math.max(1, Math.min(100, p.sliderValue))
    })

    saveAppState()
    renderPlaylists()
    showResult("Playlists balanced evenly")
}


async function pickRandomSong() {
    const activePlaylists = playlists.filter(p => p.enabled)

    if(activePlaylists.length === 0){
        alert("Select at least one playlist")
        return
    }

    // Weighted track counts
    const weightedCounts = activePlaylists.map(p => p.trackCount * getWeight(p.sliderValue ?? 50, p))
    const total = weightedCounts.reduce((sum, val) => sum + val, 0)
    const randomindex = Math.random() * total

    let cumulative = 0
    let chosenplaylist, index
    for (let i = 0; i < activePlaylists.length; i++) {
        cumulative += weightedCounts[i]
        if (randomindex < cumulative) {
            chosenplaylist = activePlaylists[i]
            index = Math.floor(Math.random() * chosenplaylist.trackCount) // uniform inside playlist
            break
        }
    }

    if (!chosenplaylist) return

    if (MOCK_MODE) {
        showResult(`--------------- Playlist ${chosenplaylist.name}, song #${index + 1}`)
        return
    }

    // real Spotify playback...
    const track = await getTrackAtIndex(accessToken, chosenplaylist.id, index)
    playTrack(track.uri)
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

    for (let i = 0; i < desiredCount; i++) {
        const result = pickRandomTrackInfo()
        if (!result) break
        selections.push(result)
    }

    const container = document.getElementById("generated-playlist")
    container.innerHTML = ""

    selections.forEach((item, i) => {
        const row = document.createElement("div")
        row.className = "playlist-row"
        row.style.backgroundColor = item.playlist.color || "#eee"

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


async function getTrackAtIndex(token, playlistId, index){
    const limit = 1
    const offset = index

    const res = await fetch(

`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`,
        {
            headers: { Authorization: `Bearer ${token}` }
        }
    )

    const data = await res.json()
    return data.items[0].track
}


async function playTrack(trackUri){
    await fetch(
        `https://api.spotify.com/v1/me/player/play`,
        {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                uris: [trackUri]
            })
        }
    )
}

function renderPlaylists() {
    const container = document.getElementById("playlist-list")
    container.innerHTML = ""

    playlists.forEach((playlist, index) => {
        const div = document.createElement("div")
        div.innerHTML = `
            <label>
                <input type="checkbox" ${playlist.enabled ? "checked" : ""}>
                <input type="range" min="0" max="100" value="${playlist.sliderValue ?? 50}" class="weight-slider">
                <span class="weight-display"></span>
                <button class="delete-btn">Delete</button>
                ${playlist.name} (${playlist.trackCount}) songs
            </label>
            
            
            
        `

        const checkBox = div.querySelector("input[type='checkbox']")
        const slider = div.querySelector(".weight-slider")
        const display = div.querySelector(".weight-display")
        slider.disabled = !playlist.enabled
        display.textContent = `${playlist.enabled ? playlist.sliderValue ?? 50 : 0}`

        // Checkbox change
        checkBox.onchange = () => {
            playlists[index].enabled = checkBox.checked
            //slider.disabled = !checkBox.checked   // <- NEW LINE
            saveAppState()
            renderPlaylists()
        }

        // Slider change
        slider.oninput = () => {
        playlist.sliderValue = parseInt(slider.value)
        display.textContent = playlist.sliderValue

    if (playlist.sliderValue <= 0) {
        playlist.enabled = false
        checkBox.checked = false
        //slider.disabled = true   // <- NEW LINE
    } else {
        playlist.enabled = true
        checkBox.checked = true
        slider.disabled = false  // <- NEW LINE
    }

    saveAppState()
        }

        // Delete Playlist
        const deleteBtn = div.querySelector(".delete-btn")
        deleteBtn.onclick = () => {
            playlists.splice(index, 1)
            saveAppState()
            renderPlaylists()
        }

        container.appendChild(div)
    })
}


//Save playlists array to localStorage
//No longer used
function savePlaylists(){
    localStorage.setItem('playlists', JSON.stringify(playlists))
}


document.getElementById('add-playlist').onclick = () => {
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
        sliderValue: 50,
        color: generatePlaylistColor()
    })
    saveAppState()
    renderPlaylists()

    //clear input
    //nameInput.value = ''
    //countInput.value = ''
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

    playlists.forEach(p => {
        if(!p.color){
            p.color = generatePlaylistColor()
        }
    })
    saveAppState()
}

function saveAppState() {
    if(!activeMixId){
        console.warn("No active mix - creating default")
        createDefaultMix()
    }
    mixes[activeMixId].playlists = structuredClone(playlists)

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

document.getElementById("balance-playlists").onclick = balancePlaylists

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById('pick').onclick = pickRandomSong
    // document.getElementById('pick').onclick = () => {
    //     alert ("button clicked")
    // }

    document.getElementById("generate-playlist").onclick = generateRandomPlaylist

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
        playlists = structuredClone(mixes[activeMixId].playlists)
        renderPlaylists()
        saveAppState()
    }

    function showResult(text){
        document.getElementById("result").textContent = text
    }
})








