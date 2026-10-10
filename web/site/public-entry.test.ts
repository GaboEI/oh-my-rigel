import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Public-entry identity contract. A newcomer who opens this repository must be sent to Oh My Rigel,
// never to the upstream OmO product. It guards the stable identifiers a reader acts on -- the official
// site URL, the install command, and the clone target -- not prose wording, so a future edit cannot
// silently advertise the parent product's homepage or its installer as this project's own. This file
// lives under web/site/ because the published web workflow gates on `bun test web/`: the contract must
// run in that gate, not only when a single file is invoked by hand.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const ENTRY_DOCS = ["README.md", "OH-MY-RIGEL.md", "FORK.md", "CONTRIBUTING.md", "web/README.md", "web/MAINTENANCE.md"]
const UPSTREAM_INSTALLER = "get.omo.dev/install.sh"
const UPSTREAM_REPO = "github.com/code-yeongyu/oh-my-openagent"
const OMR_SITE = "https://omr.gabodev.dev/"
const OMR_REPO = "github.com/GaboEI/oh-my-rigel"

type Docs = Record<string, string>
const readEntryDocs = (): Docs => Object.fromEntries(ENTRY_DOCS.map((rel) => [rel, readFileSync(join(REPO, rel), "utf8")]))
const docsOfferingUpstreamInstaller = (docs: Docs): string[] => Object.keys(docs).filter((rel) => docs[rel].includes(UPSTREAM_INSTALLER))
const docsCloningUpstreamRepo = (docs: Docs): string[] => Object.keys(docs).filter((rel) => docs[rel].includes(UPSTREAM_REPO))

describe("#given the public entry documentation #when its identity references are read #then it points at Oh My Rigel, not the upstream OmO product", () => {
  test("#given the root README #when the official site is read #then it is the Oh My Rigel custom domain", () => {
    // given / when / then
    expect(readEntryDocs()["README.md"]).toContain(OMR_SITE)
  })

  test("#given the entry docs #when the install commands are read #then the upstream OmO installer is never offered for Oh My Rigel", () => {
    // given / when / then
    expect(docsOfferingUpstreamInstaller(readEntryDocs())).toEqual([])
  })

  test("#given the contributor setup #when the documented clone target is read #then it clones this repository, not the upstream OmO repository", () => {
    // given
    const contributing = readEntryDocs()["CONTRIBUTING.md"]

    // when / then
    expect(contributing).toContain(OMR_REPO)
    expect(docsCloningUpstreamRepo({ "CONTRIBUTING.md": contributing })).toEqual([])
  })

  test("#given a fixture entry offering the upstream installer #when the guard runs #then it reports the offender (non-vacuous control)", () => {
    // given
    const fixture: Docs = { "README.md": "# Oh My Rigel\n\ncurl -fsSL https://get.omo.dev/install.sh | bash\n" }

    // when / then
    expect(docsOfferingUpstreamInstaller(fixture)).toEqual(["README.md"])
  })

  test("#given a fixture contributor guide cloning the upstream repo #when the guard runs #then it reports the offender (non-vacuous control)", () => {
    // given
    const fixture: Docs = { "CONTRIBUTING.md": "git clone --recurse-submodules https://github.com/code-yeongyu/oh-my-openagent.git\n" }

    // when / then
    expect(docsCloningUpstreamRepo(fixture)).toEqual(["CONTRIBUTING.md"])
  })
})
