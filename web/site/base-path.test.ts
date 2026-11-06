import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { buildSite } from "./build.mjs"
import { SITE } from "./lib/config.mjs"

const CUSTOM_DOMAIN = "omr.gabodev.dev"
const CUSTOM_ORIGIN = `https://${CUSTOM_DOMAIN}`
const outPath = fileURLToPath(SITE.outDir)

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
}

function readDist(rel: string): string {
  return readFileSync(join(outPath, rel), "utf8")
}

describe("#given the custom-domain web artifact #when it is built #then it serves from the domain root", () => {
  test("#given the configured site #when defaults are read #then the custom domain root is the publication contract", () => {
    // given / when / then
    expect(SITE.basePath).toBe("/")
    expect(SITE.origin).toBe(CUSTOM_ORIGIN)
  })

  test("#given the generated artifact #when SEO, language and asset references are inspected #then no project-path URL survives", async () => {
    // given
    await buildSite()

    // when
    const cnamePath = join(outPath, "CNAME")
    const robots = readDist("robots.txt")
    const sitemap = readDist("sitemap.xml")
    const rootHtml = readDist("index.html")
    const emittedFiles = collectFiles(outPath).filter((file) => /\.(html|css|js|xml|txt|json)$/.test(file))

    // then
    expect(existsSync(cnamePath)).toBe(true)
    expect(readFileSync(cnamePath, "utf8").trim()).toBe(CUSTOM_DOMAIN)
    expect(robots).toContain(`Sitemap: ${CUSTOM_ORIGIN}/sitemap.xml`)

    const sitemapLocs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    expect(sitemapLocs.length).toBeGreaterThan(0)
    expect(sitemapLocs.every((loc) => loc.startsWith(`${CUSTOM_ORIGIN}/`))).toBe(true)

    expect(rootHtml).toContain(`rel="canonical" href="${CUSTOM_ORIGIN}/en/"`)
    expect(rootHtml).toContain('href="/es/"')
    expect(rootHtml).toContain('href="/en/"')
    expect(rootHtml).toContain('src="/assets/catalog.js"')
    expect(rootHtml).toContain('href="/assets/styles.css"')

    for (const file of emittedFiles) {
      const content = readFileSync(file, "utf8")
      expect(content).not.toMatch(/(?:href|src)="\/oh-my-rigel\//)
      expect(content).not.toContain("https://gaboei.github.io/oh-my-rigel/")
    }
  })
})

describe("#given the moved site #when the legacy /oh-my-rigel/ base path is requested #then every known route redirects to its root URL and unknown paths still 404", () => {
  test("#given the artifact #when the legacy stubs are inspected #then each known route ships a 200 document pointing at the root URL", async () => {
    // given
    await buildSite()
    const manifest = JSON.parse(readDist("route-manifest.json"))

    // when
    const contentRoutes: string[] = manifest.routes.filter((route) => route !== "/404.html")

    // then
    expect(Array.isArray(manifest.legacyRedirects)).toBe(true)
    expect(manifest.legacyRedirects.length).toBe(contentRoutes.length)
    for (const route of contentRoutes) {
      const stubPath = join(outPath, `oh-my-rigel${route}`, "index.html")
      expect(existsSync(stubPath)).toBe(true)
      const html = readFileSync(stubPath, "utf8")
      const target = `${CUSTOM_ORIGIN}${route}`
      expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${target}">`)
      expect(html).toContain(`rel="canonical" href="${target}"`)
      expect(html).toContain('name="robots" content="noindex"')
      expect(html).toContain(`href="${target}"`)
    }
  })

  test("#given the legacy prefix #when an unknown path is requested #then there is no catch-all stub and no real page carries a meta refresh", async () => {
    // given
    await buildSite()

    // when
    const unknownStub = join(outPath, "oh-my-rigel", "does-not-exist", "index.html")
    // The legacy stubs live under `<out>/oh-my-rigel/`, matched with POSIX
    // separators regardless of the host that collected them.
    const realPages = collectFiles(outPath)
      .map((file) => file.split(sep).join("/"))
      .filter((file) => file.endsWith(".html") && !file.includes("/oh-my-rigel/"))

    // then
    expect(existsSync(unknownStub)).toBe(false)
    for (const file of realPages) {
      expect(readFileSync(file, "utf8")).not.toMatch(/http-equiv=["']refresh/i)
    }
  })
})
