// WolfBot lives in bot.js (the entry point the platform validator scans for
// `class … extends Bot`). This re-export keeps tests importing a stable,
// side-effect-free module path.

export { WolfBot } from '../bot.js'
