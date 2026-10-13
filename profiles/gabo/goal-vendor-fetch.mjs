/**
 * Maintainer-only acquisition helper for the goal vendor (materialization step M2).
 *
 * This is the ONE place that speaks to the registry, and it is only reachable
 * through the vendorizer's explicit `acquire` subcommand: acquisition happens
 * once, in the vendoring PR, verifying the pinned integrity. User installs never
 * load this module — they materialize from the in-tree tarballs (M1) with no
 * network at all.
 *
 * Boundary: it writes nothing; the caller verifies the bytes against the frozen
 * integrity and only then persists them.
 */
import https from "node:https"

const REGISTRY = "https://registry.npmjs.org"
const MAX_BYTES = 64 * 1024 * 1024

function registryPath(name) {
  return name.startsWith("@") ? `${name.split("/")[0]}%2f${name.split("/")[1]}` : name
}

export function goalVendorTarballUrl(pkg) {
  const name = pkg.registryName ?? pkg.name
  return `${REGISTRY}/${registryPath(name)}/-/${name.split("/").at(-1)}-${pkg.version}.tgz`
}

/** Download one pinned tarball into memory. Never used by an install path. */
export function download(pkg) {
  const url = goalVendorTarballUrl(pkg)
  if (/[/\\]\.\.|^file:/i.test(url)) throw new Error(`refusing an unsafe acquisition url: ${url}`)
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 60_000 }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400) {
        response.resume()
        reject(new Error(`refusing to follow a redirect for ${pkg.name}@${pkg.version}: ${String(response.headers.location)}`))
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`acquisition of ${pkg.name}@${pkg.version} failed with status ${status}`))
        return
      }
      const chunks = []
      let total = 0
      response.on("data", (chunk) => {
        total += chunk.length
        if (total > MAX_BYTES) {
          request.destroy(new Error(`acquisition of ${pkg.name}@${pkg.version} exceeded ${MAX_BYTES} bytes`))
          return
        }
        chunks.push(chunk)
      })
      response.on("end", () => resolve(Buffer.concat(chunks)))
      response.on("error", reject)
    })
    request.on("timeout", () => request.destroy(new Error(`acquisition of ${pkg.name}@${pkg.version} timed out`)))
    request.on("error", reject)
  })
}
