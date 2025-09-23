import 'dotenv/config';
import { preflightRefresh } from '../modular_phase2/modules/token-manager.js';
import { helixGet } from '../modular_phase2/modules/helix-auth.js';

async function main() {
  await preflightRefresh(console); // ensures both identities are fresh enough
  const me = await helixGet('https://api.twitch.tv/helix/users','broadcaster',console);
  console.log(JSON.stringify(me?.data?.[0] || me, null, 2));
}
main().catch((e) => {
  console.error('[whoami] failed:', e?.message || e);
  process.exitCode = 1;
});
