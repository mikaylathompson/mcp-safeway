# @striderlabs/mcp-safeway

An MCP (Model Context Protocol) server connector for Safeway/Albertsons grocery delivery, powered by Playwright browser automation.

## Overview

This package provides an MCP server that enables AI assistants to interact with Safeway and Albertsons online grocery platforms. It uses Playwright to automate browser interactions, allowing you to search products, manage your cart, schedule deliveries, and place orders.

## Installation

### From npm

```bash
npm install -g @striderlabs/mcp-safeway
npx playwright install chromium
```

### From source

```bash
git clone https://github.com/markswendsen-code/mcp-safeway.git
cd mcp-safeway
npm install
npx playwright install chromium
npm run build
```

## Configuration

### Claude Desktop

Add the following to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "safeway": {
      "command": "striderlabs-mcp-safeway"
    }
  }
}
```

### Other MCP Clients

Run the server directly:

```bash
striderlabs-mcp-safeway
```

Or with npx:

```bash
npx @striderlabs/mcp-safeway
```

## Testing

Build the project before running tests:

```bash
npm run build
node --test test/*.test.js
```

The default test run is local-only. The live integration suite is opt-in and only covers safe flows: search, product details, add-to-cart verification, cart readback, and cleanup removal. It does not schedule delivery, check out, or perform other irreversible actions.

For a more reliable live setup, bootstrap a persistent Safeway browser session once with a phone number and verification code:

```bash
npm run build
node scripts/bootstrap-session.js
```

The bootstrap script reads `SAFEWAY_PHONE_NUMBER` and saves Playwright storage state to `tmp/safeway-session-live-integration.json` by default. Future live tests and account queries reuse that saved browser state automatically.

You can also continue to use `SAFEWAY_LIVE_TEST_EMAIL` and `SAFEWAY_LIVE_TEST_PASSWORD`, or `SAFEWAY_EMAIL` and `SAFEWAY_PASSWORD`, for the live read-only test:

```bash
node --test test/live.integration.test.js
```

To enable the live cart mutation test as well, set:

```bash
SAFEWAY_LIVE_TEST_ALLOW_CART_MUTATIONS=1
```

## Tools

### Authentication

#### `safeway_login`
Log in to your Safeway/Albertsons account.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | Yes | Your Safeway account email |
| `password` | string | Yes | Your Safeway account password |

**Example:**
```json
{
  "email": "user@example.com",
  "password": "your-password"
}
```

---

### Products

#### `safeway_search_products`
Search for products on Safeway.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., "organic milk") |
| `category` | string | No | Filter by category (e.g., "produce", "dairy") |
| `filters` | object | No | Additional filters as key-value pairs |

**Example:**
```json
{
  "query": "organic whole milk",
  "category": "dairy"
}
```

**Returns:** List of products with IDs, names, prices, and availability.

---

#### `safeway_get_product_details`
Get full details for a specific product.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `product_id` | string | Yes | Product ID from search results |

**Returns:** Full product info including description, brand, UPC, and pricing.

---

### Cart Management

#### `safeway_add_to_cart`
Add a product to your cart.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `product_id` | string | Yes | Product ID to add |
| `quantity` | number | Yes | Number of items (minimum: 1) |

---

#### `safeway_get_cart`
Retrieve current cart contents.

**Returns:** All cart items with quantities, prices, subtotal, and estimated total.

---

#### `safeway_update_cart_item`
Update the quantity of a cart item.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `item_id` | string | Yes | Cart item ID |
| `quantity` | number | Yes | New quantity |

---

#### `safeway_remove_from_cart`
Remove an item from the cart.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `item_id` | string | Yes | Cart item ID to remove |

---

### Delivery

#### `safeway_get_delivery_slots`
Get available delivery time slots.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Date to check (YYYY-MM-DD format) |

**Returns:** Available time slots with IDs, times, availability, and delivery fees.

---

#### `safeway_select_delivery_slot`
Select a delivery time slot.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slot_id` | string | Yes | Slot ID from `safeway_get_delivery_slots` |

---

### Checkout & Orders

#### `safeway_checkout`
Proceed to checkout with the current cart.

**Returns:** Confirmation status and order ID if successful.

---

#### `safeway_get_orders`
Get your order history.

**Returns:** List of past and current orders with statuses and totals.

---

#### `safeway_get_order_details`
Get detailed information for a specific order.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `order_id` | string | Yes | Order ID from order history |

**Returns:** Full order details including items, delivery info, and payment method.

---

### Deals & Coupons

#### `safeway_clip_coupon`
Clip a digital coupon to your account.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `coupon_id` | string | Yes | Coupon ID to clip |

---

#### `safeway_get_weekly_deals`
Get current weekly deals and sales.

**Returns:** List of featured deals with titles, discounts, and validity dates.

---

## Usage Example

Here's a typical workflow with an AI assistant:

1. **Login:** `safeway_login` with your credentials
2. **Browse deals:** `safeway_get_weekly_deals` to see current sales
3. **Search products:** `safeway_search_products` with query "chicken breast"
4. **Add to cart:** `safeway_add_to_cart` with product ID and quantity
5. **Check cart:** `safeway_get_cart` to review items
6. **Pick delivery:** `safeway_get_delivery_slots` then `safeway_select_delivery_slot`
7. **Place order:** `safeway_checkout`

## Notes

- This tool uses browser automation and requires a valid Safeway/Albertsons account
- Safeway and Albertsons share the same platform; either site can be used
- A delivery address must be configured in your Safeway account before using delivery features
- Playwright's Chromium browser is launched headlessly during operation
- Session state is maintained across tool calls within the same server process

## Requirements

- Node.js >= 18.0.0
- Chromium (installed via `npx playwright install chromium`)

## License

MIT

## Contributing

Contributions welcome! Please open an issue or pull request on GitHub.
