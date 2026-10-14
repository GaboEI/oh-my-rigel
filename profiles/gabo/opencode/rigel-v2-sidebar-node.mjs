/**
 * V2 materializer for the Oh My Rigel sidebar.
 *
 * The V1 sidebar rendered a renderer-agnostic IR (`ViewNode[]` from
 * `buildViewNodes`) into `@opentui/solid` elements. OpenCode V2 exposes the same
 * OpenTUI Solid runtime to CLI plugins, so this module is the faithful port of
 * the V1 materializer:
 *   packages/omo-opencode/src/tui.ts:49-70   (`materialize` / `materializeNode`)
 *   packages/omo-opencode/src/features/tui-sidebar/element-helpers.ts  (`box` / `text`)
 *
 * The slot `render` must return a HOST NODE, never text: a plain string makes the
 * V2 host fail to mount the slot. The `SolidRuntime` is injected so the pure tree
 * is unit-testable without a live renderer.
 */

/**
 * Build a root column box and materialize every node into it (V1 `materialize`).
 * @param {readonly object[]} nodes
 * @param {SolidRuntime} solid
 */
export function materialize(nodes, solid) {
  const root = solid.createElement("box")
  solid.setProp(root, "flexDirection", "column")
  for (const node of nodes) {
    solid.insert(root, materializeNode(node, solid))
  }
  return root
}

/** Materialize one IR node into a host element (V1 `materializeNode`). */
export function materializeNode(node, solid) {
  const element = solid.createElement(node.kind)
  for (const [name, value] of Object.entries(node.props)) {
    solid.setProp(element, name, value)
  }
  if (node.kind === "text") {
    solid.insert(element, node.text ?? "")
  }
  for (const child of node.children ?? []) {
    solid.insert(element, materializeNode(child, solid))
  }
  return element
}

/**
 * Collect the plain text carried by a materialized tree. A test aid only: real
 * `@opentui/solid` elements are opaque, so tests inject a stub runtime that
 * records props/children, and this walks that record.
 */
export function nodeText(node) {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  const own = typeof node.text === "string" ? node.text : ""
  const children = Array.isArray(node.children) ? node.children.map(nodeText) : []
  return [own, ...children].filter(Boolean).join("\n")
}

/**
 * @typedef {object} SolidRuntime
 * @property {(tag: string) => unknown} createElement
 * @property {(node: unknown, name: string, value: unknown) => unknown} setProp
 * @property {(parent: unknown, child: unknown) => unknown} insert
 */
