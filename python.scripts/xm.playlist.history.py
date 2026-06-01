import os
import json
import requests
from datetime import datetime
from pathlib import Path

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

# Get the directory where your script is currently living
script_dir = Path(__file__).resolve().parent


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
                
            # Open file in append mode ('a')
            with open(filename, "a", encoding="utf-8") as f:
                # Clean up the raw string so it stays on exactly one line
                raw_line = response.text.replace('\n', '').replace('\r', '')
                
                # Write the raw payload followed by a single newline character
                f.write(raw_line + "\n")
                    
            print(f"Successfully appended raw data to {filename}")
                    
            print(f"Successfully appended data to {filename}")
            
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
            update_station_logs()
        except Exception as e:
            # Prevent a critical top-level failure from killing the infinite loop
            print(f"Loop encountered an unexpected error: {e}")
            
        print("Waiting 5 minutes before the next pull...\n")
        time.sleep(10 * 60)  # 300 seconds = 5 minutes
