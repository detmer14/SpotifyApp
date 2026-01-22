const MOCK_MODE = true

const playlists = [
    {id: "A", trackCount: 120},
    {id: "B", trackCount: 80},
    {id: "C", trackCount: 40},
]


async function initializePlayer(){
    window.onSpotifyWebPlaybackSDKReady = () => {
        const player = new Spotify.Player({
            name: 'Rndom Playlist Player',
            getOAuthToken: cb => cb(accessToken),
            volume: 0.8
        })

        player.connect()
    }
}

async function pickRandomSong(){
    const total = playlists.reduce((sum, p) => sum + p.trackCount, 0)
    const randomindex = Math.floor(Math.random() * total)

    let cumulative = 0
    let chosenplaylist, index
    for (const playlist of playlists) {
        if (randomindex < cumulative + playlist.trackCount) {
            chosenplaylist = playlist
            index = randomindex - cumulative

            if (MOCK_MODE) {
                showResult(`Playlist ${playlist.id}, song #${index + 1}`)

                break
            }
        }
        cumulative += playlist.trackCount
    }

    if (!MOCK_MODE) {
    const track = await getTrackAtIndex(accessToken, chosenplaylist.id, index)
        playTrack(track.url)
    }
}





async function getTrackAtIndex(token, playlistId, index){
    const limit = 1
    const offset = index

    const res = await fetch(

`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`,
        {
            headers: { Authorizatoin: 'Bearer ${token}' }
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
                Authorization: 'Bearer ${accessToken}', 'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                uris: [trackUri]
            })
        }
    )
}


document.getElementById('pick').onclick = pickRandomSong
