// Network lane (NOT part of `web:check`): the blocking gate proves only that documented external
// links are approved, https and present in the build. This separate probe proves they actually
// answer, recording status, final URL (redirects) and the run date. The build never depends on it.
const URLS = [
  "https://github.com/GaboEI/oh-my-rigel/tree/v2-mirror",
  "https://github.com/GaboEI/oh-my-rigel/issues",
]

let failed = 0
console.log(`external-link probe ${new Date().toISOString()}`)
for (const url of URLS) {
  try {
    const response = await fetch(url, { redirect: "follow", method: "GET" })
    const redirected = response.url && response.url !== url ? ` -> ${response.url}` : ""
    console.log(`  ${response.status}  ${url}${redirected}`)
    if (response.status >= 400) failed += 1
  } catch (error) {
    console.log(`  ERROR  ${url}  ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}
console.log(failed === 0 ? "PASS verify-external-links.mjs" : `FAIL verify-external-links.mjs (${failed} unreachable)`)
process.exit(failed === 0 ? 0 : 1)
