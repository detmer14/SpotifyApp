//alert("app.js loaded")

const MOCK_MODE = true

let playlists = [
    {id: "A", enabled: true, name: "Playlist A", trackCount: 10},
    {id: "B", enabled: true, name: "Playlist B", trackCount: 1},
    {id: "C", enabled: true, name: "Playlist C  ", trackCount: 1}
]

//Load playlists array from localStorage
function loadPlaylists(){
    const stored = localStorage.getItem('playlists')
    if(stored){playlists = JSON.parse(stored)}
}

loadPlaylists()

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
                showResult(`Playlist ${playlist.id}, song #${index + 1}`)

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
            <button class="delete-btn">Delete</btton>
        `

        const checkBox = div.querySelector("input")
        checkBox.onchange = () => {
            playlists[index].enabled = checkBox.checked
            savePlaylists()
        }

        // Delete Plalist
        const deleteBtn = div.querySelector(".delete-btn")
        deleteBtn.onclick = () => {
            playlists.splice(index, 1)
            savePlaylists()
            renderPlaylists()
        }

        container.appendChild(div)
        
    })
}

renderPlaylists()

//Save playlists array to localStorage
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
    savePlaylists()
    renderPlaylists()

    //clear input
    nameInput.value = ''
    countInput.value = ''
}

document.getElementById('pick').onclick = pickRandomSong
// document.getElementById('pick').onclick = () => {
//     alert ("button clicked")
// }

function showResult(text){
    document.getElementById("result").textContent = text
}

