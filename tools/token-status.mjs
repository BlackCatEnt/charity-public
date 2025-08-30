import '../modular_phase2/env-bootstrap.js';
import { getAccessToken, getSummary } from '../modular_phase2/modules/token-manager.js';

// Hydrate/validate from .env and persist to data/token_state.json
await getAccessToken('bot').catch(()=>{});
await getAccessToken('broadcaster').catch(()=>{});

// Show a concise snapshot
console.log(JSON.stringify(await getSummary(), null, 2));
