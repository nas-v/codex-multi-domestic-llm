import test from "node:test";
import assert from "node:assert/strict";
import { classifyListenError } from "../src/http-server.js";

test("classifies HTTP listen failures", () => {
  assert.deepEqual(classifyListenError({ code: "EADDRINUSE" }), {
    code: "PORT_IN_USE", message: "HTTP 端口已被占用"
  });
  assert.deepEqual(classifyListenError({ code: "EACCES" }), {
    code: "PORT_PERMISSION_DENIED", message: "没有权限监听 HTTP 端口"
  });
  assert.deepEqual(classifyListenError({ code: "EPERM" }), {
    code: "PORT_PERMISSION_DENIED", message: "没有权限监听 HTTP 端口"
  });
  assert.equal(classifyListenError({ code: "UNKNOWN" }).code, "HTTP_LISTEN_ERROR");
});
