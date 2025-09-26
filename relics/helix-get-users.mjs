import 'dotenv/config';
import { getUserByLogin } from '#relics/helix.mjs';

// Only accept valid Twitch logins (letters, numbers, underscores)
const args = process.argv.slice(2).filter(x => /^[A-Za-z0-9_]{3,25}$/.test(x));

if (!args.length) {
  console.log('Usage: node relics/helix-get-users.mjs <login1> <login2> ...');
  process.exit(0);
}

for (const login of args) {
  try {
    const u = await getUserByLogin(login);
    console.log(`${login} -> ${u?.id || 'NOT FOUND'}`);
  } catch (e) {
    console.error(`${login} ! ${e.message || e}`);
  }
}
