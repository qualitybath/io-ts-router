"use strict";

/*
 * Spec for validationRouter get/post/put/delete when the second argument is
 * an array of middleware (the Express RequestHandlerParams form).
 *
 * These tests fail while that array is treated as an io-ts schema and its
 * functions are never registered. They pass once those functions are handed
 * to the underlying router and actually run for the request.
 *
 * These tests fail on purpose until the vulnerability is fixed.
 *
 *   yarn install --frozen-lockfile
 *   yarn build
 *   mkdir -p /tmp/io-ts-router-peers
 *   npm install --prefix /tmp/io-ts-router-peers fp-ts@2.16.2
 *   NODE_PATH=/tmp/io-ts-router-peers/node_modules node --test test/middleware-array-discarded.test.js
 *
 * fp-ts is the peer required to load io-ts@2.2.10 and io-ts-reporters@1.2.2.
 * It is not in the lockfile. Install it outside node_modules. Putting it in
 * node_modules makes tsc fail on src/index.ts.
 *
 * patch, all, use, head, options, and router.route() are not wrapped by
 * validationRouter and are not covered here.
 */

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const validationRouter = require("..").default;

const METHODS = ["get", "post", "put", "delete"];

function guard(trace) {
  return function requireAuth(req, res, next) {
    trace.push("requireAuth");
    if (req.get("x-user") !== "allowed") {
      res.status(401).end("denied");
      return;
    }
    next();
  };
}

function stamp(trace) {
  return function audit(req, _res, next) {
    trace.push("audit:" + (req.get("x-user") || "anonymous"));
    next();
  };
}

function handler(trace) {
  return function createOrder(req, res) {
    trace.push("createOrder:" + (req.get("x-user") || "anonymous"));
    res.status(200).end("created");
  };
}

function laterRoute(trace) {
  return function later(req, res) {
    trace.push("later:" + (req.get("x-user") || "anonymous"));
    res.status(200).end("later");
  };
}

function failingGuard(trace) {
  return function requireAuth(_req, _res, next) {
    trace.push("requireAuth");
    const err = new Error("denied");
    err.statusCode = 401;
    next(err);
  };
}

function errorGuard(trace) {
  return function deny(err, _req, res, _next) {
    trace.push("deny");
    res.status(err.statusCode || 500).end("denied");
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function request(server, method, path, headers) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: method.toUpperCase(),
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function withApp(register, fn) {
  const app = express();
  const router = validationRouter();
  register(router);
  app.use(router);
  app.use((_req, res) => {
    res.status(404).end("unmatched");
  });
  const server = await listen(app);
  try {
    await fn(server);
  } finally {
    await close(server);
  }
}

for (const method of METHODS) {
  test(`${method} runs a middleware array registered before the handler`, async () => {
    const trace = [];
    await withApp((router) => {
      router[method]("/orders", [guard(trace), stamp(trace)], handler(trace));
      router[method]("/orders", laterRoute(trace));
    }, async (server) => {
      const anonymous = await request(server, method, "/orders");
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.body, "denied");
      assert.deepEqual(trace, ["requireAuth"]);

      trace.length = 0;
      const allowed = await request(server, method, "/orders", {
        "x-user": "allowed",
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body, "created");
      assert.deepEqual(trace, [
        "requireAuth",
        "audit:allowed",
        "createOrder:allowed",
      ]);
    });
  });

  test(`${method} runs middleware and the handler when both are inside the array`, async () => {
    const trace = [];
    await withApp((router) => {
      router[method]("/orders", [guard(trace), stamp(trace), handler(trace)]);
      router[method]("/orders", laterRoute(trace));
    }, async (server) => {
      const anonymous = await request(server, method, "/orders");
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.body, "denied");
      assert.deepEqual(trace, ["requireAuth"]);

      trace.length = 0;
      const allowed = await request(server, method, "/orders", {
        "x-user": "allowed",
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body, "created");
      assert.deepEqual(trace, [
        "requireAuth",
        "audit:allowed",
        "createOrder:allowed",
      ]);
    });
  });

  test(`${method} runs an error-handling middleware supplied in the array`, async () => {
    const trace = [];
    await withApp((router) => {
      router[method](
        "/orders",
        [failingGuard(trace), errorGuard(trace)],
        handler(trace)
      );
      router[method]("/orders", laterRoute(trace));
    }, async (server) => {
      const anonymous = await request(server, method, "/orders");
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.body, "denied");
      assert.deepEqual(trace, ["requireAuth", "deny"]);
    });
  });
}

test("post runs a middleware array when the path is an array of paths", async () => {
  const trace = [];
  await withApp((router) => {
    router.post(
      ["/orders", "/legacy-orders"],
      [guard(trace), stamp(trace)],
      handler(trace)
    );
  }, async (server) => {
    for (const path of ["/orders", "/legacy-orders"]) {
      trace.length = 0;
      const anonymous = await request(server, "post", path);
      assert.equal(anonymous.status, 401, path);
      assert.equal(anonymous.body, "denied", path);
      assert.deepEqual(trace, ["requireAuth"]);

      trace.length = 0;
      const allowed = await request(server, "post", path, {
        "x-user": "allowed",
      });
      assert.equal(allowed.status, 200, path);
      assert.equal(allowed.body, "created", path);
      assert.deepEqual(trace, [
        "requireAuth",
        "audit:allowed",
        "createOrder:allowed",
      ]);
    }
  });
});

test("post still runs middleware passed as separate function arguments", async () => {
  const trace = [];
  await withApp((router) => {
    router.post("/orders", guard(trace), stamp(trace), handler(trace));
    router.post("/orders", laterRoute(trace));
  }, async (server) => {
    const anonymous = await request(server, "post", "/orders");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body, "denied");
    assert.deepEqual(trace, ["requireAuth"]);
  });
});
