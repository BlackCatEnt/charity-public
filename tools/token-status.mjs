// A:\Charity\tools\token-status.mjs
import 'dotenv/config';
import { getSummary } from '../modular_phase2/modules/token-manager.js';

function mask(s) { return s ? `${s.slice(0,4)}...${s.slice(-4)}` : ''; }

const bot = await getSummary('bot');
const broadcaster = await getSummary('broadcaster');

console.log(JSON.stringify({
  bot: {
    login: bot.login,
    user_id: bot.user_id,
    scopes: bot.scopes,
    expires_in_s: bot.expires_in_s,
    has_refresh: bot.has_refresh,
    access_masked: mask(bot.access_masked || '')
  },
  broadcaster: {
    login: broadcaster.login,
    user_id: broadcaster.user_id,
    scopes: broadcaster.scopes,
    expires_in_s: broadcaster.expires_in_s,
    has_refresh: broadcaster.has_refresh,
    access_masked: mask(broadcaster.access_masked || '')
  }
}, null, 2));
