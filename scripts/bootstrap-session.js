#!/usr/bin/env node

const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout, stderr } = require("node:process");
const { closeAllSessions, withAccountSession } = require("../dist/browser.js");

const SAFEWAY_BASE_URL = "https://www.safeway.com";
const ALBERTSONS_BASE_URL = "https://www.albertsons.com";

function getBaseUrl(storefront) {
  return storefront === "albertsons" ? ALBERTSONS_BASE_URL : SAFEWAY_BASE_URL;
}

async function readLoginError(page) {
  return page.evaluate(() => {
    const explicitError = document.querySelector(
      '.error, [role="alert"], .alert-danger, .form-error, .error-message, [data-testid*="error" i]'
    );
    const explicitText = explicitError?.textContent?.trim();
    if (explicitText) {
      return explicitText;
    }

    const text = document.body?.innerText?.replace(/\s+/g, " ").trim() || "";
    const inlineMatch = text.match(
      /Error:\s*(.+?)(?=Sign in without a password|Sign in with password|Sign in with Google|Create account|Are you a business\?|$)/i
    );
    return inlineMatch?.[1]?.trim() || null;
  });
}

async function detectLoggedIn(page) {
  return page.evaluate(() => {
    const interactiveElements = Array.from(document.querySelectorAll("a, button"));
    const normalizedText = (value) => value?.replace(/\s+/g, " ").trim().toLowerCase() || "";

    const signOutLinks = interactiveElements.filter((element) => {
      const text = normalizedText(element.textContent);
      return text === "sign out" || text === "log out";
    });

    if (signOutLinks.length > 0) {
      return true;
    }

    const signInControls = interactiveElements.filter((element) => {
      const text = normalizedText(element.textContent);
      return (
        text === "sign in" ||
        text === "log in" ||
        text === "sign in with password" ||
        text === "sign in without a password" ||
        text === "create account"
      );
    });

    const authenticatedAccountLinks = Array.from(
      document.querySelectorAll(
        'a[href*="/account/orders"], a[href*="/account/profile"], a[href*="/account/settings"], a[href*="/shop/purchases"], .account-menu.logged-in, .user-menu.logged-in'
      )
    );

    return authenticatedAccountLinks.length > 0 && signInControls.length === 0;
  });
}

async function fillVerificationCode(page, code) {
  const combinedInput = page.locator(
    'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]'
  ).first();

  if (await combinedInput.isVisible().catch(() => false)) {
    await combinedInput.fill(code);
    return;
  }

  const digitInputs = page.locator('input[maxlength="1"]');
  const count = await digitInputs.count();
  if (count >= code.length) {
    for (let index = 0; index < code.length; index += 1) {
      await digitInputs.nth(index).fill(code[index]);
    }
    return;
  }

  throw new Error("Unable to find verification code inputs on the Safeway sign-in page.");
}

async function waitForAuthenticatedSession(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await detectLoggedIn(page)) {
      return true;
    }

    await page.waitForTimeout(1000);
  }

  return false;
}

async function main() {
  const manualMode = process.argv.includes("--manual");
  const headed = manualMode || process.argv.includes("--headed");
  const storefront = process.env.SAFEWAY_STOREFRONT === "albertsons" ? "albertsons" : "safeway";
  const accountId = process.env.SAFEWAY_SESSION_ACCOUNT_ID || "live-integration";
  const phoneNumber = process.env.SAFEWAY_PHONE_NUMBER;
  const sessionStatePath =
    process.env.SAFEWAY_SESSION_STATE_PATH ||
    path.join(process.cwd(), "tmp", `safeway-session-${accountId}.json`);

  if (!phoneNumber) {
    throw new Error("Missing SAFEWAY_PHONE_NUMBER. Set it in your environment or .secrets first.");
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const account = { accountId, storefront, sessionStatePath };
  const browser = await require("/Users/mikayla/code/mcp-safeway/node_modules/playwright").chromium.launch({
    headless: !headed,
    channel: "chromium",
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--no-sandbox"],
    args: ["--disable-blink-features=AutomationControlled", "--disable-infobars", "--window-size=1280,800"],
  });

  try {
    const { sessionManager } = require("../dist/session-manager.js");
    const originalGetBrowser = sessionManager.getBrowser?.bind(sessionManager);
    sessionManager.getBrowser = async () => browser;

    await withAccountSession(account, async (session) => {
      const { page } = session;
      const baseUrl = getBaseUrl(storefront);

      await page.goto(`${baseUrl}/account/sign-in.html`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);

      const phoneField = page.locator('#enterUsername, input[aria-label="Email or mobile number"]').first();
      await phoneField.fill(phoneNumber);
      await page.getByRole("button", { name: /sign in without a password/i }).click();
      await page.waitForTimeout(2500);

      const loginError = await readLoginError(page);
      if (loginError && !/verification code expires/i.test(loginError)) {
        throw new Error(loginError);
      }

      if (manualMode) {
        stdout.write("A headed browser is open on the Safeway verification screen.\n");
        stdout.write("Enter the verification code in the browser yourself. I will save session state as soon as login completes.\n");

        const authenticated = await waitForAuthenticatedSession(page, 5 * 60_000);
        if (!authenticated) {
          throw new Error("Timed out waiting for manual OTP login to complete.");
        }
      } else {
        const verificationCode = (
          process.env.SAFEWAY_OTP_CODE || (await rl.question("Enter the Safeway verification code: "))
        ).trim();
        if (!verificationCode) {
          throw new Error("No verification code entered.");
        }

        await fillVerificationCode(page, verificationCode);

        const verifyButton = page
          .locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Sign In")')
          .first();

        if (await verifyButton.isVisible().catch(() => false)) {
          await verifyButton.click();
        }

        await page.waitForTimeout(4000);
      }

      const postVerifyError = await readLoginError(page);
      if (postVerifyError && !/verification code expires/i.test(postVerifyError)) {
        throw new Error(postVerifyError);
      }

      if (!(await detectLoggedIn(page))) {
        throw new Error("Verification completed, but the browser did not reach an authenticated account state.");
      }

      await session.context.storageState({ path: session.sessionStatePath });
      stdout.write(`Saved authenticated Safeway session to ${session.sessionStatePath}\n`);
    });

    if (originalGetBrowser) {
      sessionManager.getBrowser = originalGetBrowser;
    }
  } finally {
    rl.close();
    await closeAllSessions();
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
