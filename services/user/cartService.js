const Cart = require("../../models/order/cartModel");
const Variant = require("../../models/product/variantModel");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");
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


const { calculateCartPricing } = require("../common/pricingService");

const getCartDetails = async (userId, customCouponCode = null) => {
    const cart = await getOrCreateCart(userId);

    const rawItems = await Promise.all(
        cart.items.map(async (item) => {
            const variant = await Variant.findById(item.variantId);
            const product = variant ? await Product.findById(variant.productId) : null;
            let category = null;
            if (product && product.categoryId) {
                category = await Category.findById(product.categoryId);
            }

            const categoryUnlisted = !category || category.isDeleted === true || category.isActive === false;
            const productUnlisted = !product || product.isDeleted || product.status !== "ACTIVE" || categoryUnlisted;
            const variantUnavailable = !variant || !variant.isActive;

            const isAvailable = !!(
                !productUnlisted && !variantUnavailable &&
                variant.stock > 0
            );

            return {
                variantId: item.variantId,
                quantity: item.quantity,
                priceSnapshot: item.priceSnapshot,
                product,
                variant,
                isAvailable,
                productUnlisted,
                stockExceeded: variant ? item.quantity > variant.stock : false,
            };
        })
    );

    // Auto-remove unlisted/deleted products from the cart document.
    const unlistedVariantIds = rawItems
        .filter((i) => i.productUnlisted || !i.variant)
        .map((i) => i.variantId.toString());

    if (unlistedVariantIds.length > 0) {
        await Cart.updateOne(
            { userId },
            { $pull: { items: { variantId: { $in: unlistedVariantIds.map((id) => require("mongoose").Types.ObjectId.createFromHexString(id)) } } } }
        );
    }

    const visibleItems = rawItems.filter((i) => !i.productUnlisted && i.variant);

    // Determine coupon code to evaluate
    const effectiveCouponCode = customCouponCode !== null
        ? customCouponCode
        : (cart.appliedCoupon && cart.appliedCoupon.code ? cart.appliedCoupon.code : "");

    const pricing = await calculateCartPricing(visibleItems, effectiveCouponCode, userId);

    // If a saved coupon is no longer valid, automatically clear it from cart
    if (cart.appliedCoupon && cart.appliedCoupon.code && pricing.couponError) {
        await Cart.updateOne({ userId }, { $set: { appliedCoupon: null } });
    } else if (pricing.appliedCoupon && (!cart.appliedCoupon || cart.appliedCoupon.code !== pricing.appliedCoupon.code)) {
        await Cart.updateOne(
            { userId },
            {
                $set: {
                    appliedCoupon: {
                        couponId: pricing.appliedCoupon.couponId,
                        code: pricing.appliedCoupon.code,
                        discountType: pricing.appliedCoupon.discountType,
                        discountValue: pricing.appliedCoupon.discountValue,
                        discountAmount: pricing.couponDiscount,
                        appliedAt: new Date(),
                    },
                },
            }
        );
    }

    // Merge pricing outputs back into items
    const enrichedItems = pricing.items.map((pi, idx) => {
        const raw = visibleItems[idx];
        return {
            ...raw,
            ...pi,
            currentPrice: pi.effectiveUnitPrice,
            lineTotal: raw.isAvailable ? pi.lineTotal : 0,
        };
    });

    const hasUnavailableItems = visibleItems.some((i) => !i.isAvailable || i.stockExceeded);

    return {
        items: enrichedItems,
        rawSubtotal: pricing.rawSubtotal,
        subtotal: pricing.subtotal,
        totalOfferDiscount: pricing.totalOfferDiscount,
        couponDiscount: pricing.couponDiscount,
        appliedCoupon: pricing.appliedCoupon,
        couponError: pricing.couponError,
        taxRate: pricing.taxRate || 0.05,
        taxableAmount: pricing.taxableAmount,
        taxAmount: pricing.taxAmount,
        shippingFee: pricing.shippingFee,
        shippingThreshold: pricing.shippingThreshold,
        totalAmount: pricing.totalAmount,
        hasUnavailableItems,
        removedUnlistedCount: unlistedVariantIds.length,
    };
};

const applyCoupon = async (userId, couponCode) => {
    if (!couponCode || typeof couponCode !== "string" || !couponCode.trim()) {
        return { success: false, message: "Please enter a coupon code." };
    }

    const details = await getCartDetails(userId, couponCode.trim());
    if (details.couponError) {
        return { success: false, message: details.couponError };
    }

    if (!details.appliedCoupon) {
        return { success: false, message: "Coupon could not be applied." };
    }

    return {
        success: true,
        message: `Coupon "${details.appliedCoupon.code}" applied successfully! You saved ₹${details.couponDiscount.toLocaleString("en-IN")}.`,
        details,
    };
};

const removeCoupon = async (userId) => {
    await Cart.updateOne({ userId }, { $set: { appliedCoupon: null } });
    const details = await getCartDetails(userId, "");
    return {
        success: true,
        message: "Coupon removed.",
        details,
    };
};

const addToCart = async (userId, variantId, requestedQuantity = 1, sourceVariantId = null) => {
    const quantity = Math.max(1, Math.floor(Number(requestedQuantity) || 1));

    const availability = await checkVariantAvailability(variantId);
    if (!availability.available) {
        return { success: false, message: availability.reason };
    }

    const { variant } = availability;
    const effectivePrice = variant.salePrice != null ? variant.salePrice : variant.regularPrice;
    const cart = await getOrCreateCart(userId);

    const existingItem = cart.items.find((item) => item.variantId.toString() === variantId.toString());
    const currentQtyInCart = existingItem ? existingItem.quantity : 0;
    const newQuantity = Math.min(currentQtyInCart + quantity, MAX_QUANTITY_PER_ITEM);

    if (newQuantity > variant.stock) {
        return { success: false, message: `Only ${variant.stock} left in stock.` };
    }

    if (existingItem) {
        existingItem.quantity = newQuantity;
        existingItem.priceSnapshot = effectivePrice;
    } else {
        cart.items.push({
            variantId,
            quantity: newQuantity,
            priceSnapshot: effectivePrice,
        });
    }

    await cart.save();

    const wishlistVariantToRemove = sourceVariantId || variantId;
    await removeFromWishlist(userId, wishlistVariantToRemove);

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
        await removeFromCart(userId, variantId);
        return { success: false, message: availability.reason || "This product is no longer available and was removed.", removed: true };
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
        if (item.quantity <= 1) {
            return { success: false, message: "Minimum quantity is 1.", atMinimum: true };
        }
        item.quantity = item.quantity - 1;
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
    applyCoupon,
    removeCoupon,
    MAX_QUANTITY_PER_ITEM,
};
