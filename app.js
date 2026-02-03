//alert("app.js loaded")

const MOCK_MODE = true

let playlists = [
    {id: "A", enabled: true, name: "Playlist A", trackCount: 10},
    {id: "B", enabled: true, name: "Playlist B", trackCount: 1},
    {id: "C", enabled: true, name: "Playlist C", trackCount: 1}
]

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
        showResult(`Playlist ${chosenplaylist.name}, song #${index + 1}`)
        return
    }

    // real Spotify playback...
    const track = await getTrackAtIndex(accessToken, chosenplaylist.id, index)
    playTrack(track.uri)
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
                <button class="delete-btn">Delete</button>
                ${playlist.name} (${playlist.trackCount}) songs
            </label>
            
            
            <span class="weight-display"></span>
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
    playlists.push({id: newID, name: name, trackCount: count, enabled: true, sliderValue: 50})
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

document.getElementById('pick').onclick = pickRandomSong
// document.getElementById('pick').onclick = () => {
//     alert ("button clicked")
// }

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






