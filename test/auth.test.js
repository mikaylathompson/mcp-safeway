const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const { AuthError, assertActionAllowed, authenticateRequest } = require("../dist/auth.js");

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createRequest(apiKey) {
  return {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  };
}

function createConfig() {
  return {
    host: "127.0.0.1",
    port: 3000,
    mcpPath: "/mcp",
    accounts: [
      {
        accountId: "acct-readonly",
        apiKeyHash: sha256("readonly-key"),
        safewayCredentials: {
          emailEnvVar: "SAFEWAY_READONLY_EMAIL",
          passwordEnvVar: "SAFEWAY_READONLY_PASSWORD",
        },
        allowedActions: ["safeway_get_cart"],
      },
      {
        accountId: "acct-writer",
        apiKeyHash: sha256("writer-key"),
        safewayCredentials: {
          emailEnvVar: "SAFEWAY_WRITER_EMAIL",
          passwordEnvVar: "SAFEWAY_WRITER_PASSWORD",
        },
        allowedActions: ["safeway_get_cart", "safeway_add_to_cart"],
      },
    ],
  };
}

function createEnv() {
  return {
    SAFEWAY_READONLY_EMAIL: "readonly@example.com",
    SAFEWAY_READONLY_PASSWORD: "readonly-secret",
    SAFEWAY_WRITER_EMAIL: "writer@example.com",
    SAFEWAY_WRITER_PASSWORD: "writer-secret",
  };
}

test("invalid API key is rejected", () => {
  assert.throws(
    () => authenticateRequest(createRequest("wrong-key"), createConfig(), createEnv()),
    (error) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.headers["www-authenticate"], "Bearer");
      assert.match(error.message, /invalid api key/i);
      return true;
    }
  );
});

test("valid API key resolves the correct account", () => {
  const account = authenticateRequest(createRequest("writer-key"), createConfig(), createEnv());

  assert.equal(account.accountId, "acct-writer");
  assert.deepEqual(account.allowedActionsArray, ["safeway_get_cart", "safeway_add_to_cart"]);
  assert.equal(account.safewayCredentials.email, "writer@example.com");
  assert.equal(account.safewayCredentials.password, "writer-secret");
  assert.equal(account.authInfo.clientId, "acct-writer");
  assert.deepEqual(account.authInfo.scopes, ["safeway_get_cart", "safeway_add_to_cart"]);
});

test("read-only keys cannot mutate", () => {
  const account = authenticateRequest(createRequest("readonly-key"), createConfig(), createEnv());

  assert.doesNotThrow(() => assertActionAllowed(account, "safeway_get_cart"));

  assert.throws(
    () => assertActionAllowed(account, "safeway_add_to_cart"),
    (error) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /not allowed/i);
      return true;
    }
  );
});
