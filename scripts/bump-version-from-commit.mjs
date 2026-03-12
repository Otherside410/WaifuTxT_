import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const commitMsgPath = process.argv[2]

if (!commitMsgPath) {
  console.error('[version:auto] Aucun fichier de message de commit fourni.')
  process.exit(1)
}

const rawMessage = readFileSync(commitMsgPath, 'utf8')
const firstLine = (rawMessage.split('\n')[0] || '').trim()

let bumpType = 'patch'

const isBreaking =
  /BREAKING CHANGE:/i.test(rawMessage) ||
  /^[a-z]+(\([^)]+\))?!:/i.test(firstLine)

if (isBreaking) {
  bumpType = 'major'
} else if (/^feat(\([^)]+\))?:/i.test(firstLine)) {
  bumpType = 'minor'
}

console.log(`[version:auto] Commit: "${firstLine}" -> bump ${bumpType}`)

execSync(`npm version ${bumpType} --no-git-tag-version`, {
  stdio: 'inherit',
})

execSync('git add package.json package-lock.json', {
  stdio: 'inherit',
})
