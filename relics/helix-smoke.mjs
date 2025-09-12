import 'dotenv/config';
import { getUserByLogin, keepBroadcasterFresh } from '#relics/helix.mjs';

keepBroadcasterFresh(); // background refresh
const login = process.env.TWITCH_BROADCASTER || 'bagotrix';
const u = await getUserByLogin(login);
console.log('helix /users ->', u?.id, u?.display_name);
