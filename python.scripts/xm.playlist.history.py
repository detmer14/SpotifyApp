import os
import json
import requests
# pip install requests
from datetime import datetime
from pathlib import Path
# from curl_cffi import requests
# pip install curl_cffi

import browser_cookie3
# pip install browser-cookie3

import urllib3
# Suppress the "InsecureRequestWarning" messages from cluttering your console
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Map of station names to their API endpoints
STATIONS = {
    "octane":               "https://xmplaylist.com/api/station/octane",                # XM Octane Ch. 37 - Hard Rock 
    "bluegrassjunction":    "https://xmplaylist.com/api/station/bluegrassjunction",     # XM Bluegrass Junction  Ch. 77
    "thepulse":             "https://xmplaylist.com/api/station/thepulse",              # XM The Pulse Ch. 5 - Today's pop
    "siriusxmhits1":        "https://xmplaylist.com/api/station/siriusxmhits1",         # XM SiriusXM Hits 1 Ch. 2 - pop - Today's hits
    "poprocks":             "https://xmplaylist.com/api/station/poprocks",              # XM PopRocks Ch. 6 - pop - The greatest pop/rock anthems from the 90s and 2000s
    "thebridge":            "https://xmplaylist.com/api/station/thebridge",             # XM The Bridge Ch. 14 - Cross the bridge to the mellow side of classic rock and 70s folk rock.
    "theblend":             "https://xmplaylist.com/api/station/theblend",              # XM The Blend Ch. 16 - Blending nice & easy pop
    "alt2k":                "https://xmplaylist.com/api/station/alt2k",                 # XM Alt2K Ch. 27 - Alt Rock
    "1stwave":              "https://xmplaylist.com/api/station/1stwave",               # XM 1st Wave Ch. 33 - Alt Rock - The First Wave of alternative music
    "lithium":              "https://xmplaylist.com/api/station/lithium",               # XM Lithium Ch. 34 90s Rock - 90s alternative & grunge rock
    "kidzbopradio":         "https://xmplaylist.com/api/station/kidzbopradio",          # XM KIDZ BOP Radio Ch. 135 - kids
    "altnation":            "https://xmplaylist.com/api/station/altnation",             # XM Alt Nation Ch. 36 - Modern Alternative
    "siriusxmturbo":        "https://xmplaylist.com/api/station/siriusxmturbo",         # XM Turbo Ch. 41 - 90s and 2000s Hard Rock
    "thehighway":           "https://xmplaylist.com/api/station/thehighway",            # XM The Highway Ch. 56 - New Country
    "y2kountry":            "https://xmplaylist.com/api/station/y2kountry",             # XM Y2Kountry Ch. 57 - 2000s Country
    "primecountry":         "https://xmplaylist.com/api/station/primecountry",          # XM Prime Country Ch. 58 - 80s 90s Country
    "disneyhits":           "https://xmplaylist.com/api/station/disneyhits",            # XM Disney Hits Ch. 133
    "greendaysidiotnation": "https://xmplaylist.com/api/station/greendaysidiotnation",  # XM Green Day's Idiot Nation Ch. 314 - Punk Rock
    "williesroadhouse":     "https://xmplaylist.com/api/station/williesroadhouse",      # XM Willie's Roadhouse Ch. 61 - Classic Country
    "classicrewind":        "https://xmplaylist.com/api/station/classicrewind",         # XM Classic Rewind Ch. 25 - Classic Rock
    "ozzysboneyard":        "https://xmplaylist.com/api/station/ozzysboneyard",         # XM Ozzy's Boneyard Ch. 38 - Heavy Classic Rock
    "hairnation":           "https://xmplaylist.com/api/station/hairnation",            # XM Hair Nation Ch. 39 - Classic Rock
    "redwhitebooze":        "https://xmplaylist.com/api/station/redwhitebooze",         # XM Red White & Booze Ch. 350 - Country & Rock - Country/Rock-themed bars and honky tonks
}
# Map of stations you actually care about tracking
TRACKED_STATIONS = {
    "octane", 
    "bluegrassjunction", 
    "thepulse", 
    "siriusxmhits1", 
    "poprocks", 
    "thebridge", 
    "theblend", 
    "alt2k", 
    "1stwave", 
    "lithium", 
    "kidzbopradio", 
    "altnation", 
    "siriusxmturbo", 
    "thehighway", 
    "y2kountry", 
    "primecountry", 
    "disneyhits", 
    "greendaysidiotnation", 
    "williesroadhouse", 
    "classicrewind", 
    "ozzysboneyard", 
    "hairnation", 
    "redwhitebooze",
}

# Get the directory where your script is currently living
script_dir = Path(__file__).resolve().parent

def update_global_feed():

    feed_url = "https://xmplaylist.com/api/feed"
    # Route directly through the public proxy, skipping your worker
    proxied_url = f"https://api.codetabs.com/v1/proxy?quest={feed_url}"

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Fetching global playlist feed...")
    print(f"proxied_url: {proxied_url}")
    
    try:
        # Automatically pull fresh valid cookies from your active browser
        # Use .chrome(), .firefox(), or .edge() depending on what you use
        #cj = browser_cookie3.chrome(domain_name='xmplaylist.com')
        
        # Standard browser-like headers to keep the payload request looking clean
        headers = {
            # "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0",
            "Cookie": "cf_clearance=uePIyAUK2uf2EH.WbwfeMko7BNDmQqJd9ydB2buj488-1780419301-1.2.1.1-QlySAaWJy6_53j9RNJyGUOzdez9CDwjWaidP6W3FxX4hMNHjz6mbJESFAVf.50M8hn.uoVfEnYxz4289_PZnaf9QBaNmSsPW4b5IzxtWbT_mIZ062GoAQCY1F6NLZmJFQ6vrgqM4DUkPBG3EsAiznSzPeDipeUEio8jQSmxdsE1Q7OtXYpkZWqrGxGoifZtZLcA46gg3dqlZ7G4Ryap8ndVs2m4Ywx06eYTm_uyyDgrejrdx8_x0EMU42Nh9TiuS8A9paWA1rX0aSkQ0Uro54Ljp4Ig5ub.ElZWjpP8o9pXW_enMforUBbgmeLL8YirMEetF5zU.LTBtIuldrw.FB1HqjZRuk.20j4aR7fyTHaGXg4jewP_M1drvqUnsbcK8O2VyGGacdVgoK7g39jEPrtpb8q.S9mJ5FOfVyC3VWh4; _ga=GA1.1.995290611.1780419303; __client_uat=0; __client_uat_KqccziaU=0; __gads=ID=f0fb037226b1161f:T=1780419303:RT=1780419303:S=ALNI_MY7SI_z9l7A14CKVPMpK6yek3c1YA; __gpi=UID=000013af5b2902f1:T=1780419303:RT=1780419303:S=ALNI_MZ4-BAEWuNqOVvEvpXY6BolPOCnNQ; __eoi=ID=46fc9a3fb553965f:T=1780419303:RT=1780419303:S=AA-AfjYQmCr7BhMGIO7tgXqlTGh2; _ga_3CYFENTWD4=GS2.1.s1780419303$o1$g0$t1780419308$j55$l0$h0$djb57pfcF1dc1w7yFCFUqxRjZkcBs1oCbOw; FCCDCF=%5Bnull%2Cnull%2Cnull%2Cnull%2Cnull%2Cnull%2C%5B%5B32%2C%22%5B%5C%22bb65687a-e903-48ae-9b6d-fa41c705ce52%5C%22%2C%5B1780419307%2C43000000%5D%5D%22%5D%5D%5D; FCNEC=%5B%5B%22AKsRol87JcYOV_BQ4Tnlm_3-eUTOzHkROAX0kSGwG874u393i_sfsA9FmzKOgKSBSoH8ItevUYDuaZZ5Zy-HYMCwcCGyDyTh482vohXJv_xDSgPNDgmgeKy9EVSaK8npHgBE0Rj3MNjqvAMAZcXkElYiph8Tac6sTg%3D%3D%22%5D%5D",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://xmplaylist.com"
        }

        # impersonate="chrome" sends real browser TLS fingerprints to pass Cloudflare
        # Added verify=False to bypass your local self-signed certificate barrier
        response = requests.get(feed_url, headers=headers, timeout=15, verify=False)
        # Pass the legitimate browser cookies directly into the script execution
        #response = requests.get(feed_url, headers=headers, cookies=cj, timeout=15, verify=False)
        response.raise_for_status()      

        # Test if the response actually contains characters before parsing
        if not response.text.strip():
            print("Proxy returned an empty response.")
            return
        
        feed_data = response.json()
        #print(f"feed_data: {feed_data}")
        
        # Expecting a dictionary or list of recent tracks from the feed API
        # FIX 1: Extract tracks from the 'results' array key
        tracks = feed_data.get("results", [])
        # print(f"tracks: {tracks}")

        
        # Group incoming tracks by their station ID
        station_batches = {}
        for track_wrapper in tracks:
            # FIX 2: Identify the target station using the 'channelId' key
            station_id = track_wrapper.get("channelId")

            print(f"track_wrapper - station_id: {station_id}")
            if station_id in TRACKED_STATIONS:
                if station_id not in station_batches:
                    station_batches[station_id] = []
                station_batches[station_id].append(track_wrapper)

        # Append data to respective files
        for station, station_tracks in station_batches.items():
            filename = script_dir.parent / "xm.channels" / f"XM_{station}.json"
            
            # Ensure folder path exists
            filename.parent.mkdir(parents=True, exist_ok=True)
            
            # Convert raw tracks data back to a single flat line
            raw_line = json.dumps(station_tracks).replace('\n', '').replace('\r', '')
            
            # 1. Append the new data line
            with open(filename, "a", encoding="utf-8") as f:
                f.write(raw_line + "\n")
            
            # 2. Trim file back to bottom 40 lines
            with open(filename, "r", encoding="utf-8") as f:
                lines = f.readlines()
            
            truncated_lines = lines[-500:]
            
            with open(filename, "w", encoding="utf-8") as f:
                f.writelines(truncated_lines)
                
        print("Successfully distributed feed and trimmed active files.")
        
    except Exception as e:
        print(f"Failed to pull or process feed: {e}")

def update_station_logs():
    for station, url in STATIONS.items():
        # Go up one level (..) and down into 'xm.channels'
        filename = script_dir.parent / "xm.channels" / f"XM_{station}.json"
        print(f"Fetching data for {station}...")
        
        try:
            # Fetch data with a standard timeout
            response = requests.get(url, timeout=10, verify=False)
            response.raise_for_status()
            # data = response.json()
            
           
            # Ensure we got text data back
            if not response.text.strip():
                print(f"Empty response returned for {station}.")
                continue
                
            # 1. Append the new raw payload line
            with open(filename, "a", encoding="utf-8") as f:
                raw_line = response.text.replace('\n', '').replace('\r', '')
                f.write(raw_line + "\n")
            
            # 2. Open the file to read, trim to last 40 lines, and overwrite
            with open(filename, "r", encoding="utf-8") as f:
                lines = f.readlines()
            
            # Slice the list to keep only the last 40 elements
            # truncated_lines = lines[-1440:] # 1440 = 5 days * 24 hours * 60 min / 5 min intervals
            truncated_lines = lines[-100:] # 500 - 288 per day. 864 per 3 days
            
            with open(filename, "w", encoding="utf-8") as f:
                f.writelines(truncated_lines)
                    
            print(f"Successfully appended data and trimmed {filename} to {len(truncated_lines)} lines.")
            
        except requests.exceptions.RequestException as e:
            print(f"Network error updating {station}: {e}")
        except json.JSONDecodeError:
            print(f"Invalid JSON returned from {station}")
        except Exception as e:
            print(f"Unexpected error with {station}: {e}")

def update_station_logs2():
    # Your worker base URL
    PROXY_BASE = "https://xmplaylist.detmer14.workers.dev"
    for station, url in STATIONS.items():
        # Simply glue your worker URL to the front of your existing dictionary URLs
        proxied_url = f"https://xmplaylist.detmer14.workers.dev/{url}"
        # Go up one level (..) and down into 'xm.channels'
        filename = script_dir.parent / "xm.channels" / f"XM_{station}.json"
        print(f"Fetching data for {station}...")
        
        try:
            # Fetch data with a standard timeout
            response = requests.get(proxied_url, timeout=10, verify=False)
            response.raise_for_status()
            # data = response.json()
            
           
            # Ensure we got text data back
            if not response.text.strip():
                print(f"Empty response returned for {station}.")
                continue
                
            # 1. Append the new raw payload line
            with open(filename, "a", encoding="utf-8") as f:
                raw_line = response.text.replace('\n', '').replace('\r', '')
                f.write(raw_line + "\n")
            
            # 2. Open the file to read, trim to last 40 lines, and overwrite
            with open(filename, "r", encoding="utf-8") as f:
                lines = f.readlines()
            
            # Slice the list to keep only the last 40 elements
            # truncated_lines = lines[-1440:] # 1440 = 5 days * 24 hours * 60 min / 5 min intervals
            truncated_lines = lines[-100:] # 500 - 288 per day. 864 per 3 days
            
            with open(filename, "w", encoding="utf-8") as f:
                f.writelines(truncated_lines)
                    
            print(f"Successfully appended data and trimmed {filename} to {len(truncated_lines)} lines.")
            
        except requests.exceptions.RequestException as e:
            print(f"Network error updating {station}: {e}")
        except json.JSONDecodeError:
            print(f"Invalid JSON returned from {station}")
        except Exception as e:
            print(f"Unexpected error with {station}: {e}")

import time

if __name__ == "__main__":
    print("Starting XM Playlist History Logger. Press Ctrl+C to exit.")
    
    while True:
        try:
            update_global_feed()
        except Exception as e:
            # Prevent a critical top-level failure from killing the infinite loop
            print(f"Loop encountered an unexpected error: {e}")
            
        print("Waiting 5 minutes before the next pull...\n")
        time.sleep(10 * 60)  # 300 seconds = 5 minutes
