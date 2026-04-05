const assert = require("node:assert/strict");
const test = require("node:test");

const browser = require("../dist/browser.js");

function createCart(items) {
  return {
    items: items.map((item) => ({
      name: item.name || item.productId,
      price: item.price || 1,
      totalPrice: (item.price || 1) * item.quantity,
      ...item,
    })),
    subtotal: 0,
    estimatedTotal: 0,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
  };
}

function assertVerificationError(error, pattern) {
  assert.equal(error && error.name, "MutationVerificationError");
  assert.match(error.message, pattern);
  return true;
}

test("add-to-cart verification fails when quantity does not change", () => {
  const beforeCart = createCart([{ itemId: "item-1", productId: "prod-1", quantity: 1 }]);
  const afterCart = createCart([{ itemId: "item-1", productId: "prod-1", quantity: 1 }]);

  assert.throws(
    () => browser.verifyAddToCartPostcondition(beforeCart, afterCart, "prod-1", 1),
    (error) => assertVerificationError(error, /unable to verify add-to-cart/i)
  );
});

test("update-cart verification fails when the requested quantity is not present after the change", () => {
  assert.throws(
    () =>
      browser.verifyUpdateCartItemPostcondition(
        [{ itemId: "item-1", productId: "prod-1", quantity: 1 }],
        [{ itemId: "item-1", productId: "prod-1", quantity: 2 }],
        "item-1",
        4
      ),
    (error) => assertVerificationError(error, /expected 4, found 2/i)
  );
});

test("remove-from-cart verification fails when the item is still present", () => {
  assert.throws(
    () =>
      browser.verifyRemoveFromCartPostcondition(
        [{ itemId: "item-1", productId: "prod-1", quantity: 1 }],
        [{ itemId: "item-1", productId: "prod-1", quantity: 1 }],
        "item-1"
      ),
    (error) => assertVerificationError(error, /still exists in cart/i)
  );
});

test("delivery-slot verification fails when the selected slot is not confirmed", () => {
  assert.throws(
    () =>
      browser.verifySelectDeliverySlotPostcondition(
        {
          slots: [
            { slotId: "slot-1", available: true, selected: false },
            { slotId: "slot-2", available: true, selected: false },
          ],
        },
        {
          slots: [
            { slotId: "slot-1", available: true, selected: false },
            { slotId: "slot-2", available: true, selected: true },
          ],
          selectedSlotId: "slot-2",
        },
        "slot-1"
      ),
    (error) => assertVerificationError(error, /unable to verify selection/i)
  );
});

test("clip-coupon verification fails when the coupon still is not clipped", () => {
  assert.throws(
    () =>
      browser.verifyClipCouponPostcondition(
        { couponId: "coupon-1", found: true, clipped: false, canClip: true },
        { couponId: "coupon-1", found: true, clipped: false, canClip: true },
        "coupon-1"
      ),
    (error) => assertVerificationError(error, /unable to verify that coupon coupon-1 was clipped/i)
  );
});

test("checkout verification fails when neither confirmation nor checkout flow is visible", () => {
  assert.throws(
    () =>
      browser.verifyCheckoutPostcondition({
        url: "https://www.safeway.com/shop/cart",
        hasConfirmation: false,
        orderId: undefined,
        inCheckoutFlow: false,
      }),
    (error) => assertVerificationError(error, /unable to verify checkout progress/i)
  );
});

test("checkout verification succeeds once the browser reaches checkout flow", () => {
  const result = browser.verifyCheckoutPostcondition({
    url: "https://www.safeway.com/checkout",
    hasConfirmation: false,
    orderId: undefined,
    inCheckoutFlow: true,
  });

  assert.equal(result.success, true);
  assert.match(result.message, /redirected to checkout flow/i);
});
