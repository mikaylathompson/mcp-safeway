const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  addToCartInSession,
  closeAllSessions,
  getCartInSession,
  getProductDetailsInSession,
  removeFromCartInSession,
  searchProductsInSession,
  updateCartItemInSession,
  withAuthenticatedAccountSession,
} = require("../dist/browser.js");

function createLiveAccount() {
  const email = process.env.SAFEWAY_LIVE_TEST_EMAIL || process.env.SAFEWAY_EMAIL;
  const password = process.env.SAFEWAY_LIVE_TEST_PASSWORD || process.env.SAFEWAY_PASSWORD;
  const phoneNumber = process.env.SAFEWAY_LIVE_TEST_PHONE_NUMBER || process.env.SAFEWAY_PHONE_NUMBER;
  const accountId = process.env.SAFEWAY_LIVE_TEST_ACCOUNT_ID || "live-integration";
  const sessionStatePath =
    process.env.SAFEWAY_LIVE_TEST_SESSION_STATE_PATH ||
    process.env.SAFEWAY_SESSION_STATE_PATH ||
    path.join(__dirname, "..", "tmp", `safeway-session-${accountId}.json`);

  if (!existsSync(sessionStatePath) && !phoneNumber && (!email || !password)) {
    return null;
  }

  return {
    accountId,
    email,
    password,
    phoneNumber,
    sessionStatePath,
    storefront: process.env.SAFEWAY_LIVE_TEST_STOREFRONT === "albertsons" ? "albertsons" : "safeway",
  };
}

function getTotalQuantity(cart, productId) {
  return cart.items
    .filter((item) => item.productId === productId)
    .reduce((sum, item) => sum + item.quantity, 0);
}

const liveAccount = createLiveAccount();

test(
  "live search and product details are readable",
  {
    skip: !liveAccount,
  },
  async () => {
    try {
      await withAuthenticatedAccountSession(liveAccount, async (session) => {
        const query = process.env.SAFEWAY_LIVE_TEST_QUERY || "organic milk";
        const products = await searchProductsInSession(session, query);

        assert.ok(products.length > 0, `expected search results for query "${query}"`);

        const product = products.find((candidate) => candidate.id) || products[0];
        const details = await getProductDetailsInSession(session, product.id);

        assert.equal(details.id, product.id);
        assert.ok(details.name);
      });
    } finally {
      await closeAllSessions();
    }
  }
);

test(
  "live add-to-cart can be verified and cleaned up",
  {
    skip: !liveAccount || process.env.SAFEWAY_LIVE_TEST_ALLOW_CART_MUTATIONS !== "1",
  },
  async () => {
    try {
      await withAuthenticatedAccountSession(liveAccount, async (session) => {
        const query = process.env.SAFEWAY_LIVE_TEST_MUTATION_QUERY || process.env.SAFEWAY_LIVE_TEST_QUERY || "banana";
        const products = await searchProductsInSession(session, query);
        const product = products.find((candidate) => candidate.inStock && candidate.id) || products[0];

        assert.ok(product, `expected at least one product for query "${query}"`);

        const beforeCart = await getCartInSession(session);
        const beforeItemQuantities = new Map(beforeCart.items.map((item) => [item.itemId, item.quantity]));
        const beforeTotal = getTotalQuantity(beforeCart, product.id);

        const addResult = await addToCartInSession(session, product.id, 1);
        assert.equal(addResult.success, true);

        const afterCart = await getCartInSession(session);
        assert.equal(getTotalQuantity(afterCart, product.id), beforeTotal + 1);

        const changedItems = afterCart.items.filter((item) => {
          if (item.productId !== product.id) {
            return false;
          }

          return item.quantity !== (beforeItemQuantities.get(item.itemId) || 0);
        });

        assert.ok(changedItems.length > 0, "expected at least one changed cart line after add-to-cart");

        for (const item of changedItems) {
          const previousQuantity = beforeItemQuantities.get(item.itemId) || 0;

          if (previousQuantity === 0) {
            const removeResult = await removeFromCartInSession(session, item.itemId);
            assert.equal(removeResult.success, true);
            continue;
          }

          const updateResult = await updateCartItemInSession(session, item.itemId, previousQuantity);
          assert.equal(updateResult.success, true);
        }

        const finalCart = await getCartInSession(session);
        assert.equal(getTotalQuantity(finalCart, product.id), beforeTotal);
      });
    } finally {
      await closeAllSessions();
    }
  }
);
