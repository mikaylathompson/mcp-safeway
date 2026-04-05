const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveSafewayCredentials } = require("../dist/config.js");

test("resolveSafewayCredentials supports phone bootstrap and persisted session state", () => {
  const account = {
    accountId: "acct-phone",
    apiKeyHash: "a".repeat(64),
    safewayCredentials: {
      phoneNumberEnvVar: "SAFEWAY_PHONE_NUMBER",
      sessionStatePathEnvVar: "SAFEWAY_SESSION_STATE_PATH",
    },
    allowedActions: ["safeway_get_cart"],
  };

  const resolved = resolveSafewayCredentials(account, {
    SAFEWAY_PHONE_NUMBER: "+15551234567",
    SAFEWAY_SESSION_STATE_PATH: "/tmp/safeway-session.json",
  });

  assert.equal(resolved.phoneNumber, "+15551234567");
  assert.equal(resolved.sessionStatePath, "/tmp/safeway-session.json");
  assert.equal(resolved.email, undefined);
  assert.equal(resolved.password, undefined);
});

test("resolveSafewayCredentials still resolves email/password credentials", () => {
  const account = {
    accountId: "acct-password",
    apiKeyHash: "b".repeat(64),
    safewayCredentials: {
      emailEnvVar: "SAFEWAY_EMAIL",
      passwordEnvVar: "SAFEWAY_PASSWORD",
    },
    allowedActions: ["safeway_get_cart"],
  };

  const resolved = resolveSafewayCredentials(account, {
    SAFEWAY_EMAIL: "user@example.com",
    SAFEWAY_PASSWORD: "secret",
  });

  assert.equal(resolved.email, "user@example.com");
  assert.equal(resolved.password, "secret");
});
