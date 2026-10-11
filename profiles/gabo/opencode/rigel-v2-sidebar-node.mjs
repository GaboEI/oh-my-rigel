/**
 * V2 port of the V1 sidebar render materializer.
 *
 * Fidelity source (V1, byte-for-byte behaviour):
 *   packages/omo-opencode/src/tui.ts:49-70
 *     function materialize<Node>(nodes: readonly ViewNode[], solid: SolidRuntime<Node>): Node
 *     function materializeNode<Node>(node: ViewNode, solid: SolidRuntime<Node>): Node
 *   packages/omo-opencode/src/features/tui-sidebar/element-helpers.ts  (ViewNode, box, text)
 *   packages/omo-opencode/src/features/tui-sidebar/render-view.ts:25  (buildViewNodes)
 *
 * The V1 flow is `buildViewNodes(view, theme) -> ViewNode[] -> materialize() ->
 * @opentui/solid elements`; `describeView` was dead code on the render path.
 * `SolidRuntime` is exactly the `@opentui/solid` module surface
 * (`createElement` / `insert` / `setProp`), so the port is the host-compatible
 * V2 path and needs no JSX transform.
 */

/** Build a root column box and materialize every node into it (V1 `materialize`). */
export function materialize(nodes, solid) {
  const root = solid.createElement("box")
  solid.setProp(root, "flexDirection", "column")
  for (const node of nodes) {
    solid.insert(root, materializeNode(node, solid))
  }
  return root
}

/** Materialize one `ViewNode` into a host element (V1 `materializeNode`). */
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
 * Collect the plain text carried by a materialized tree. A test aid only: the
 * real `@opentui/solid` elements are opaque, so tests inject a stub runtime that
 * records props/children, and this walks that record.
 */
export function nodeText(node) {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  const own = typeof node.text === "string" ? node.text : ""
  const children = Array.isArray(node.children) ? node.children.map(nodeText) : []
  return [own, ...children].filter(Boolean).join("\n")
}
