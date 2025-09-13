import 'dotenv/config';
import { getUserByLogin } from '#relics/helix.mjs';

const login = process.env.TWITCH_BROADCASTER || 'bagotrix';
const u = await getUserByLogin(login);
console.log('helix /users ->', u?.id, u?.display_name);
process.exit(0); // <- ensure the process ends
