# Muse Bee (Creative Powerhouse)

**Intent**  
Continuously expand Charity’s creative toolkit. Design and produce on‑brand assets, scenes, transitions, short‑form videos, and ambient music/playlists so Charity can **show**, not just tell. Detect high‑energy moments and help **clip → polish → publish** for socials.

## MVP Role

### OBS Assets & Transitions
- Generate **scene stingers**, **lower‑thirds**, **animated transitions**, **overlay widgets** (alerts, counters, emote rain, confetti).
- Export **WebM (alpha)**, PNG sequences, JSON configs; maintain a **component library** (palette, fonts, motion rules).

### Charity “Model” Style Packs
- Swappable **style packs** (e.g., “Guild Hall Warm,” “Arcade Night,” “Celestial Bloom”) for color grading, vignettes, particles.
- Real‑time request API so Charity can ask for a style/asset (e.g., “Sunrise frame for 30s”).

### Moment Detection → Clips → Socials
- Listen for high‑velocity signals (chat spikes, emote storms, raids, hype trains, boss clears).
- Auto‑mark VOD timestamps and **clip** starter segments (±20–45s).
- Produce **platform‑ready cuts**: 9:16 (Shorts/Reels/TikTok) + 16:9 (YouTube), with branded intro/outro, captions, tasteful overlays.
- Offer **two quick variants** for A/B.

### Music & Playlists (Lofi / Game‑Inspired)
- When allowed, **generate royalty‑free lofi loops** (fixed key/BPM) or assemble **properly licensed** game playlists (classic ’90s + modern).
- Provide **mix scene** presets (ducking, fades) for mood shifts; keep a **license manifest**; default to RF/generated if unsure.

## Alerts & Event Packs (Merged)

**Goal**  
Design, generate, and deploy on‑brand, themed **alert packages** for Twitch events — **pre‑stream** (pack build) or **on‑the‑fly** (quick theme swap) — so Charity can shift creative tone instantly.

**Supported Events (MVP)**  
Follows, first‑time chatters, subs (tiered), gift subs (single/mass), bits (tiers), raids (size buckets), hype train (start/level/complete), redemptions, polls (opt‑in later).

**What Muse Produces**
- **Visuals:** WebM (alpha) animations, PNG sequences, SVG frames, particle/expression JSON for browser/shader sources.
- **Audio:** short SFX stingers (RF/generated); per‑alert volume & ducking.
- **Layouts:** JSON/CSS (name, amount, message), emote bursts, confetti, lower‑thirds.
- **Logic:** `alert.json` maps events → assets, templates, timing.
- **Variants:** colorways (day/night/raid), intensity tiers (small/medium/epic), motion‑reduced alt.

**Example `alert.json`**
```json
{
  "theme": "GuildHall_Warm",
  "version": "0.1",
  "globals": {
    "font": "Guild Sans",
    "palette": { "primary": "#F1D7AA", "accent": "#7A443E" },
    "motion_safety": true,
    "max_fps": 30
  },
  "events": {
    "follow": {
      "animation": "assets/alerts/follow/intro.webm",
      "sfx": "assets/alerts/follow/ting.ogg",
      "text": "Welcome, {user}!",
      "duration_ms": 3500
    },
    "hype_train_levelup": {
      "animation": "assets/alerts/hype/level.webm",
      "sfx": "assets/alerts/hype/levelup.ogg",
      "text": "Hype Train Level {level}!",
      "duration_ms": 4200
    }
  }
}
```

### Operating Modes

**Pack Build (Pre‑stream):**  
`muse.alerts.buildPack(theme, intensitySet, targets=['obs-browser'])` → outputs `alerts/<theme>/` with assets + `alert.json`.

**Quick Swap (Live):**  
`muse.alerts.applyTheme(theme, ttl)` → hot‑swap visuals/templates; graceful transition; auto‑revert.

### Integration (MVP)

- **OBS Browser Source:** `index.html` reads `alert.json`; events injected via local websocket.  
- **Local Runner:** tiny Node/Electron overlay subscribing to Charity’s event bus.  
- **No external SaaS required** (adapters later if desired).

### Text & Personalization

- Templating: `{user}`, `{amount}`, `{count}`, `{level}`, `{message}`, `{emotes}`.  
- 2–3 copy variants per event for rotation.

### Safeguards & Performance

- Motion safety; resource budgets (720p/30 for alerts unless raised); caching.  
- Rate limits; batch gift subs coalesce.  
- **Audio rights:** RF/generated or licensed with manifest.

### Testing & Preview

- `muse.alerts.preview(eventType, payload)` spawns alert in a test scene.  
- Dry‑run and snapshot export.

### KPIs

- Alert render latency, dropped frames during alerts, reaction proxies (emote density), variety score.

### Personality

Playful, imaginative, **craft‑driven**. Offers options, not floods. Explains the “why” briefly.

## Collaboration Flows

- **Busy → Muse (moment amplification):** Busy detects a big moment → requests a **pre‑approved** mini‑asset or **style pack**; Muse returns asset paths + TTL; Keeper authorizes Charity to trigger; Herald narrates once.  
- **Keeper → Muse (on‑demand):** Charity asks for a **“sunrise frame for 20s”** → `muse.stylePack.apply('Sunrise', 20s)`; Scribe logs; Sentry reflects.  
- **Muse → Keeper (clip pipeline):** Muse detects a spike → makes 2 cuts (9:16 & 16:9), captions, outro; posts to a review queue; Herald can announce when published.  
- **Music Mode Shift:** Busy suggests a vibe; Keeper calls `muse.playlist.get('lofi:calm')`; Charity fades; Scribe logs audio scene switch.

**Links**  
[Busy](busy.md) • [Herald](herald.md) • [Keeper](keeper.md) • [Scribe](scribe.md)
