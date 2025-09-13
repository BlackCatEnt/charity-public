// mind/time.mjs
export function nowInfo() {
  const tz = process.env.TIMEZONE || 'America/New_York';
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year:'numeric', month:'short', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:true
  });
  return {
    tz,
    iso: d.toISOString(),
    pretty: fmt.format(d)
  };
}
