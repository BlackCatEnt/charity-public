
# Twitch Auth, Scopes & Recovery

## Required Scopes
- The bot requires **chat:read** and **chat:edit**. The code validates scopes at startup and exits if missing. 

## Startup Flow (Preflight)
1) Merge environment values into saved token state.  
2) Prefer an existing access token; validate it.  
3) If invalid/expiring soon, refresh before connecting.  
4) Persist any new `expires_at`.  
5) Connect to IRC (tmi.js) with `oauth:<token>`. 

## Runtime Refresh Strategy
- A periodic token check runs after connect; if the token is near expiry or invalid, a refresh is attempted.  
- Sensitive notices are sent via **whisper** first, with public fallback only if needed (configurable).  
*(Your latest working copy uses `whisper(...)` for these notices; earlier uploads still showed `whisperOrSay(...)`.)*

## Emergency Steps
- If refresh fails at startup, the process exits early to avoid flapping. 
- If a runtime refresh fails, the bot whispers a failure message and keeps the operator informed to take manual action (rotate tokens, check client credentials).
- Ensure `.env` has:
  - `TWITCH_CLIENT_ID`
  - `TWITCH_CLIENT_SECRET`
  - `TWITCH_REFRESH` (refresh token)
  - (Optional) `TWITCH_OAUTH` for a bootstrap access token

//Notes 
“whisper first, public fallback only if needed” as implemented (was planned in the roadmap)