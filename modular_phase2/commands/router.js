// commands/router.js
export function createRouter(cmds) {
  const map = new Map([
    ['me',         cmds.handleMe],
    ['privacy',    cmds.handlePrivacy],
    ['optin',      cmds.handleOptIn],
    ['optout',     cmds.handleOptOut],
    ['forgetme',   cmds.handleForgetMe],
    ['remember',   cmds.handleRemember],
    ['forgetfact', cmds.handleForgetFact],
    ['profile',    cmds.handleProfile],
    ['whoami',     cmds.handleWhoAmI],
    ['rules',      cmds.handleRules],
    ['ask',        cmds.handleAsk],
  ]);

  async function route({ channel, tags, message }) {
    if (!message || message[0] !== '!') return false;
    const [head, ...rest] = message.slice(1).trim().split(/\s+/);
    const cmd = (head || '').toLowerCase();
    const handler = map.get(cmd);
    if (!handler) return false;
    await handler(channel, tags, rest.join(' '));
    return true;
  }

  return { route };
}
