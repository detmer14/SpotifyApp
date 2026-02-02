//alert("app.js loaded")

const MOCK_MODE = true

let playlists = [
    {id: "A", enabled: true, name: "Playlist A", trackCount: 10},
    {id: "B", enabled: true, name: "Playlist B", trackCount: 1},
    {id: "C", enabled: true, name: "Playlist C  ", trackCount: 1}
]

let mixes = {}
let activeMixId = null

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

async function pickRandomSong(){
    //alert("picking random song")


    const activePlaylists = playlists.filter(playlist => playlist.enabled)

    if(activePlaylists.length === 0){
        alert("Select at least one playlist")
        return
    }

    const total = activePlaylists.reduce((sum, p) => sum + p.trackCount, 0)
    const randomindex = Math.floor(Math.random() * total)

    let cumulative = 0
    let chosenplaylist, index
    for (const playlist of activePlaylists) {
        if (randomindex < cumulative + playlist.trackCount) {
            chosenplaylist = playlist
            index = randomindex - cumulative

            if (MOCK_MODE) {
                //alert(`Playlist ${playlist.id}, song #${index + 1}`)
                showResult(`Playlist ${playlist.name}, song #${index + 1}`)

                return
            }
            break
        }
        cumulative += playlist.trackCount
    }

    if(!chosenplaylist) return

    if (!MOCK_MODE) {
    const track = await getTrackAtIndex(accessToken, chosenplaylist.id, index)
        playTrack(track.uri)
    }
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
                ${playlist.name} (${playlist.trackCount}) songs
            </label>
            <button class="delete-btn">Delete</button>
        `

        const checkBox = div.querySelector("input")
        checkBox.onchange = () => {
            playlists[index].enabled = checkBox.checked
            saveAppState()
            renderPlaylists()
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

renderPlaylists()

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
    playlists.push({id: newID, name: name, trackCount: count, enabled: true})
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
    mixes[activeMixId].playlists = structuredClone(playlists)

    localStorage.setItem("spotifyAppState"), JSON.stringify({mixes, activeMixId})
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

