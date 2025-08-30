// modules/helix-auth.js
import { getBearer } from './token-manager.js';

export async function helixHeaders(kind = 'bot') {
  const bearer = await getBearer(kind); // auto-refresh if needed
  return {
    'Authorization': bearer,
    'Client-Id': process.env.TWITCH_CLIENT_ID,
    'Content-Type': 'application/json'
  };
}
