/** @typedef {{
  hall: 'twitch'|'discord',
  roomId: string,
  userId: string,
  userName: string,
  text: string,
  ts: number,
  meta?: Record<string,any>
}} UnifiedEvent */

export const toUnified = (hall, raw) => ({ /* map raw → UnifiedEvent */ });
