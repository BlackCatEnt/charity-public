# OBS WebSocket Bridge (Planned)

## Status
- **Not yet included in repo** (noted in roadmap). Use a separate “bridge” service to:
  - Connect to OBS WebSocket (v5)
  - Expose a tiny HTTP/IPC endpoint that Charity can call to trigger:
    - Scene switches
    - Filter toggles / source visibility
    - Quick overlays / stingers
- This keeps the bot process isolated from OBS concerns. 

## Minimal Design
- Bridge runs locally with:
  - `OBS_HOST`, `OBS_PORT`, `OBS_PASSWORD`
- Routes such as:
  - `POST /scene/switch { "name": "Gameplay" }`
  - `POST /source/show { "scene": "Gameplay", "source": "HypeOverlay" }`
  - `POST /source/hide { ... }`

## Event Wiring Ideas
- Trigger celebratory overlays on:
  - Raids, subs, gift bombs, first‑time chatters
  - “Hype”, “Clutch”, or “F in chat” keywords (Tier‑2 emotion hooks) 

## Future Work
- Add retry/backoff
- Small queue for rapid-fire triggers
- Map Charity’s “mood” to visual states
