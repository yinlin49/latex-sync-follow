// Release metadata for a tag: checks that it matches package.json and prints the CHANGELOG section.
// Usage: node scripts/release-info.mjs <tag> [--notes <out.md>]
// Writes version / prerelease to $GITHUB_OUTPUT when it runs in GitHub Actions.
import fs from 'node:fs'

const SEMVER_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

const [tag, flag, notesFile] = process.argv.slice(2)
const match = SEMVER_TAG.exec(tag ?? '')
if (!match) {
    console.error(`"${tag}" is not a vMAJOR.MINOR.PATCH[-prerelease] tag`)
    process.exit(1)
}
const version = match[1]
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
if (pkg.version !== version) {
    console.error(`tag ${tag} does not match package.json version ${pkg.version}`)
    process.exit(1)
}
const prerelease = version.includes('-')

if (flag === '--notes') {
    // the "## [x.y.z]" section of CHANGELOG.md, up to the next version heading
    const changelog = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : ''
    const lines = changelog.split(/\r?\n/)
    const start = lines.findIndex(l => l.startsWith(`## [${version}]`))
    let section = ''
    if (start >= 0) {
        const end = lines.findIndex((l, i) => i > start && /^## \[/.test(l))
        section = lines
            .slice(start + 1, end < 0 ? lines.length : end)
            .join('\n')
            .trim()
    }
    fs.writeFileSync(notesFile, section || `No CHANGELOG.md entry for ${version}; see the commits below.`)
}
if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`)
}
console.log(`${tag}: version ${version}${prerelease ? ' (prerelease)' : ''}`)
