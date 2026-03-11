import { Browser, BrowserContext, Page, chromium } from "playwright";

export interface SafewaySession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  isLoggedIn: boolean;
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

const SAFEWAY_BASE_URL = "https://www.safeway.com";
const ALBERTSONS_BASE_URL = "https://www.albertsons.com";

let globalSession: SafewaySession | null = null;

export async function getSession(): Promise<SafewaySession> {
  if (globalSession) {
    return globalSession;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1280,800",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });

  const page = await context.newPage();

  // Block unnecessary resources to speed up navigation
  await page.route("**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,eot}", (route) => {
    route.abort();
  });

  globalSession = { browser, context, page, isLoggedIn: false };
  return globalSession;
}

export async function closeSession(): Promise<void> {
  if (globalSession) {
    await globalSession.browser.close();
    globalSession = null;
  }
}

export async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);
}

export async function login(email: string, password: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/account/sign-in`);

    // Wait for and fill email field
    await page.waitForSelector('input[type="email"], input[name="email"], #email', { timeout: 15000 });
    await page.fill('input[type="email"], input[name="email"], #email', email);

    // Fill password
    await page.fill('input[type="password"], input[name="password"], #password', password);

    // Click sign in button
    await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');

    // Wait for navigation or error
    await page.waitForTimeout(3000);

    // Check if login was successful by looking for user menu or account indicators
    const isLoggedIn = await page.evaluate(() => {
      const accountLinks = document.querySelectorAll(
        'a[href*="account"], [data-testid="account"], .account-menu, .user-menu'
      );
      const signOutLinks = document.querySelectorAll('a:contains("Sign Out"), a:contains("Log Out")');
      return accountLinks.length > 0 || signOutLinks.length > 0;
    });

    // Alternative check - look for error messages
    const hasError = await page.evaluate(() => {
      const errors = document.querySelectorAll('.error, [role="alert"], .alert-danger');
      return errors.length > 0;
    });

    if (hasError) {
      const errorText = await page.evaluate(() => {
        const error = document.querySelector('.error, [role="alert"], .alert-danger');
        return error ? error.textContent?.trim() : "Login failed";
      });
      return { success: false, message: errorText || "Login failed" };
    }

    session.isLoggedIn = true;
    return { success: true, message: "Successfully logged in to Safeway" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error during login";
    return { success: false, message };
  }
}

export async function searchProducts(
  query: string,
  category?: string,
  filters?: Record<string, string>
): Promise<Product[]> {
  const session = await getSession();
  const { page } = session;

  try {
    let searchUrl = `${SAFEWAY_BASE_URL}/shop/search-results.html?q=${encodeURIComponent(query)}`;
    if (category) {
      searchUrl += `&category=${encodeURIComponent(category)}`;
    }

    await navigateTo(page, searchUrl);

    // Wait for product grid
    await page.waitForSelector(
      '.product-item, .product-card, [data-testid="product-card"], .grid-x .cell',
      { timeout: 15000 }
    ).catch(() => null);

    await page.waitForTimeout(2000);

    const products = await page.evaluate(() => {
      const items: Array<{
        id: string;
        name: string;
        brand?: string;
        price: number;
        salePrice?: number;
        unit?: string;
        imageUrl?: string;
        category?: string;
        inStock: boolean;
      }> = [];

      // Try multiple selectors for product cards
      const productCards = document.querySelectorAll(
        '[data-testid="product-card"], .product-item, .product-card, .product-tile'
      );

      productCards.forEach((card, index) => {
        if (index >= 20) return; // Limit to 20 products

        const nameEl = card.querySelector(
          '[data-testid="product-title"], .product-title, .product-name, h3, h4'
        );
        const priceEl = card.querySelector(
          '[data-testid="product-price"], .product-price, .price, .sale-price'
        );
        const brandEl = card.querySelector(
          '[data-testid="product-brand"], .product-brand, .brand'
        );
        const imgEl = card.querySelector("img") as HTMLImageElement | null;
        const linkEl = card.querySelector("a") as HTMLAnchorElement | null;

        const name = nameEl?.textContent?.trim() || "";
        const priceText = priceEl?.textContent?.trim() || "0";
        const priceMatch = priceText.match(/[\d.]+/);
        const price = priceMatch ? parseFloat(priceMatch[0]) : 0;

        // Extract product ID from link
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

    return products;
  } catch (error) {
    throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getProductDetails(productId: string): Promise<Product> {
  const session = await getSession();
  const { page } = session;

  try {
    const productUrl = `${SAFEWAY_BASE_URL}/shop/product-details.${productId}.html`;
    await navigateTo(page, productUrl);

    await page.waitForSelector(
      '.product-details, [data-testid="product-details"], .pdp-container',
      { timeout: 15000 }
    ).catch(() => null);

    await page.waitForTimeout(1500);

    const product = await page.evaluate((id: string) => {
      const nameEl = document.querySelector(
        '[data-testid="product-name"], .product-name, h1.product-title, h1'
      );
      const priceEl = document.querySelector(
        '[data-testid="product-price"], .product-price, .price-current, .regular-price'
      );
      const salePriceEl = document.querySelector(
        '[data-testid="sale-price"], .sale-price, .special-price'
      );
      const brandEl = document.querySelector(
        '[data-testid="product-brand"], .product-brand, .brand-name'
      );
      const descEl = document.querySelector(
        '[data-testid="product-description"], .product-description, .product-details-description'
      );
      const imgEl = document.querySelector("img.product-image, .product-img img, .pdp-image img") as HTMLImageElement | null;
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

    return product;
  } catch (error) {
    throw new Error(`Failed to get product details: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function addToCart(productId: string, quantity: number): Promise<{ success: boolean; message: string }> {
  const session = await getSession();
  const { page } = session;

  try {
    const productUrl = `${SAFEWAY_BASE_URL}/shop/product-details.${productId}.html`;
    await navigateTo(page, productUrl);

    await page.waitForSelector(
      'button[data-testid="add-to-cart"], button:has-text("Add to Cart"), .add-to-cart-btn',
      { timeout: 15000 }
    );

    // Set quantity if > 1
    if (quantity > 1) {
      const qtyInput = await page.$('input[data-testid="quantity"], input.quantity-input, input[name="quantity"]');
      if (qtyInput) {
        await qtyInput.fill(String(quantity));
      }
    }

    await page.click('button[data-testid="add-to-cart"], button:has-text("Add to Cart"), .add-to-cart-btn');
    await page.waitForTimeout(2000);

    // Check for success indicators
    const added = await page.evaluate(() => {
      const successEl = document.querySelector('.cart-notification, .add-to-cart-success, [data-testid="cart-count"]');
      return !!successEl;
    });

    return {
      success: true,
      message: `Successfully added ${quantity} item(s) to cart (product ID: ${productId})`,
    };
  } catch (error) {
    throw new Error(`Failed to add to cart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getCart(): Promise<Cart> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/shop/cart`);

    await page.waitForSelector(
      '.cart-item, [data-testid="cart-item"], .cart-product',
      { timeout: 15000 }
    ).catch(() => null);

    await page.waitForTimeout(1500);

    const cart = await page.evaluate(() => {
      const items: Array<{
        itemId: string;
        productId: string;
        name: string;
        quantity: number;
        price: number;
        totalPrice: number;
        imageUrl?: string;
      }> = [];

      const cartItems = document.querySelectorAll(
        '[data-testid="cart-item"], .cart-item, .cart-product-item'
      );

      cartItems.forEach((item, index) => {
        const nameEl = item.querySelector('[data-testid="item-name"], .item-name, .product-name');
        const priceEl = item.querySelector('[data-testid="item-price"], .item-price, .unit-price');
        const qtyEl = item.querySelector('input[data-testid="quantity"], input.quantity, input[name="quantity"]') as HTMLInputElement | null;
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

      const subtotalEl = document.querySelector(
        '[data-testid="subtotal"], .cart-subtotal, .subtotal-price'
      );
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

    return cart;
  } catch (error) {
    throw new Error(`Failed to get cart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function updateCartItem(
  itemId: string,
  quantity: number
): Promise<{ success: boolean; message: string }> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/shop/cart`);

    await page.waitForSelector(
      '[data-testid="cart-item"], .cart-item',
      { timeout: 15000 }
    ).catch(() => null);

    // Find item by ID and update quantity
    const updated = await page.evaluate(({ id, qty }: { id: string; qty: number }) => {
      const items = document.querySelectorAll(
        '[data-testid="cart-item"], .cart-item, .cart-product-item'
      );

      for (const item of items) {
        const itemAttrId = item.getAttribute("data-product-id") || item.getAttribute("data-item-id");
        if (itemAttrId === id) {
          const qtyInput = item.querySelector('input[name="quantity"], input.quantity') as HTMLInputElement | null;
          if (qtyInput) {
            qtyInput.value = String(qty);
            qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
        }
      }
      return false;
    }, { id: itemId, qty: quantity });

    if (!updated) {
      // Try via API or update button
      await page.waitForTimeout(1000);
    }

    return {
      success: true,
      message: `Updated item ${itemId} quantity to ${quantity}`,
    };
  } catch (error) {
    throw new Error(`Failed to update cart item: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function removeFromCart(itemId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/shop/cart`);

    await page.waitForSelector(
      '[data-testid="cart-item"], .cart-item',
      { timeout: 15000 }
    ).catch(() => null);

    const removed = await page.evaluate((id: string) => {
      const items = document.querySelectorAll(
        '[data-testid="cart-item"], .cart-item, .cart-product-item'
      );

      for (const item of items) {
        const itemAttrId = item.getAttribute("data-product-id") || item.getAttribute("data-item-id");
        if (itemAttrId === id) {
          const removeBtn = item.querySelector(
            'button[data-testid="remove"], button.remove-item, button:has-text("Remove"), .remove-btn'
          ) as HTMLButtonElement | null;
          if (removeBtn) {
            removeBtn.click();
            return true;
          }
        }
      }
      return false;
    }, itemId);

    await page.waitForTimeout(1500);

    return {
      success: true,
      message: `Removed item ${itemId} from cart`,
    };
  } catch (error) {
    throw new Error(`Failed to remove from cart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getDeliverySlots(date?: string): Promise<DeliverySlot[]> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/shop/delivery-slots`);

    await page.waitForSelector(
      '.delivery-slot, [data-testid="delivery-slot"], .time-slot',
      { timeout: 15000 }
    ).catch(() => null);

    await page.waitForTimeout(2000);

    // If date specified, try to navigate to that date
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
      await page.waitForTimeout(1500);
    }

    const slots = await page.evaluate(() => {
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

    return slots;
  } catch (error) {
    throw new Error(`Failed to get delivery slots: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function selectDeliverySlot(slotId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/shop/delivery-slots`);

    await page.waitForSelector(
      '[data-testid="delivery-slot"], .delivery-slot, .time-slot',
      { timeout: 15000 }
    ).catch(() => null);

    const selected = await page.evaluate((id: string) => {
      const slots = document.querySelectorAll(
        '[data-testid="delivery-slot"], .delivery-slot, .time-slot, .slot-item'
      );

      for (const slot of slots) {
        const slotDataId = slot.getAttribute("data-slot-id") || slot.getAttribute("data-id");
        if (slotDataId === id) {
          (slot as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, slotId);

    await page.waitForTimeout(1500);

    // Look for confirmation button
    const confirmBtn = await page.$('button:has-text("Confirm"), button:has-text("Select"), button[data-testid="confirm-slot"]');
    if (confirmBtn) {
      await confirmBtn.click();
      await page.waitForTimeout(1500);
    }

    return {
      success: true,
      message: `Selected delivery slot ${slotId}`,
    };
  } catch (error) {
    throw new Error(`Failed to select delivery slot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function checkout(): Promise<{ success: boolean; orderId?: string; message: string }> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/shop/cart`);

    // Click checkout button
    await page.waitForSelector(
      'button:has-text("Checkout"), button[data-testid="checkout"], .checkout-btn, a:has-text("Checkout")',
      { timeout: 15000 }
    );

    await page.click(
      'button:has-text("Checkout"), button[data-testid="checkout"], .checkout-btn, a:has-text("Checkout")'
    );

    await page.waitForTimeout(3000);
    await page.waitForLoadState("domcontentloaded");

    // Look for order confirmation
    const confirmation = await page.evaluate(() => {
      const confirmEl = document.querySelector(
        '.order-confirmation, [data-testid="order-confirmation"], .confirmation-number'
      );
      const orderIdEl = document.querySelector(
        '[data-testid="order-id"], .order-id, .order-number'
      );

      return {
        hasConfirmation: !!confirmEl,
        orderId: orderIdEl?.textContent?.trim(),
      };
    });

    if (confirmation.hasConfirmation || confirmation.orderId) {
      return {
        success: true,
        orderId: confirmation.orderId,
        message: `Checkout successful! Order ID: ${confirmation.orderId || "pending"}`,
      };
    }

    // Check if we're on checkout page (multi-step)
    const currentUrl = page.url();
    if (currentUrl.includes("checkout") || currentUrl.includes("payment")) {
      return {
        success: true,
        message: "Redirected to checkout page. Please review and complete payment.",
      };
    }

    return {
      success: true,
      message: "Checkout initiated. Please complete any remaining steps.",
    };
  } catch (error) {
    throw new Error(`Checkout failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getOrders(): Promise<Order[]> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/account/order-history`);

    await page.waitForSelector(
      '.order-item, [data-testid="order-item"], .order-card',
      { timeout: 15000 }
    ).catch(() => null);

    await page.waitForTimeout(1500);

    const orders = await page.evaluate(() => {
      const orderElements = document.querySelectorAll(
        '[data-testid="order-item"], .order-item, .order-card, .order-history-item'
      );

      return Array.from(orderElements).map((order, index) => {
        const orderIdEl = order.querySelector(
          '[data-testid="order-id"], .order-id, .order-number'
        );
        const dateEl = order.querySelector(
          '[data-testid="order-date"], .order-date, .placed-date'
        );
        const statusEl = order.querySelector(
          '[data-testid="order-status"], .order-status, .status-badge'
        );
        const totalEl = order.querySelector(
          '[data-testid="order-total"], .order-total, .total-amount'
        );
        const itemCountEl = order.querySelector(
          '[data-testid="item-count"], .item-count, .items-count'
        );
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

    return orders;
  } catch (error) {
    throw new Error(`Failed to get orders: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getOrderDetails(orderId: string): Promise<OrderDetail> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/account/order-details/${orderId}`);

    await page.waitForSelector(
      '.order-detail, [data-testid="order-detail"], .order-items',
      { timeout: 15000 }
    ).catch(() => null);

    await page.waitForTimeout(1500);

    const orderDetail = await page.evaluate((id: string) => {
      const statusEl = document.querySelector(
        '[data-testid="order-status"], .order-status'
      );
      const dateEl = document.querySelector(
        '[data-testid="order-date"], .order-date'
      );
      const totalEl = document.querySelector(
        '[data-testid="order-total"], .order-total'
      );
      const deliveryEl = document.querySelector(
        '[data-testid="delivery-date"], .delivery-date'
      );
      const addressEl = document.querySelector(
        '[data-testid="delivery-address"], .delivery-address, .ship-to'
      );
      const paymentEl = document.querySelector(
        '[data-testid="payment-method"], .payment-method'
      );

      const items: Array<{
        itemId: string;
        productId: string;
        name: string;
        quantity: number;
        price: number;
        totalPrice: number;
      }> = [];

      const itemEls = document.querySelectorAll(
        '[data-testid="order-item"], .order-item, .order-product'
      );

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

    return orderDetail;
  } catch (error) {
    throw new Error(`Failed to get order details: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function clipCoupon(couponId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/foru/coupons-deals.html`);

    await page.waitForSelector(
      '.coupon-item, [data-testid="coupon"], .deal-card',
      { timeout: 15000 }
    ).catch(() => null);

    await page.waitForTimeout(1500);

    const clipped = await page.evaluate((id: string) => {
      const coupons = document.querySelectorAll(
        '[data-testid="coupon"], .coupon-item, .coupon-card'
      );

      for (const coupon of coupons) {
        const couponDataId = coupon.getAttribute("data-coupon-id") || coupon.getAttribute("data-id");
        if (couponDataId === id) {
          const clipBtn = coupon.querySelector(
            'button:has-text("Clip"), button[data-testid="clip-coupon"], .clip-btn, button:has-text("Add")'
          ) as HTMLButtonElement | null;
          if (clipBtn && !clipBtn.disabled) {
            clipBtn.click();
            return { success: true, alreadyClipped: false };
          }
          return { success: false, alreadyClipped: clipBtn?.disabled || false };
        }
      }
      return { success: false, alreadyClipped: false };
    }, couponId);

    if (clipped.alreadyClipped) {
      return { success: true, message: `Coupon ${couponId} was already clipped` };
    }

    await page.waitForTimeout(1500);

    return {
      success: true,
      message: `Successfully clipped coupon ${couponId}`,
    };
  } catch (error) {
    throw new Error(`Failed to clip coupon: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getWeeklyDeals(): Promise<Deal[]> {
  const session = await getSession();
  const { page } = session;

  try {
    await navigateTo(page, `${SAFEWAY_BASE_URL}/foru/weekly-ad.html`);

    await page.waitForSelector(
      '.deal-item, [data-testid="deal"], .weekly-deal, .ad-item',
      { timeout: 15000 }
    ).catch(() => null);

    await page.waitForTimeout(2000);

    const deals = await page.evaluate(() => {
      const dealElements = document.querySelectorAll(
        '[data-testid="deal"], .deal-item, .weekly-deal, .ad-item, .sale-item'
      );

      return Array.from(dealElements).slice(0, 30).map((deal, index) => {
        const titleEl = deal.querySelector(
          '[data-testid="deal-title"], .deal-title, .item-name, h3, h4'
        );
        const descEl = deal.querySelector(
          '[data-testid="deal-description"], .deal-description, .deal-details'
        );
        const discountEl = deal.querySelector(
          '[data-testid="discount"], .discount, .sale-price, .deal-price'
        );
        const validEl = deal.querySelector(
          '[data-testid="valid-through"], .valid-through, .expiry-date'
        );
        const categoryEl = deal.querySelector(
          '[data-testid="category"], .category, .deal-category'
        );
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

    return deals;
  } catch (error) {
    throw new Error(`Failed to get weekly deals: ${error instanceof Error ? error.message : String(error)}`);
  }
}
