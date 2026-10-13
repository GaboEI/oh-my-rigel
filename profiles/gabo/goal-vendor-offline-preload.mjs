/**
 * QA preload that makes the process networkless.
 *
 * The offline contract of PR A is that a user install materializes the vendored
 * goal engine without touching the registry. Proving that needs a process where
 * any DNS or TCP attempt fails, so the proof cannot pass by accident: this
 * preload turns every name resolution and socket connection into a loud error.
 *
 * Usage (QA only, never part of an install or a runtime path):
 *   node --import ./profiles/gabo/goal-vendor-offline-preload.mjs <script>
 */
import dns from "node:dns"
import net from "node:net"

function refuse(what) {
  return () => {
    throw new Error(`offline proof violated: refused ${what}`)
  }
}

net.Socket.prototype.connect = function connect() {
  throw new Error("offline proof violated: refused a TCP connection")
}
net.connect = refuse("net.connect")
net.createConnection = refuse("net.createConnection")
dns.lookup = refuse("dns.lookup")
dns.resolve = refuse("dns.resolve")
dns.promises.lookup = refuse("dns.promises.lookup")
dns.promises.resolve = refuse("dns.promises.resolve")
