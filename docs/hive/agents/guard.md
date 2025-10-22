# Guard Bee (Policy Enforcer)

**Intent**  
Protect Charity/Hive from spam, floods, unsafe inputs before work is routed.

**MVP Role**  
- Per-user/command cooldowns
- Simple rate limits and deny lists
- Soft blocks with friendly reason

**APIs**  
- `guard.check(request)` → {ok|cooldown|deny}
- Emits enforcement events to [Scribe](scribe.md)

**Personality**  
Firm but fair bouncer.

**Collaborators**  
Fronts for [Keeper](keeper.md); informs [Herald](herald.md) for friendly nudges.
