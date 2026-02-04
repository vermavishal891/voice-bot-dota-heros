# Dota2 Voice Chat (GitHub Pages)

Single-page app that loads the scraped Dota2 hero voice lines and replies to user messages by selecting a *random-ish* matching line.

## Data
Source folder: `../dota2-voice-lines/`

Build combined index:

```bash
node build_index.js
```

This writes: `docs/data/voice_index.json`

## Serve locally

```bash
cd dota2-voice-app
node build_index.js
python3 -m http.server 5173 --directory docs
```

Open: http://localhost:5173

## Deploy

Publish the `docs/` folder via GitHub Pages (branch: `main`, folder: `/docs`).
