import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import {
  type SafewayAccountCredentials,
  type SafewayAccountIdentity,
  type SafewayAccountSession,
  type SafewayResolvedAccount,
  type SafewayStorefront,
  sessionManager,
} from "./session-manager.js";

export type {
  SafewayAccountCredentials,
  SafewayAccountIdentity,
  SafewayAccountSession,
  SafewayResolvedAccount,
  SafewayStorefront,
} from "./session-manager.js";

export interface SafewayOperationResult {
  success: boolean;
  message: string;
}

export interface Product {
  id: string;
  name: string;
  brand?: string;
  price: number;
  salePrice?: number;
  unit?: string;
  imageUrl?: string;
  category?: string;
  description?: string;
  upc?: string;
  inStock: boolean;
}

export interface CartItem {
  itemId: string;
  productId: string;
  name: string;
  quantity: number;
  price: number;
  totalPrice: number;
  imageUrl?: string;
}

export interface Cart {
  items: CartItem[];
  subtotal: number;
  estimatedTotal: number;
  itemCount: number;
}

export interface DeliverySlot {
  slotId: string;
  date: string;
  startTime: string;
  endTime: string;
  available: boolean;
  fee?: number;
}

export interface Order {
  orderId: string;
  date: string;
  status: string;
  total: number;
  itemCount: number;
  deliveryDate?: string;
}

export interface OrderDetail extends Order {
  items: CartItem[];
  deliveryAddress?: string;
  deliverySlot?: string;
  paymentMethod?: string;
}

export interface Coupon {
  couponId: string;
  title: string;
  description: string;
  discount: string;
  expiryDate?: string;
  category?: string;
  clipped: boolean;
}

export interface Deal {
  dealId: string;
  title: string;
  description: string;
  discount: string;
  validThrough?: string;
  category?: string;
  imageUrl?: string;
}

export interface CartMutationSnapshot {
  itemId: string;
  productId: string;
  quantity: number;
}

export interface DeliverySlotSelectionSnapshot {
  slotId: string;
  available: boolean;
  selected: boolean;
}

export interface DeliverySlotSelectionState {
  slots: DeliverySlotSelectionSnapshot[];
  selectedSlotId?: string;
}

export interface CouponClipState {
  couponId: string;
  found: boolean;
  clipped: boolean;
  canClip: boolean;
}

export interface CheckoutState {
  url: string;
  hasConfirmation: boolean;
  orderId?: string;
  inCheckoutFlow: boolean;
}

export class MutationVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationVerificationError";
  }
}

const SAFEWAY_BASE_URL = "https://www.safeway.com";
const ALBERTSONS_BASE_URL = "https://www.albertsons.com";
const LEGACY_ACCOUNT_ID = "__legacy__";
const RESET_SESSION = Symbol("reset-session");
const LOGIN_EMAIL_SELECTORS = [
  "#enterUsername",
  'input[aria-label="Email or mobile number"]',
  'input[type="email"]',
  'input[name="email"]',
  "#email",
  'input[autocomplete="username"]',
];
const LOGIN_PASSWORD_SELECTORS = [
  "#enterPassword",
  'input[type="password"]',
  'input[name="password"]',
  "#password",
  'input[autocomplete="current-password"]',
];
const LOGIN_PASSWORD_MODE_SELECTORS = [
  'button:has-text("Sign in with password")',
  'button:has-text("Use password")',
];
const LOGIN_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'button:has-text("Sign In")',
  'button:has-text("Log In")',
  'button:has-text("Continue")',
];
const ACCOUNT_ENTRYPOINT_SELECTORS = [
  "#auth_signin_link",
  '[data-testid="account"]',
  'button[aria-label*="account" i]',
  'a[href*="sign-in"]',
  'button:has-text("Sign In")',
  'a:has-text("Sign In")',
  'button:has-text("Account")',
];

let legacyAccount: SafewayResolvedAccount | null = null;

function sanitizeAccountIdForPath(accountId: string): string {
  return accountId.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}

function getDefaultSessionStatePath(accountId: string): string {
  return join(process.cwd(), "tmp", `safeway-session-${sanitizeAccountIdForPath(accountId)}.json`);
}

function withResolvedSessionStatePath<T extends SafewayAccountIdentity>(account: T): T & { sessionStatePath: string } {
  return {
    ...account,
    sessionStatePath: account.sessionStatePath || getDefaultSessionStatePath(account.accountId),
  };
}

function getBaseUrl(storefront: SafewayStorefront = "safeway"): string {
  return storefront === "albertsons" ? ALBERTSONS_BASE_URL : SAFEWAY_BASE_URL;
}

function getAccountLoginKey(account: SafewayResolvedAccount): string {
  return account.email || account.phoneNumber || account.accountId;
}

function requireLegacyAccount(): SafewayResolvedAccount {
  if (!legacyAccount) {
    throw new Error("No active Safeway session. Call safeway_login first.");
  }

  return legacyAccount;
}

function assertAuthenticated(session: SafewayAccountSession): void {
  if (!session.isLoggedIn) {
    throw new Error(`Account ${session.accountId} is not authenticated.`);
  }
}

function matchesCartReference(item: CartMutationSnapshot, reference: string): boolean {
  return item.itemId === reference || item.productId === reference;
}

function getTotalProductQuantity(cart: Cart, productId: string): number {
  return cart.items
    .filter((item) => item.productId === productId)
    .reduce((sum, item) => sum + item.quantity, 0);
}

function getCartMutationSnapshots(cart: Cart): CartMutationSnapshot[] {
  return cart.items.map((item) => ({
    itemId: item.itemId,
    productId: item.productId,
    quantity: item.quantity,
  }));
}

export function verifyAddToCartPostcondition(
  beforeCart: Cart,
  afterCart: Cart,
  productId: string,
  quantity: number
): SafewayOperationResult {
  const beforeQuantity = getTotalProductQuantity(beforeCart, productId);
  const afterQuantity = getTotalProductQuantity(afterCart, productId);

  if (afterQuantity !== beforeQuantity + quantity) {
    throw new MutationVerificationError(
      `Unable to verify add-to-cart for product ${productId}: expected quantity ${beforeQuantity + quantity}, found ${afterQuantity}.`
    );
  }

  return {
    success: true,
    message: `Successfully added ${quantity} item(s) to cart (product ID: ${productId})`,
  };
}

export function verifyUpdateCartItemPostcondition(
  beforeItems: CartMutationSnapshot[],
  afterItems: CartMutationSnapshot[],
  itemId: string,
  quantity: number
): SafewayOperationResult {
  const beforeItem = beforeItems.find((item) => matchesCartReference(item, itemId));
  if (!beforeItem) {
    throw new MutationVerificationError(`Cart item ${itemId} was not present before the update attempt.`);
  }

  const afterItem = afterItems.find((item) => matchesCartReference(item, itemId));
  if (!afterItem) {
    throw new MutationVerificationError(`Cart item ${itemId} was not present after the update attempt.`);
  }

  if (afterItem.quantity !== quantity) {
    throw new MutationVerificationError(
      `Unable to verify quantity update for item ${itemId}: expected ${quantity}, found ${afterItem.quantity}.`
    );
  }

  return {
    success: true,
    message: `Updated item ${itemId} quantity to ${quantity}`,
  };
}

export function verifyRemoveFromCartPostcondition(
  beforeItems: CartMutationSnapshot[],
  afterItems: CartMutationSnapshot[],
  itemId: string
): SafewayOperationResult {
  const beforeItem = beforeItems.find((item) => matchesCartReference(item, itemId));
  if (!beforeItem) {
    throw new MutationVerificationError(`Cart item ${itemId} was not present before the remove attempt.`);
  }

  const afterItem = afterItems.find((item) => matchesCartReference(item, itemId));
  if (afterItem) {
    throw new MutationVerificationError(`Unable to verify removal for item ${itemId}: item still exists in cart.`);
  }

  return {
    success: true,
    message: `Removed item ${itemId} from cart`,
  };
}

export function verifySelectDeliverySlotPostcondition(
  beforeState: DeliverySlotSelectionState,
  afterState: DeliverySlotSelectionState,
  slotId: string
): SafewayOperationResult {
  const beforeSlot = beforeState.slots.find((slot) => slot.slotId === slotId);
  if (!beforeSlot) {
    throw new MutationVerificationError(`Delivery slot ${slotId} was not found before selection.`);
  }

  if (!beforeSlot.available) {
    throw new MutationVerificationError(`Delivery slot ${slotId} is not available for selection.`);
  }

  const afterSlot = afterState.slots.find((slot) => slot.slotId === slotId);
  if (!afterSlot) {
    throw new MutationVerificationError(`Delivery slot ${slotId} was not found after selection.`);
  }

  if (!afterSlot.selected && afterState.selectedSlotId !== slotId) {
    throw new MutationVerificationError(`Unable to verify selection for delivery slot ${slotId}.`);
  }

  return {
    success: true,
    message: `Selected delivery slot ${slotId}`,
  };
}

export function verifyClipCouponPostcondition(
  beforeState: CouponClipState,
  afterState: CouponClipState,
  couponId: string
): SafewayOperationResult {
  if (!beforeState.found) {
    throw new MutationVerificationError(`Coupon ${couponId} was not found before the clip attempt.`);
  }

  if (beforeState.clipped) {
    return {
      success: true,
      message: `Coupon ${couponId} was already clipped`,
    };
  }

  if (!beforeState.canClip) {
    throw new MutationVerificationError(`Coupon ${couponId} was not in a clip-ready state.`);
  }

  if (!afterState.found || !afterState.clipped) {
    throw new MutationVerificationError(`Unable to verify that coupon ${couponId} was clipped.`);
  }

  return {
    success: true,
    message: `Successfully clipped coupon ${couponId}`,
  };
}

export function verifyCheckoutPostcondition(state: CheckoutState): SafewayOperationResult & { orderId?: string } {
  if (state.hasConfirmation || state.orderId) {
    return {
      success: true,
      orderId: state.orderId,
      message: `Checkout successful! Order ID: ${state.orderId || "pending"}`,
    };
  }

  if (state.inCheckoutFlow) {
    return {
      success: true,
      message: "Redirected to checkout flow. Please review and complete any remaining steps.",
    };
  }

  throw new MutationVerificationError(
    `Unable to verify checkout progress from page state at ${state.url}.`
  );
}

async function readLoginError(page: Page): Promise<string | null> {
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

export async function findVisibleSelector(
  page: Page,
  selectors: string[],
  timeout = 15_000
): Promise<string | null> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const isVisible = await locator.isVisible().catch(() => false);
      if (isVisible) {
        return selector;
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function requireVisibleSelector(
  page: Page,
  selectors: string[],
  timeout: number,
  description: string
): Promise<string> {
  const selector = await findVisibleSelector(page, selectors, timeout);
  if (!selector) {
    throw new Error(`Unable to find visible ${description}.`);
  }

  return selector;
}

async function openLoginSurface(
  session: SafewayAccountSession
): Promise<{ emailSelector: string }> {
  const { page } = session;
  const baseUrl = getBaseUrl(session.storefront);

  await navigateTo(session, `${baseUrl}/account/sign-in.html`);

  const directEmailSelector = await findVisibleSelector(page, LOGIN_EMAIL_SELECTORS, 5_000);
  if (directEmailSelector) {
    return {
      emailSelector: directEmailSelector,
    };
  }

  await navigateTo(session, `${baseUrl}/`);

  const accountEntrySelector = await findVisibleSelector(page, ACCOUNT_ENTRYPOINT_SELECTORS, 5_000);
  if (accountEntrySelector) {
    await page.locator(accountEntrySelector).first().click();
  }

  const emailSelector = await requireVisibleSelector(page, LOGIN_EMAIL_SELECTORS, 10_000, "login email field");
  return { emailSelector };
}

async function detectLoggedIn(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const interactiveElements = Array.from(document.querySelectorAll("a, button"));
    const normalizedText = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim().toLowerCase() || "";

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

async function readDeliverySlotSelectionState(page: Page): Promise<DeliverySlotSelectionState> {
  return page.evaluate(() => {
    const slotElements = document.querySelectorAll(
      '[data-testid="delivery-slot"], .delivery-slot, .time-slot, .slot-item'
    );

    const slots = Array.from(slotElements).map((slot, index) => {
      const slotId = slot.getAttribute("data-slot-id") || slot.getAttribute("data-id") || `slot-${index}`;
      const classNames = Array.from(slot.classList);
      const selected =
        classNames.some((name) => ["selected", "active", "is-selected"].includes(name)) ||
        slot.getAttribute("aria-selected") === "true" ||
        slot.getAttribute("aria-checked") === "true" ||
        !!slot.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
      const available =
        !classNames.some((name) => ["disabled", "unavailable"].includes(name)) &&
        slot.getAttribute("aria-disabled") !== "true";

      return {
        slotId,
        available,
        selected,
      };
    });

    const explicitSelection = slots.find((slot) => slot.selected)?.slotId;
    const summarySelection = document.querySelector(
      '[data-testid="selected-slot"], .selected-slot, .delivery-slot-summary [data-slot-id]'
    )?.getAttribute("data-slot-id");

    return {
      slots,
      selectedSlotId: explicitSelection ?? summarySelection ?? undefined,
    };
  });
}

async function readCouponClipState(page: Page, couponId: string): Promise<CouponClipState> {
  return page.evaluate((id: string) => {
    const coupons = document.querySelectorAll('[data-testid="coupon"], .coupon-item, .coupon-card');

    for (const coupon of coupons) {
      const couponDataId = coupon.getAttribute("data-coupon-id") || coupon.getAttribute("data-id");
      if (couponDataId !== id) {
        continue;
      }

      const clipButton = coupon.querySelector(
        'button:has-text("Clip"), button[data-testid="clip-coupon"], .clip-btn, button:has-text("Add")'
      ) as HTMLButtonElement | null;
      const buttonText = clipButton?.textContent?.trim().toLowerCase() || "";
      const classNames = Array.from(coupon.classList);
      const clipped =
        classNames.some((name) => ["clipped", "active", "selected", "is-clipped"].includes(name)) ||
        clipButton?.disabled === true ||
        /clipped|added|saved/.test(buttonText);

      return {
        couponId: id,
        found: true,
        clipped,
        canClip: !!clipButton && !clipButton.disabled,
      };
    }

    return {
      couponId: id,
      found: false,
      clipped: false,
      canClip: false,
    };
  }, couponId);
}

async function readCheckoutState(page: Page): Promise<CheckoutState> {
  return page.evaluate(() => {
    const currentUrl = window.location.href;
    const lowerUrl = currentUrl.toLowerCase();
    const hasConfirmation = !!document.querySelector(
      '.order-confirmation, [data-testid="order-confirmation"], .confirmation-number'
    );
    const orderId = document.querySelector('[data-testid="order-id"], .order-id, .order-number')
      ?.textContent
      ?.trim();
    const inCheckoutFlow =
      lowerUrl.includes("/checkout") ||
      lowerUrl.includes("/payment") ||
      lowerUrl.includes("/review") ||
      !!document.querySelector(
        '[data-testid="checkout-page"], .checkout-page, .payment-form, .review-order'
      );

    return {
      url: currentUrl,
      hasConfirmation,
      orderId: orderId || undefined,
      inCheckoutFlow,
    };
  });
}

async function ensureAuthenticatedSession(
  session: SafewayAccountSession,
  account: SafewayResolvedAccount
): Promise<void> {
  if (session.isLoggedIn && session.authenticatedLoginKey === getAccountLoginKey(account)) {
    return;
  }

  const result = await loginWithSession(session, account);
  if (!result.success) {
    throw new Error(result.message);
  }
}

export async function withAccountSession<T>(
  account: SafewayAccountIdentity,
  task: (session: SafewayAccountSession) => Promise<T>
): Promise<T> {
  return sessionManager.runWithSession(withResolvedSessionStatePath(account), task);
}

export async function withAuthenticatedAccountSession<T>(
  account: SafewayResolvedAccount,
  task: (session: SafewayAccountSession) => Promise<T>
): Promise<T> {
  const resolvedAccount = withResolvedSessionStatePath(account);
  const result = await sessionManager.runWithSession<
    T | typeof RESET_SESSION
  >(resolvedAccount, async (session) => {
    if (session.authenticatedLoginKey && session.authenticatedLoginKey !== getAccountLoginKey(resolvedAccount)) {
      return RESET_SESSION;
    }

    await ensureAuthenticatedSession(session, resolvedAccount);
    return task(session);
  });

  if (result === RESET_SESSION) {
    await sessionManager.closeSession(resolvedAccount.accountId);
    return withAuthenticatedAccountSession(resolvedAccount, task);
  }

  return result;
}

export async function closeAccountSession(accountId: string): Promise<void> {
  if (legacyAccount?.accountId === accountId) {
    legacyAccount = null;
  }

  await sessionManager.closeSession(accountId);
}

export async function closeAllSessions(): Promise<void> {
  legacyAccount = null;
  await sessionManager.closeAllSessions();
}

export async function closeSession(accountId?: string): Promise<void> {
  if (accountId) {
    await closeAccountSession(accountId);
    return;
  }

  await closeAllSessions();
}

export async function navigateTo(session: SafewayAccountSession, url: string): Promise<void> {
  sessionManager.touchSession(session.accountId);
  await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await session.page.waitForTimeout(1_000);
}

export async function loginWithSession(
  session: SafewayAccountSession,
  credentials: SafewayAccountCredentials
): Promise<SafewayOperationResult> {
  const { page } = session;
  const loginKey = credentials.email || credentials.phoneNumber || session.accountId;

  try {
    if (session.sessionStatePath && existsSync(session.sessionStatePath)) {
      await navigateTo(session, `${getBaseUrl(session.storefront)}/`);
      const resumed = await detectLoggedIn(page);
      if (resumed) {
        session.isLoggedIn = true;
        session.authenticatedEmail = credentials.email;
        session.authenticatedLoginKey = loginKey;
        return { success: true, message: "Restored authenticated Safeway session from saved browser state" };
      }
    }

    if (credentials.phoneNumber && (!credentials.email || !credentials.password)) {
      return {
        success: false,
        message:
          "No saved Safeway session is available. Run `node scripts/bootstrap-session.js` after setting SAFEWAY_PHONE_NUMBER to complete the one-time verification flow.",
      };
    }

    if (!credentials.email || !credentials.password) {
      return {
        success: false,
        message:
          "Safeway authentication requires either a saved browser session or email/password credentials.",
      };
    }

    const { emailSelector } = await openLoginSurface(session);

    await page.locator(emailSelector).first().fill(credentials.email);

    let passwordSelector = await findVisibleSelector(page, LOGIN_PASSWORD_SELECTORS, 1_000);
    if (!passwordSelector) {
      const passwordModeSelector = await findVisibleSelector(page, LOGIN_PASSWORD_MODE_SELECTORS, 2_000);
      if (passwordModeSelector) {
        await page.locator(passwordModeSelector).first().click();
        await page.waitForTimeout(1_500);
      }

      const prePasswordError = await readLoginError(page);
      if (prePasswordError) {
        session.isLoggedIn = false;
        session.authenticatedEmail = undefined;
        session.authenticatedLoginKey = undefined;
        return { success: false, message: prePasswordError };
      }

      passwordSelector = await requireVisibleSelector(
        page,
        LOGIN_PASSWORD_SELECTORS,
        10_000,
        "login password field"
      );
    }

    await page.locator(passwordSelector).first().fill(credentials.password);

    const submitSelector = await requireVisibleSelector(page, LOGIN_SUBMIT_SELECTORS, 5_000, "login submit button");
    await page.locator(submitSelector).first().click();
    await page.waitForTimeout(3_000);

    const errorText = await readLoginError(page);
    if (errorText) {
      session.isLoggedIn = false;
      session.authenticatedEmail = undefined;
      session.authenticatedLoginKey = undefined;
      return { success: false, message: errorText };
    }

    const isLoggedIn = await detectLoggedIn(page);
    if (!isLoggedIn) {
      session.isLoggedIn = false;
      session.authenticatedEmail = undefined;
      session.authenticatedLoginKey = undefined;
      return { success: false, message: "Login did not reach an authenticated account state." };
    }

    session.isLoggedIn = true;
    session.authenticatedEmail = credentials.email;
    session.authenticatedLoginKey = loginKey;
    if (session.sessionStatePath) {
      mkdirSync(dirname(session.sessionStatePath), { recursive: true });
      await session.context.storageState({ path: session.sessionStatePath });
    }

    return { success: true, message: "Successfully logged in to Safeway" };
  } catch (error) {
    session.isLoggedIn = false;
    session.authenticatedEmail = undefined;
    session.authenticatedLoginKey = undefined;
    const message = error instanceof Error ? error.message : "Unknown error during login";
    return { success: false, message };
  }
}

export async function loginForAccount(
  account: SafewayResolvedAccount
): Promise<SafewayOperationResult> {
  const resolvedAccount = withResolvedSessionStatePath(account);
  const result = await sessionManager.runWithSession<
    SafewayOperationResult | typeof RESET_SESSION
  >(resolvedAccount, async (session) => {
    if (session.authenticatedLoginKey && session.authenticatedLoginKey !== getAccountLoginKey(resolvedAccount)) {
      return RESET_SESSION;
    }

    return loginWithSession(session, resolvedAccount);
  });

  if (result === RESET_SESSION) {
    await sessionManager.closeSession(resolvedAccount.accountId);
    return loginForAccount(resolvedAccount);
  }

  return result;
}

export async function loginWithAccount(
  account: SafewayResolvedAccount
): Promise<SafewayOperationResult> {
  legacyAccount = withResolvedSessionStatePath(account);
  return loginForAccount(legacyAccount);
}

export async function login(email: string, password: string): Promise<SafewayOperationResult> {
  return loginWithAccount({
    accountId: LEGACY_ACCOUNT_ID,
    email,
    password,
    storefront: "safeway",
    sessionStatePath: process.env.SAFEWAY_SESSION_STATE_PATH || getDefaultSessionStatePath(LEGACY_ACCOUNT_ID),
  });
}

export async function searchProductsInSession(
  session: SafewayAccountSession,
  query: string,
  category?: string,
  filters?: Record<string, string>
): Promise<Product[]> {
  const { page } = session;

  try {
    let searchUrl = `${getBaseUrl(session.storefront)}/shop/search-results.html?q=${encodeURIComponent(query)}`;
    if (category) {
      searchUrl += `&category=${encodeURIComponent(category)}`;
    }

    if (filters) {
      const params = new URLSearchParams(filters);
      const filterString = params.toString();
      if (filterString) {
        searchUrl += `&${filterString}`;
      }
    }

    await navigateTo(session, searchUrl);

    await page.waitForSelector(
      '.product-item, .product-card, [data-testid="product-card"], .grid-x .cell',
      { timeout: 15_000 }
    ).catch(() => null);

    await page.waitForTimeout(2_000);

    return page.evaluate(() => {
      const items: Product[] = [];
      const productCards = document.querySelectorAll(
        '[data-testid="product-card"], .product-item, .product-card, .product-tile'
      );

      productCards.forEach((card, index) => {
        if (index >= 20) {
          return;
        }

        const nameEl = card.querySelector(
          '[data-testid="product-title"], .product-title, .product-name, h3, h4'
        );
        const priceEl = card.querySelector(
          '[data-testid="product-price"], .product-price, .price, .sale-price'
        );
        const brandEl = card.querySelector('[data-testid="product-brand"], .product-brand, .brand');
        const imgEl = card.querySelector("img") as HTMLImageElement | null;
        const linkEl = card.querySelector("a") as HTMLAnchorElement | null;

        const name = nameEl?.textContent?.trim() || "";
        const priceText = priceEl?.textContent?.trim() || "0";
        const priceMatch = priceText.match(/[\d.]+/);
        const price = priceMatch ? parseFloat(priceMatch[0]) : 0;
        const href = linkEl?.href || "";
        const idMatch = href.match(/\/(\d+)(?:\.html)?$/) || href.match(/product[_-]?id[=\/](\w+)/i);
        const id = idMatch ? idMatch[1] : `product-${index}`;

        if (name) {
          items.push({
            id,
            name,
            brand: brandEl?.textContent?.trim(),
            price,
            imageUrl: imgEl?.src,
            inStock: !card.querySelector(".out-of-stock, .unavailable"),
          });
        }
      });

      return items;
    });
  } catch (error) {
    throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function searchProducts(
  query: string,
  category?: string,
  filters?: Record<string, string>
): Promise<Product[]> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) =>
    searchProductsInSession(session, query, category, filters)
  );
}

export async function getProductDetailsInSession(
  session: SafewayAccountSession,
  productId: string
): Promise<Product> {
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/shop/product-details.${productId}.html`);

    await page.waitForSelector(
      '.product-details, [data-testid="product-details"], .pdp-container',
      { timeout: 15_000 }
    ).catch(() => null);

    await page.waitForTimeout(1_500);

    return page.evaluate((id: string) => {
      const nameEl = document.querySelector(
        '[data-testid="product-name"], .product-name, h1.product-title, h1'
      );
      const priceEl = document.querySelector(
        '[data-testid="product-price"], .product-price, .price-current, .regular-price'
      );
      const salePriceEl = document.querySelector('[data-testid="sale-price"], .sale-price, .special-price');
      const brandEl = document.querySelector('[data-testid="product-brand"], .product-brand, .brand-name');
      const descEl = document.querySelector(
        '[data-testid="product-description"], .product-description, .product-details-description'
      );
      const imgEl = document.querySelector(
        "img.product-image, .product-img img, .pdp-image img"
      ) as HTMLImageElement | null;
      const upcEl = document.querySelector('[data-testid="upc"], .upc, .product-upc');

      const priceText = priceEl?.textContent?.trim() || "0";
      const priceMatch = priceText.match(/[\d.]+/);
      const price = priceMatch ? parseFloat(priceMatch[0]) : 0;

      const salePriceText = salePriceEl?.textContent?.trim();
      const salePriceMatch = salePriceText?.match(/[\d.]+/);
      const salePrice = salePriceMatch ? parseFloat(salePriceMatch[0]) : undefined;

      return {
        id,
        name: nameEl?.textContent?.trim() || "Unknown Product",
        brand: brandEl?.textContent?.trim(),
        price,
        salePrice,
        imageUrl: imgEl?.src,
        description: descEl?.textContent?.trim(),
        upc: upcEl?.textContent?.trim(),
        inStock: !document.querySelector(".out-of-stock, .unavailable"),
      };
    }, productId);
  } catch (error) {
    throw new Error(`Failed to get product details: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getProductDetails(productId: string): Promise<Product> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => getProductDetailsInSession(session, productId));
}

export async function addToCartInSession(
  session: SafewayAccountSession,
  productId: string,
  quantity: number
): Promise<SafewayOperationResult> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    const beforeCart = await getCartInSession(session);
    await navigateTo(session, `${getBaseUrl(session.storefront)}/shop/product-details.${productId}.html`);

    await page.waitForSelector(
      'button[data-testid="add-to-cart"], button:has-text("Add to Cart"), .add-to-cart-btn',
      { timeout: 15_000 }
    );

    if (quantity > 1) {
      const qtyInput = await page.$(
        'input[data-testid="quantity"], input.quantity-input, input[name="quantity"]'
      );
      if (qtyInput) {
        await qtyInput.fill(String(quantity));
      }
    }

    await page.click('button[data-testid="add-to-cart"], button:has-text("Add to Cart"), .add-to-cart-btn');
    await page.waitForTimeout(2_000);

    const afterCart = await getCartInSession(session);
    return verifyAddToCartPostcondition(beforeCart, afterCart, productId, quantity);
  } catch (error) {
    throw new Error(`Failed to add to cart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function addToCart(productId: string, quantity: number): Promise<SafewayOperationResult> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => addToCartInSession(session, productId, quantity));
}

export async function getCartInSession(session: SafewayAccountSession): Promise<Cart> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/shop/cart`);

    await page.waitForSelector('.cart-item, [data-testid="cart-item"], .cart-product', {
      timeout: 15_000,
    }).catch(() => null);

    await page.waitForTimeout(1_500);

    return page.evaluate(() => {
      const items: CartItem[] = [];
      const cartItems = document.querySelectorAll('[data-testid="cart-item"], .cart-item, .cart-product-item');

      cartItems.forEach((item, index) => {
        const nameEl = item.querySelector('[data-testid="item-name"], .item-name, .product-name');
        const priceEl = item.querySelector('[data-testid="item-price"], .item-price, .unit-price');
        const qtyEl = item.querySelector(
          'input[data-testid="quantity"], input.quantity, input[name="quantity"]'
        ) as HTMLInputElement | null;
        const imgEl = item.querySelector("img") as HTMLImageElement | null;
        const idAttr = item.getAttribute("data-product-id") || item.getAttribute("data-item-id") || `item-${index}`;

        const priceText = priceEl?.textContent?.trim() || "0";
        const priceMatch = priceText.match(/[\d.]+/);
        const price = priceMatch ? parseFloat(priceMatch[0]) : 0;
        const quantity = parseInt(qtyEl?.value || "1", 10);

        if (nameEl?.textContent?.trim()) {
          items.push({
            itemId: idAttr,
            productId: item.getAttribute("data-product-id") || idAttr,
            name: nameEl.textContent.trim(),
            quantity,
            price,
            totalPrice: price * quantity,
            imageUrl: imgEl?.src,
          });
        }
      });

      const subtotalEl = document.querySelector('[data-testid="subtotal"], .cart-subtotal, .subtotal-price');
      const totalEl = document.querySelector(
        '[data-testid="estimated-total"], .estimated-total, .cart-total'
      );

      const subtotalText = subtotalEl?.textContent?.trim() || "0";
      const subtotalMatch = subtotalText.match(/[\d.]+/);
      const subtotal = subtotalMatch ? parseFloat(subtotalMatch[0]) : 0;

      const totalText = totalEl?.textContent?.trim() || "0";
      const totalMatch = totalText.match(/[\d.]+/);
      const estimatedTotal = totalMatch ? parseFloat(totalMatch[0]) : subtotal;

      return {
        items,
        subtotal,
        estimatedTotal,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      };
    });
  } catch (error) {
    throw new Error(`Failed to get cart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getCart(): Promise<Cart> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => getCartInSession(session));
}

export async function updateCartItemInSession(
  session: SafewayAccountSession,
  itemId: string,
  quantity: number
): Promise<SafewayOperationResult> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    const beforeCart = await getCartInSession(session);
    await navigateTo(session, `${getBaseUrl(session.storefront)}/shop/cart`);

    await page.waitForSelector('[data-testid="cart-item"], .cart-item', {
      timeout: 15_000,
    }).catch(() => null);

    await page.evaluate(({ id, qty }: { id: string; qty: number }) => {
      const items = document.querySelectorAll('[data-testid="cart-item"], .cart-item, .cart-product-item');

      for (const item of items) {
        const itemAttrId = item.getAttribute("data-product-id") || item.getAttribute("data-item-id");
        if (itemAttrId === id) {
          const qtyInput = item.querySelector(
            'input[name="quantity"], input.quantity'
          ) as HTMLInputElement | null;
          if (qtyInput) {
            qtyInput.value = String(qty);
            qtyInput.dispatchEvent(new Event("input", { bubbles: true }));
            qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
            qtyInput.dispatchEvent(new Event("blur", { bubbles: true }));
          }
          break;
        }
      }
    }, { id: itemId, qty: quantity });

    await page.waitForTimeout(1_000);

    const afterCart = await getCartInSession(session);
    return verifyUpdateCartItemPostcondition(
      getCartMutationSnapshots(beforeCart),
      getCartMutationSnapshots(afterCart),
      itemId,
      quantity
    );
  } catch (error) {
    throw new Error(`Failed to update cart item: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function updateCartItem(itemId: string, quantity: number): Promise<SafewayOperationResult> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) =>
    updateCartItemInSession(session, itemId, quantity)
  );
}

export async function removeFromCartInSession(
  session: SafewayAccountSession,
  itemId: string
): Promise<SafewayOperationResult> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    const beforeCart = await getCartInSession(session);
    await navigateTo(session, `${getBaseUrl(session.storefront)}/shop/cart`);

    await page.waitForSelector('[data-testid="cart-item"], .cart-item', {
      timeout: 15_000,
    }).catch(() => null);

    await page.evaluate((id: string) => {
      const items = document.querySelectorAll('[data-testid="cart-item"], .cart-item, .cart-product-item');

      for (const item of items) {
        const itemAttrId = item.getAttribute("data-product-id") || item.getAttribute("data-item-id");
        if (itemAttrId === id) {
          const removeBtn = item.querySelector(
            'button[data-testid="remove"], button.remove-item, button:has-text("Remove"), .remove-btn'
          ) as HTMLButtonElement | null;
          removeBtn?.click();
          break;
        }
      }
    }, itemId);

    await page.waitForTimeout(1_500);

    const afterCart = await getCartInSession(session);
    return verifyRemoveFromCartPostcondition(
      getCartMutationSnapshots(beforeCart),
      getCartMutationSnapshots(afterCart),
      itemId
    );
  } catch (error) {
    throw new Error(`Failed to remove from cart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function removeFromCart(itemId: string): Promise<SafewayOperationResult> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => removeFromCartInSession(session, itemId));
}

export async function getDeliverySlotsInSession(
  session: SafewayAccountSession,
  date?: string
): Promise<DeliverySlot[]> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/shop/delivery-slots`);

    await page.waitForSelector('.delivery-slot, [data-testid="delivery-slot"], .time-slot', {
      timeout: 15_000,
    }).catch(() => null);

    await page.waitForTimeout(2_000);

    if (date) {
      await page.evaluate((targetDate: string) => {
        const dateButtons = document.querySelectorAll('[data-date], .date-button, .calendar-day');
        for (const btn of dateButtons) {
          const btnDate = btn.getAttribute("data-date") || btn.textContent?.trim();
          if (btnDate && btnDate.includes(targetDate)) {
            (btn as HTMLElement).click();
            break;
          }
        }
      }, date);
      await page.waitForTimeout(1_500);
    }

    return page.evaluate(() => {
      const slotElements = document.querySelectorAll(
        '[data-testid="delivery-slot"], .delivery-slot, .time-slot, .slot-item'
      );

      return Array.from(slotElements).map((slot, index) => {
        const timeEl = slot.querySelector('.time, .slot-time, [data-testid="slot-time"]');
        const dateEl = slot.querySelector('.date, .slot-date, [data-testid="slot-date"]');
        const feeEl = slot.querySelector('.fee, .delivery-fee, [data-testid="slot-fee"]');
        const slotId = slot.getAttribute("data-slot-id") || slot.getAttribute("data-id") || `slot-${index}`;
        const isAvailable = !slot.classList.contains("unavailable") && !slot.classList.contains("disabled");

        const timeText = timeEl?.textContent?.trim() || "";
        const timeParts = timeText.match(/(\d+:\d+\s*[AP]M)\s*-\s*(\d+:\d+\s*[AP]M)/i);

        const feeText = feeEl?.textContent?.trim() || "";
        const feeMatch = feeText.match(/[\d.]+/);

        return {
          slotId,
          date: dateEl?.textContent?.trim() || new Date().toLocaleDateString(),
          startTime: timeParts ? timeParts[1] : timeText.split("-")[0]?.trim() || "TBD",
          endTime: timeParts ? timeParts[2] : timeText.split("-")[1]?.trim() || "TBD",
          available: isAvailable,
          fee: feeMatch ? parseFloat(feeMatch[0]) : undefined,
        };
      });
    });
  } catch (error) {
    throw new Error(`Failed to get delivery slots: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getDeliverySlots(date?: string): Promise<DeliverySlot[]> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => getDeliverySlotsInSession(session, date));
}

export async function selectDeliverySlotInSession(
  session: SafewayAccountSession,
  slotId: string
): Promise<SafewayOperationResult> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/shop/delivery-slots`);

    await page.waitForSelector('[data-testid="delivery-slot"], .delivery-slot, .time-slot', {
      timeout: 15_000,
    }).catch(() => null);

    const beforeState = await readDeliverySlotSelectionState(page);

    await page.evaluate((id: string) => {
      const slots = document.querySelectorAll(
        '[data-testid="delivery-slot"], .delivery-slot, .time-slot, .slot-item'
      );

      for (const slot of slots) {
        const slotDataId = slot.getAttribute("data-slot-id") || slot.getAttribute("data-id");
        if (slotDataId === id) {
          (slot as HTMLElement).click();
          break;
        }
      }
    }, slotId);

    await page.waitForTimeout(1_500);

    const confirmBtn = await page.$(
      'button:has-text("Confirm"), button:has-text("Select"), button[data-testid="confirm-slot"]'
    );
    if (confirmBtn) {
      await confirmBtn.click();
      await page.waitForTimeout(1_500);
    }

    const afterState = await readDeliverySlotSelectionState(page);
    return verifySelectDeliverySlotPostcondition(beforeState, afterState, slotId);
  } catch (error) {
    throw new Error(`Failed to select delivery slot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function selectDeliverySlot(slotId: string): Promise<SafewayOperationResult> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => selectDeliverySlotInSession(session, slotId));
}

export async function checkoutInSession(
  session: SafewayAccountSession
): Promise<SafewayOperationResult & { orderId?: string }> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/shop/cart`);

    await page.waitForSelector(
      'button:has-text("Checkout"), button[data-testid="checkout"], .checkout-btn, a:has-text("Checkout")',
      { timeout: 15_000 }
    );

    await page.click(
      'button:has-text("Checkout"), button[data-testid="checkout"], .checkout-btn, a:has-text("Checkout")'
    );

    await page.waitForTimeout(3_000);
    await page.waitForLoadState("domcontentloaded");

    const checkoutState = await readCheckoutState(page);
    return verifyCheckoutPostcondition(checkoutState);
  } catch (error) {
    throw new Error(`Checkout failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function checkout(): Promise<SafewayOperationResult & { orderId?: string }> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => checkoutInSession(session));
}

export async function getOrdersInSession(session: SafewayAccountSession): Promise<Order[]> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/account/order-history`);

    await page.waitForSelector('.order-item, [data-testid="order-item"], .order-card', {
      timeout: 15_000,
    }).catch(() => null);

    await page.waitForTimeout(1_500);

    return page.evaluate(() => {
      const orderElements = document.querySelectorAll(
        '[data-testid="order-item"], .order-item, .order-card, .order-history-item'
      );

      return Array.from(orderElements).map((order, index) => {
        const orderIdEl = order.querySelector('[data-testid="order-id"], .order-id, .order-number');
        const dateEl = order.querySelector('[data-testid="order-date"], .order-date, .placed-date');
        const statusEl = order.querySelector('[data-testid="order-status"], .order-status, .status-badge');
        const totalEl = order.querySelector('[data-testid="order-total"], .order-total, .total-amount');
        const itemCountEl = order.querySelector('[data-testid="item-count"], .item-count, .items-count');
        const deliveryDateEl = order.querySelector(
          '[data-testid="delivery-date"], .delivery-date, .estimated-delivery'
        );

        const totalText = totalEl?.textContent?.trim() || "0";
        const totalMatch = totalText.match(/[\d.]+/);

        return {
          orderId: orderIdEl?.textContent?.trim() || `order-${index}`,
          date: dateEl?.textContent?.trim() || "",
          status: statusEl?.textContent?.trim() || "Unknown",
          total: totalMatch ? parseFloat(totalMatch[0]) : 0,
          itemCount: parseInt(itemCountEl?.textContent?.trim() || "0", 10),
          deliveryDate: deliveryDateEl?.textContent?.trim(),
        };
      });
    });
  } catch (error) {
    throw new Error(`Failed to get orders: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getOrders(): Promise<Order[]> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => getOrdersInSession(session));
}

export async function getOrderDetailsInSession(
  session: SafewayAccountSession,
  orderId: string
): Promise<OrderDetail> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/account/order-details/${orderId}`);

    await page.waitForSelector('.order-detail, [data-testid="order-detail"], .order-items', {
      timeout: 15_000,
    }).catch(() => null);

    await page.waitForTimeout(1_500);

    return page.evaluate((id: string) => {
      const statusEl = document.querySelector('[data-testid="order-status"], .order-status');
      const dateEl = document.querySelector('[data-testid="order-date"], .order-date');
      const totalEl = document.querySelector('[data-testid="order-total"], .order-total');
      const deliveryEl = document.querySelector('[data-testid="delivery-date"], .delivery-date');
      const addressEl = document.querySelector(
        '[data-testid="delivery-address"], .delivery-address, .ship-to'
      );
      const paymentEl = document.querySelector('[data-testid="payment-method"], .payment-method');

      const items: CartItem[] = [];
      const itemEls = document.querySelectorAll('[data-testid="order-item"], .order-item, .order-product');

      itemEls.forEach((item, index) => {
        const nameEl = item.querySelector('.item-name, .product-name');
        const priceEl = item.querySelector('.item-price, .unit-price');
        const qtyEl = item.querySelector('.quantity, .item-quantity');

        const priceText = priceEl?.textContent?.trim() || "0";
        const priceMatch = priceText.match(/[\d.]+/);
        const price = priceMatch ? parseFloat(priceMatch[0]) : 0;
        const quantity = parseInt(qtyEl?.textContent?.trim() || "1", 10);

        if (nameEl?.textContent?.trim()) {
          items.push({
            itemId: item.getAttribute("data-item-id") || `item-${index}`,
            productId: item.getAttribute("data-product-id") || `product-${index}`,
            name: nameEl.textContent.trim(),
            quantity,
            price,
            totalPrice: price * quantity,
          });
        }
      });

      const totalText = totalEl?.textContent?.trim() || "0";
      const totalMatch = totalText.match(/[\d.]+/);

      return {
        orderId: id,
        date: dateEl?.textContent?.trim() || "",
        status: statusEl?.textContent?.trim() || "Unknown",
        total: totalMatch ? parseFloat(totalMatch[0]) : 0,
        itemCount: items.length,
        items,
        deliveryDate: deliveryEl?.textContent?.trim(),
        deliveryAddress: addressEl?.textContent?.trim(),
        paymentMethod: paymentEl?.textContent?.trim(),
      };
    }, orderId);
  } catch (error) {
    throw new Error(`Failed to get order details: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getOrderDetails(orderId: string): Promise<OrderDetail> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => getOrderDetailsInSession(session, orderId));
}

export async function clipCouponInSession(
  session: SafewayAccountSession,
  couponId: string
): Promise<SafewayOperationResult> {
  assertAuthenticated(session);
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/foru/coupons-deals.html`);

    await page.waitForSelector('.coupon-item, [data-testid="coupon"], .deal-card', {
      timeout: 15_000,
    }).catch(() => null);

    await page.waitForTimeout(1_500);

    const beforeState = await readCouponClipState(page, couponId);

    if (!beforeState.clipped) {
      await page.evaluate((id: string) => {
        const coupons = document.querySelectorAll('[data-testid="coupon"], .coupon-item, .coupon-card');

        for (const coupon of coupons) {
          const couponDataId = coupon.getAttribute("data-coupon-id") || coupon.getAttribute("data-id");
          if (couponDataId === id) {
            const clipBtn = coupon.querySelector(
              'button:has-text("Clip"), button[data-testid="clip-coupon"], .clip-btn, button:has-text("Add")'
            ) as HTMLButtonElement | null;
            clipBtn?.click();
            break;
          }
        }
      }, couponId);
    }

    await page.waitForTimeout(1_500);

    const afterState = await readCouponClipState(page, couponId);
    return verifyClipCouponPostcondition(beforeState, afterState, couponId);
  } catch (error) {
    throw new Error(`Failed to clip coupon: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function clipCoupon(couponId: string): Promise<SafewayOperationResult> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => clipCouponInSession(session, couponId));
}

export async function getWeeklyDealsInSession(session: SafewayAccountSession): Promise<Deal[]> {
  const { page } = session;

  try {
    await navigateTo(session, `${getBaseUrl(session.storefront)}/foru/weekly-ad.html`);

    await page.waitForSelector('.deal-item, [data-testid="deal"], .weekly-deal, .ad-item', {
      timeout: 15_000,
    }).catch(() => null);

    await page.waitForTimeout(2_000);

    return page.evaluate(() => {
      const dealElements = document.querySelectorAll(
        '[data-testid="deal"], .deal-item, .weekly-deal, .ad-item, .sale-item'
      );

      return Array.from(dealElements)
        .slice(0, 30)
        .map((deal, index) => {
          const titleEl = deal.querySelector('[data-testid="deal-title"], .deal-title, .item-name, h3, h4');
          const descEl = deal.querySelector('[data-testid="deal-description"], .deal-description, .deal-details');
          const discountEl = deal.querySelector('[data-testid="discount"], .discount, .sale-price, .deal-price');
          const validEl = deal.querySelector('[data-testid="valid-through"], .valid-through, .expiry-date');
          const categoryEl = deal.querySelector('[data-testid="category"], .category, .deal-category');
          const imgEl = deal.querySelector("img") as HTMLImageElement | null;

          return {
            dealId: deal.getAttribute("data-deal-id") || deal.getAttribute("data-id") || `deal-${index}`,
            title: titleEl?.textContent?.trim() || "Deal",
            description: descEl?.textContent?.trim() || "",
            discount: discountEl?.textContent?.trim() || "",
            validThrough: validEl?.textContent?.trim(),
            category: categoryEl?.textContent?.trim(),
            imageUrl: imgEl?.src,
          };
        });
    });
  } catch (error) {
    throw new Error(`Failed to get weekly deals: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getWeeklyDeals(): Promise<Deal[]> {
  const account = requireLegacyAccount();
  return withAuthenticatedAccountSession(account, (session) => getWeeklyDealsInSession(session));
}
