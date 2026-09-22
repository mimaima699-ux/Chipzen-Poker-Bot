// Assemble the upload package: raw SOURCE zip for the sandboxed upload path.
//
// The platform sandbox blocks `net`/`tls` requires (so the ws-based bundle
// fails its import scan) and its validator greps the entry point for a class
// literally extending `Bot` (so an esbuild bundle fails bot_class). The
// source zip ships:
//
//   bot.js            entry point (reads CHIPZEN_WS_URL / CHIPZEN_TOKEN)
//   src/**            engine + adapter + tracker + WolfBot
//   package.json      declares @chipzen-ai/bot (platform resolves it)
//   README.md
//
//   wolf-bot.zip      the upload artifact
//
// The esbuild bundle (dist/bot.js) remains available for the Docker/external
// deployment paths where raw sockets are allowed.

import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = join(root, 'pkg')
const zip = join(root, 'wolf-bot.zip')

rmSync(pkg, { recursive: true, force: true })
mkdirSync(join(pkg, 'src'), { recursive: true })

cpSync(join(root, 'bot.js'), join(pkg, 'bot.js'))
cpSync(join(root, 'src'), join(pkg, 'src'), { recursive: true })
cpSync(join(root, 'README.md'), join(pkg, 'README.md'))

writeFileSync(
  join(pkg, 'package.json'),
  JSON.stringify(
    {
      name: 'wolf-bot',
      version: '1.0.0',
      description: "Equity-driven No Limit Hold'em bot — Chipzen Season 7",
      type: 'module',
      main: 'bot.js',
      engines: { node: '>=20' },
      dependencies: {
        '@chipzen-ai/bot': '^0.3.0',
      },
    },
    null,
    2,
  ) + '\n',
)

rmSync(zip, { force: true })
execSync('tar -a -c -f ../wolf-bot.zip bot.js src package.json README.md', {
  cwd: pkg,
  stdio: 'inherit',
})

const kb = (statSync(zip).size / 1024).toFixed(1)
console.log(`\nwolf-bot.zip written (${kb} KB)`)
execSync('tar -tf ../wolf-bot.zip', { cwd: pkg, stdio: 'inherit' })
console.log(`\nsource files: ${readdirSync(join(pkg, 'src'), { recursive: true }).length}`)
