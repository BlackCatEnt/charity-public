// modules/ads.js
import fetch from 'node-fetch';
const API = 'https://api.twitch.tv/helix';

async function j(res, label) {
  if (!res.ok) throw new Error(`${label} ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getAdSchedule({ clientId, accessToken, broadcasterId }) {
  const url = `${API}/channels/ads?broadcaster_id=${broadcasterId}`;
  const res = await fetch(url, { headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${accessToken}` } });
  const data = (await j(res, 'getAdSchedule')).data?.[0] ?? null;
  return data; // { next_ad_at, last_ad_at, duration, preroll_free_time, snooze_count, snooze_refresh_at }
}

export async function snoozeNextAd({ clientId, accessToken, broadcasterId }) {
  const url = `${API}/channels/ads/schedule/snooze?broadcaster_id=${broadcasterId}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${accessToken}` } });
  return (await j(res, 'snoozeNextAd')).data?.[0] ?? null;
}

export async function startCommercial({ clientId, accessToken, broadcasterId, length = 60 }) {
  const res = await fetch(`${API}/channels/commercial`, {
    method: 'POST',
    headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ broadcaster_id: broadcasterId, length })
  });
  return (await j(res, 'startCommercial')).data?.[0] ?? null; // { length, message, retry_after }
}
