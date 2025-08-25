# Charity Bot — Modularization Phase 2

## Files
- `index.mod.js` — Slim main that wires modules + command router
- `modules/` — Services: config, logger, consent, timezone, roles, KB, persona, generator
- `commands/` — Commands: `ask`, `router`

## Run
From your project root (where `env-bootstrap.js` and `token.js` live):
```bash
node modular_phase2/index.mod.js
```

Ensure `config/charity-config.json` exists. Data files are stored in `./data`.
