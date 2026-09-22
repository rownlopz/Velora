const Cart = require("../../models/order/cartModel");
const Variant = require("../../models/product/variantModel");
const Product = require("../../models/product/productModel");
const { checkVariantAvailability } = require("./productDetailService");
const { removeFromWishlist } = require("./wishlistService");

// Reasonable per-item cap so one shopper can't buy out the entire stock
// of a variant in one line item. A real store would likely make this
// configurable per-product; a fixed constant is the right size for this
// week's scope.
const MAX_QUANTITY_PER_ITEM = 5;

const getOrCreateCart = async (userId) => {
    let cart = await Cart.findOne({ userId });
    if (!cart) {
        cart = await Cart.create({ userId, items: [] });
    }
    return cart;
};

/**
 * Returns the cart with every item re-validated against the CURRENT
 * database state — never trusts the priceSnapshot or whatever quantity
 * was stored as still being valid. An item whose product/variant became
 * blocked, unlisted, or deleted since it was added is flagged rather
 * than silently shown as if nothing changed.
 */
const getCartDetails = async (userId) => {
    const cart = await getOrCreateCart(userId);

    const items = await Promise.all(
        cart.items.map(async (item) => {
            const variant = await Variant.findById(item.variantId);
            const product = variant ? await Product.findById(variant.productId) : null;

            const isAvailable = !!(
                variant && variant.isActive &&
                product && !product.isDeleted && product.status === "ACTIVE" &&
                variant.stock > 0
            );

            const currentPrice = variant ? (variant.salePrice || variant.regularPrice) : item.priceSnapshot;
            const cappedQuantity = variant ? Math.min(item.quantity, variant.stock) : item.quantity;

            return {
                variantId: item.variantId,
                quantity: item.quantity,
                priceSnapshot: item.priceSnapshot,
                product,
                variant,
                isAvailable,
                currentPrice,
                lineTotal: isAvailable ? currentPrice * cappedQuantity : 0,
                stockExceeded: variant ? item.quantity > variant.stock : false,
            };
        })
    );

    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    const hasUnavailableItems = items.some((i) => !i.isAvailable || i.stockExceeded);

    return { items, subtotal, hasUnavailableItems };
};

/**
 * Adds a variant to the cart, or increases its quantity if it's already
 * there (never creates a duplicate line item for the same variant).
 * Every check here re-reads the database — the requested quantity is
 * the only thing taken from the client.
 */
const addToCart = async (userId, variantId, requestedQuantity = 1) => {
    const quantity = Math.max(1, Math.floor(Number(requestedQuantity) || 1));

    const availability = await checkVariantAvailability(variantId);
    if (!availability.available) {
        return { success: false, message: availability.reason };
    }

    const { variant } = availability;
    const cart = await getOrCreateCart(userId);

    const existingItem = cart.items.find((item) => item.variantId.toString() === variantId.toString());
    const currentQtyInCart = existingItem ? existingItem.quantity : 0;
    const newQuantity = Math.min(currentQtyInCart + quantity, MAX_QUANTITY_PER_ITEM);

    if (newQuantity > variant.stock) {
        return { success: false, message: `Only ${variant.stock} left in stock.` };
    }

    if (existingItem) {
        existingItem.quantity = newQuantity;
        existingItem.priceSnapshot = variant.salePrice || variant.regularPrice;
    } else {
        cart.items.push({
            variantId,
            quantity: newQuantity,
            priceSnapshot: variant.salePrice || variant.regularPrice,
        });
    }

    await cart.save();

    // Per spec: adding to cart removes the item from the wishlist, if
    // wishlist functionality exists (it does, built alongside this).
    await removeFromWishlist(userId, variantId);

    return { success: true };
};

const changeQuantity = async (userId, variantId, direction) => {
    const cart = await getOrCreateCart(userId);
    const item = cart.items.find((i) => i.variantId.toString() === variantId.toString());

    if (!item) {
        return { success: false, message: "Item not found in cart" };
    }

    const availability = await checkVariantAvailability(variantId);
    if (!availability.available) {
        return { success: false, message: availability.reason };
    }

    if (direction === "increment") {
        const nextQuantity = item.quantity + 1;
        if (nextQuantity > MAX_QUANTITY_PER_ITEM) {
            return { success: false, message: `Maximum ${MAX_QUANTITY_PER_ITEM} per item.` };
        }
        if (nextQuantity > availability.variant.stock) {
            return { success: false, message: `Only ${availability.variant.stock} left in stock.` };
        }
        item.quantity = nextQuantity;
    } else if (direction === "decrement") {
        // Floors at 1 — removing an item entirely is a separate, explicit
        // action (removeFromCart), not an implicit side effect of
        // decrementing past 1.
        item.quantity = Math.max(1, item.quantity - 1);
    }

    await cart.save();
    return { success: true };
};

const removeFromCart = async (userId, variantId) => {
    await Cart.updateOne(
        { userId },
        { $pull: { items: { variantId } } }
    );
    return { success: true };
};

module.exports = {
    getCartDetails,
    addToCart,
    changeQuantity,
    removeFromCart,
    MAX_QUANTITY_PER_ITEM,
};
