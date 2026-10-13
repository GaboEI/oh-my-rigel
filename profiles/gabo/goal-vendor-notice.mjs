/**
 * Deterministic third-party NOTICE renderer for the vendored goal engine.
 *
 * The rendered text is a pure function of the frozen provenance (artifact pin +
 * closure manifest), so the shipped NOTICE can be regenerated and compared byte
 * for byte. Attribution — package, version, license, integrity, tarball path and
 * install path — never depends on locale, ordering or the filesystem.
 */

function line(label, value) {
  return `- ${label}: ${value}\n`
}

function artifactBlock(artifact) {
  let text = `## ${artifact.name} ${artifact.version}\n`
  text += line("role", "artifact (the vendored engine)")
  text += line("license", artifact.license)
  text += line("source", `npm tag ${artifact.tag} -> commit ${artifact.commit}`)
  text += line("integrity", artifact.distIntegrity)
  text += line("vendored tarball", artifact.tarball)
  text += line("sha256", artifact.tarballSha256)
  return `${text}\n`
}

function closureBlock(pkg) {
  let text = `## ${pkg.name} ${pkg.version}\n`
  text += line("role", pkg.role === "peer" ? "peer dependency (satisfied by the host TUI)" : "runtime dependency (self-contained)")
  text += line("license", pkg.license)
  text += line("integrity", pkg.integrity)
  text += line("vendored tarball", pkg.tarball)
  text += line("sha256", pkg.sha256)
  text += line("install path", pkg.installPath)
  if (typeof pkg.aliasOf === "string") text += line("npm alias of", pkg.aliasOf)
  return `${text}\n`
}

/**
 * Render the NOTICE for the pinned artifact and its closure. `closure` is sorted
 * by package name with a code-unit comparison (never `localeCompare`, which is
 * locale-dependent and would make the NOTICE irreproducible across environments).
 */
export function renderGoalVendorNotice(artifact, closure) {
  let text = "# Third-party notices: vendored community goal engine\n\n"
  text += "This file travels with the in-tree vendor of the community goal engine and is\n"
  text += "regenerated deterministically from `pin.json` plus the pinned tarballs. The\n"
  text += "vendorizer refuses to materialize a tree whose NOTICE does not match this output,\n"
  text += "and refuses a pin whose recorded integrity does not match the vendored bytes.\n\n"
  text += artifactBlock(artifact)
  for (const pkg of [...closure].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    text += closureBlock(pkg)
  }
  text += "The upstream MIT license text travels byte-identical in `LICENSE`.\n"
  return text
}

/** One deterministic heading per attributed package, used to verify coverage. */
export function noticeHeadingFor(pkg) {
  return `## ${pkg.name} ${pkg.version}`
}
