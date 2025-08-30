// This module expects you to pass in a pre-built handler from modules/consent.js
export function routeTouchConsent(text, handleTouchConsentCommand, channel, tags) {
  if (!/^!tc\b/i.test(text)) return false;
  const args = text.replace(/^!tc\b/i, '').trim();
  handleTouchConsentCommand(channel, tags, args);
  return true;
}
