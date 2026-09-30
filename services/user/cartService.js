const Cart = require("../../models/order/cartModel");
const Variant = require("../../models/product/variantModel");
const Product = require("../../models/product/productModel");
const { checkVariantAvailability } = require("./productDetailService");
const { removeFromWishlist } = require("./wishlistService");


const MAX_QUANTITY_PER_ITEM = 5;

const getOrCreateCart = async (userId) => {
    let cart = await Cart.findOne({ userId });
    if (!cart) {
        cart = await Cart.create({ userId, items: [] });
    }
    return cart;
};


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
