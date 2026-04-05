const assert = require("node:assert/strict");
const test = require("node:test");

const { SafewaySessionManager, buildChromiumLaunchOptions } = require("../dist/session-manager.js");

function createMockSession(accountId) {
  return {
    accountId,
    storefront: "safeway",
    browser: {},
    context: {
      close: async () => {},
    },
    page: {
      isClosed: () => false,
    },
    isLoggedIn: false,
    authenticatedEmail: undefined,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    mutex: {
      runExclusive: async (task) => task(),
    },
  };
}

test("accounts do not share session state", async () => {
  const manager = new SafewaySessionManager();
  clearInterval(manager.cleanupTimer);

  const sessions = new Map();
  manager.getOrCreateSession = async function(account) {
    let session = sessions.get(account.accountId);
    if (!session) {
      session = createMockSession(account.accountId);
      sessions.set(account.accountId, session);
    }

    return session;
  };

  let firstAccountSession;
  let repeatedFirstAccountSession;
  let secondAccountSession;

  await manager.runWithSession({ accountId: "acct-a" }, async (session) => {
    firstAccountSession = session;
    session.authenticatedEmail = "a@example.com";
  });

  await manager.runWithSession({ accountId: "acct-b" }, async (session) => {
    secondAccountSession = session;
    assert.equal(session.authenticatedEmail, undefined);
    session.authenticatedEmail = "b@example.com";
  });

  await manager.runWithSession({ accountId: "acct-a" }, async (session) => {
    repeatedFirstAccountSession = session;
    assert.equal(session.authenticatedEmail, "a@example.com");
  });

  assert.strictEqual(firstAccountSession, repeatedFirstAccountSession);
  assert.notStrictEqual(firstAccountSession, secondAccountSession);
  assert.equal(secondAccountSession.authenticatedEmail, "b@example.com");
});

test("browser launch keeps sandbox on by default", () => {
  const previous = process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX;
  delete process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX;

  try {
    const launchOptions = buildChromiumLaunchOptions();

    assert.equal(launchOptions.channel, "chromium");
    assert.equal(launchOptions.chromiumSandbox, true);
    assert.deepEqual(launchOptions.ignoreDefaultArgs, ["--no-sandbox"]);
    assert.ok(!launchOptions.args.includes("--no-sandbox"));
    assert.ok(!launchOptions.args.includes("--disable-setuid-sandbox"));
  } finally {
    if (previous === undefined) {
      delete process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX;
    } else {
      process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX = previous;
    }
  }
});

test("browser launch opt-in escape hatch disables sandbox", () => {
  const previous = process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX;
  process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX = "1";

  try {
    const launchOptions = buildChromiumLaunchOptions();

    assert.equal(launchOptions.chromiumSandbox, false);
    assert.equal(launchOptions.ignoreDefaultArgs, undefined);
    assert.ok(launchOptions.args.includes("--no-sandbox"));
    assert.ok(launchOptions.args.includes("--disable-setuid-sandbox"));
  } finally {
    if (previous === undefined) {
      delete process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX;
    } else {
      process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX = previous;
    }
  }
});
