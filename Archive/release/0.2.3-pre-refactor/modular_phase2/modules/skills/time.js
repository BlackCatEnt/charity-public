// modules/skills/time.js
export function describeNow(tz = process.env.BROADCASTER_TZ || 'America/Los_Angeles') {
  const now = new Date(); // if you track TZ offset, apply here
  const day  = now.toLocaleDateString('en-US', { weekday: 'long' });
  const date = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${date} — ${time}`;
}
