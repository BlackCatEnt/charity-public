# Herald (Announcer)

**Intent**  
Turn system events into outward-facing updates (chat/Discord/overlay).

**MVP Role**  
- Listen for key events (route success/fail, cooldown, raid, hype train)
- Format messages with dynamic context
- Dispatch to one or more channels
- Suppress repeats; outbound cooldowns

**APIs**  
- `herald.say(channel, template, data)`
- `herald.schedule(message, at)` (lightweight)

**Personality**  
Town crier; showmanship without spam.

**Collaborators**  
Consumes from [Keeper](keeper.md)/[Scribe](scribe.md); voices shifts from [Muse](muse.md); respects [Guard](guard.md) cooldowns.
