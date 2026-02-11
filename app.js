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
loadAppState()
setSelectionMode(selectionMode)

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

    const chosenplaylist = pickPlaylistByMode()
    if(!chosenplaylist) return null

    const index = Math.floor(Math.random() * chosenplaylist.trackCount)
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

        slider.value = Math.max(0, Math.round(newValue))
        const playlistIndex = Number(slider.dataset.index)
        playlists[playlistIndex].sliderValue = slider.value
        runningTotal += slider.value
        updateSliderDisplay(slider)
    })

    isProgrammaticSliderUpdate = false
}


function rebalancePercentagesByIndex(activeIndex){
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
}


function updateSliderDisplay(slider){
    const valueSpan = slider.closest('.playlist-row').querySelector('.slider-value')

    if(valueSpan){
        valueSpan.textContent = slider.value
    }
}

function normalizePercentagedAfterToggle(){
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
    // document.querySelectorAll(".playlist.slider").forEach(slider => {
    //     const i = Number(slider.dataset.index)
    //     const value = playlists[i].sliderValue ?? 0
    //     slider.value = value
    //     slider.closest(".playlist-row").querySelector(".slider-value").textContent = value
    // })

    playlists.forEach((playlist, index) => {
        const slider = document.querySelector('.playlist-slider[data-index="$index"]')
        const display = slider?.closest('.playlist-row')?.querySelector('.slider-value')
        if(slider){
            slider.value = playlist.sliderValue ?? 50
        }
        if(display){
            display.textContent = playlist.sliderValue ?? 50
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
    const total = activePlaylists.reduce((sum, p) => sum + (p.sliderValue ?? 0), 0)

    if(total == 0) return null

    let r = Math.random() * total

    for(const playlist of activePlaylists){
        r -= playlist.sliderValue
        if(r <= 0) return playlist
    }

    return null
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


async function pickRandomSong() {
    const activePlaylists = playlists.filter(p => p.enabled)

    if(activePlaylists.length === 0){
        alert("Select at least one playlist")
        return
    }

    let cumulative = 0
    let chosenplaylist, index


    chosenplaylist = pickPlaylistByMode()

    index = Math.floor(Math.random() * chosenplaylist.trackCount) // uniform inside playlist

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
        
        playlist._renderColor = getPlaylistColorByIndex(index)
        
        const div = document.createElement("div")
        div.className = "playlist-row"
        div.innerHTML = `
                <input type="checkbox" ${playlist.enabled ? "checked" : ""}>
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
        display.textContent = playlist.sliderValue ?? 50

        // Checkbox change
        checkBox.onchange = () => {
            //selectionMode = "weighted"
            playlists[index].enabled = checkBox.checked
            //slider.disabled = !checkBox.checked   // <- NEW LINE

            if(selectionMode === "percentage"){
                normalizePercentagedAfterToggle()
                syncSlidersFromState()
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
                //normalizePercentagedAfterToggle()
                showResult("Percentage mode enabled")
            }

            if(selectionMode === "percentage"){
                isProgrammaticSliderUpdate = true
                rebalancePercentagesByIndex(index)
                //syncSlidersFromState()
                isProgrammaticSliderUpdate = false
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

        //slider.onchange = () => {
        slider.addEventListener("change", () => {
            isProgrammaticSliderUpdate = true
            syncSlidersFromState()
            //saveAppState()
            isProgrammaticSliderUpdate = false
        })

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
        sliderValue: 50
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


function showResult(text){
    document.getElementById("result").textContent = text
}


document.addEventListener("DOMContentLoaded", () => {

    
    
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

})
