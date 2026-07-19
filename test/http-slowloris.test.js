import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { createHttpServer } from "../src/http-server.js";

test("slow HTTP bodies are disconnected before provider routing", { timeout: 2000 }, async (t) => {
  let routeCalls = 0;
  const server = createHttpServer({
    bodyTimeoutMs: 30,
    route: async () => {
      routeCalls += 1;
      throw new Error("route must not be called");
    }
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address();
  const socket = net.createConnection({ host: "127.0.0.1", port });
  t.after(() => socket.destroy());
  await once(socket, "connect");

  socket.write([
    "POST /ask HTTP/1.1",
    "Host: 127.0.0.1",
    "Content-Type: application/json",
    "Content-Length: 100",
    "Connection: close",
    "",
    "{\"prompt\":\"partial"
  ].join("\r\n"));

  await once(socket, "close");
  assert.equal(routeCalls, 0);
});
