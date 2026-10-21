/**
 * The engine package this edition runs.
 *
 * It is pinned by the owning manifests: `packages/omo-senpi/package.json` declares it as an
 * optional peer plus a dev dependency, and `packages/omo-native/package.json` - the published
 * `omo-ai` edition - declares it as a runtime dependency. The engine therefore lives in the
 * dependency tree of whoever installed it, never at a path a source checkout happens to own, so
 * the launcher resolves it from that dependency instead of naming one.
 */
export const SENPI_ENGINE_PACKAGE = "@code-yeongyu/senpi"

/** How many parent directories the resolver walks up from a search path. */
const MAX_ANCESTOR_DEPTH = 12

export interface SenpiEngineSearchContext {
  /** The installed plugin tree. */
  readonly pluginPath: string
  /** The tree the plugin was installed from. */
  readonly repoRoot: string
}

/**
 * The directories the launcher walks up when it resolves the engine.
 *
 * The engine lives in the dependency tree of whoever installed the plugin, so the plugin tree and
 * the tree it was installed from are the roots that can hold it. The paths are baked into the
 * launcher because the tree that carries the engine is not reachable from the launcher's own
 * directory: the launcher lives in the user's PATH directory, the engine in a project tree.
 */
export function senpiEngineSearchPaths(context: SenpiEngineSearchContext): readonly string[] {
  const paths: string[] = []
  for (const path of [context.pluginPath, context.repoRoot]) {
    if (paths.includes(path)) continue
    paths.push(path)
  }
  return paths
}

/**
 * The resolver the generated launcher embeds verbatim.
 *
 * The launcher resolves the engine when it starts, not when it is installed: a packed plugin tree
 * ships the plugin artifacts only, without the dependency tree the engine lives in, so an install
 * that demanded the engine would refuse a payload that is complete on its own. The rules live here
 * so the installer and the launcher cannot drift apart: the launcher embeds this source, and the
 * resolver walks the same paths, prefers the same CLI entry, and reports the same pinned version.
 *
 * The source is JavaScript, not TypeScript, because the launcher is generated at install time and
 * has to run on its own: it cannot import the module this constant comes from. It therefore uses
 * the file-system and path helpers the launcher imports.
 */
export const SENPI_ENGINE_RUNTIME_SOURCE = `function senpiEngineIsExactVersion(spec) {
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(spec);
}

function senpiEngineRuntime(options) {
  const enginePackage = ${JSON.stringify(SENPI_ENGINE_PACKAGE)};
  const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
  const maxAncestorDepth = ${MAX_ANCESTOR_DEPTH};

  function readJson(path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  function ancestors(startPath) {
    const directories = [];
    let current = resolve(startPath);
    const root = parse(current).root;
    for (let depth = 0; depth < maxAncestorDepth; depth += 1) {
      directories.push(current);
      if (current === root) return directories;
      current = dirname(current);
    }
    return directories;
  }

  // The engine package under one of the search paths, found by walking up to the dependency tree.
  function enginePackageRoot(searchPaths) {
    for (const searchPath of searchPaths) {
      for (const directory of ancestors(searchPath)) {
        const candidate = join(directory, "node_modules", enginePackage);
        if (existsSync(join(candidate, "package.json"))) return candidate;
      }
    }
    return undefined;
  }

  // The engine CLI: the pre-linked bundle the engine ships, else its unbundled entry.
  function engineCli(packageRoot) {
    const candidates = [join(packageRoot, "dist", "bundle", "cli.js"), join(packageRoot, "dist", "cli.js")];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  // The engine package that owns an explicit CLI path, found by walking up to its manifest.
  function owningPackageRoot(cliPath) {
    for (const directory of ancestors(dirname(resolve(cliPath)))) {
      const manifest = readJson(join(directory, "package.json"));
      if (manifest === undefined || manifest.name !== enginePackage) continue;
      return directory;
    }
    return undefined;
  }

  function engineVersion(packageRoot) {
    const manifest = readJson(join(packageRoot, "package.json"));
    return manifest !== undefined && typeof manifest.version === "string" ? manifest.version : undefined;
  }

  // The version the nearest declaring manifest pins, read from the manifest that declares it.
  function pinnedVersion(searchPaths) {
    for (const searchPath of searchPaths) {
      for (const directory of ancestors(searchPath)) {
        const manifest = readJson(join(directory, "package.json"));
        if (manifest === undefined) continue;
        for (const field of dependencyFields) {
          const declared = manifest[field];
          if (declared === null || typeof declared !== "object" || Array.isArray(declared)) continue;
          const spec = declared[enginePackage];
          if (typeof spec === "string") return spec;
        }
      }
    }
    return undefined;
  }

  function describePaths(paths) {
    return paths.length === 0 ? "(no search path)" : paths.join(", ");
  }

  const searchPaths = options.searchPaths;
  const pinned = pinnedVersion(searchPaths);
  const override = (options.env.OMO_SENPI_CLI_PATH || "").trim();
  if (override.length > 0) {
    if (!existsSync(override)) {
      return {
        error: "the senpi engine override OMO_SENPI_CLI_PATH points at " + override + ", which does not exist; " +
          "point it at the installed " + enginePackage + " CLI or unset it so the pinned engine is used",
      };
    }
    const owner = owningPackageRoot(override);
    const version = owner === undefined ? undefined : engineVersion(owner);
    return {
      cliPath: override,
      packageRoot: owner,
      version,
      pinnedVersion: pinned,
      mismatch: pinned !== undefined && version !== undefined && senpiEngineIsExactVersion(pinned) && version !== pinned,
      source: "override",
    };
  }

  const packageRoot = enginePackageRoot(searchPaths);
  if (packageRoot === undefined) {
    return {
      error: "no " + enginePackage + " engine is installed: the launcher looked for node_modules/" + enginePackage +
        " under " + describePaths(searchPaths) + ". Install the pinned engine (" +
        (pinned === undefined ? "bun add " + enginePackage : "bun add " + enginePackage + "@" + pinned) + ") " +
        "or point OMO_SENPI_CLI_PATH at an existing senpi CLI",
    };
  }
  const cliPath = engineCli(packageRoot);
  if (cliPath === undefined) {
    return {
      error: "the " + enginePackage + " engine at " + packageRoot + " ships no CLI: expected dist/bundle/cli.js or dist/cli.js",
    };
  }
  const version = engineVersion(packageRoot);
  // A differently versioned engine is a different engine, but the install is not broken by it: the
  // consumer legitimately carries its own engine, so the launcher warns and starts it anyway.
  const mismatch = pinned !== undefined && version !== undefined && senpiEngineIsExactVersion(pinned) && version !== pinned;
  return {
    cliPath,
    packageRoot,
    version,
    pinnedVersion: pinned,
    mismatch,
    source: "dependency",
  };
}
`
