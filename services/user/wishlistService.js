const mongoose = require("mongoose");
const Wishlist = require("../../models/user/wishlistModel");
const Variant = require("../../models/product/variantModel");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");

const getOrCreateWishlist = async (userId) => {
    let wishlist = await Wishlist.findOne({ userId });
    if (!wishlist) {
        wishlist = await Wishlist.create({ userId, items: [] });
    }
    return wishlist;
};

const addToWishlist = async (userId, variantId) => {
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        throw new Error("Invalid variant specified.");
    }

    const variant = await Variant.findById(variantId);
    if (!variant || !variant.isActive) {
        throw new Error("Selected product variant is not available.");
    }

    const product = await Product.findById(variant.productId);
    if (!product || product.isDeleted || product.status !== "ACTIVE") {
        throw new Error("Selected product is not available.");
    }

    if (product.category) {
        const category = await Category.findById(product.category);
        if (!category || category.isDeleted || !category.isActive) {
            throw new Error("Product category is currently unavailable.");
        }
    }

    // Atomic insert: ensure wishlist doc exists, then conditionally push if not already present
    await Wishlist.updateOne(
        { userId },
        { $setOnInsert: { userId, items: [] } },
        { upsert: true }
    );

    await Wishlist.updateOne(
        { userId, "items.variantId": { $ne: variantId } },
        { $push: { items: { variantId, addedAt: new Date() } } }
    );

    return { success: true };
};

const removeFromWishlist = async (userId, variantId) => {
    await Wishlist.updateOne(
        { userId },
        { $pull: { items: { variantId } } }
    );
    return { success: true };
};

const getWishlistDetails = async (userId, { page = 1, limit = 8 } = {}) => {
    const wishlist = await getOrCreateWishlist(userId);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 8);
    const totalItems = (wishlist.items || []).length;
    const totalPages = Math.ceil(totalItems / safeLimit) || 1;
    const clampedPage = Math.min(safePage, totalPages);
    const startIndex = (clampedPage - 1) * safeLimit;

    // Sliced items in reverse chronological order
    const reversedItems = (wishlist.items || []).slice().reverse();
    const paginatedItems = reversedItems.slice(startIndex, startIndex + safeLimit);

    const items = await Promise.all(
        paginatedItems.map(async (item) => {
            const variant = await Variant.findById(item.variantId);
            const product = variant ? await Product.findById(variant.productId) : null;
            let category = null;
            if (product && product.category) {
                category = await Category.findById(product.category);
            }

            const isCategoryActive = !product || !product.category || (category && !category.isDeleted && category.isActive);
            const isListed = !!(
                variant && variant.isActive &&
                product && !product.isDeleted && product.status === "ACTIVE" &&
                isCategoryActive
            );
            const isInStock = !!(variant && variant.stock > 0);
            const isAvailable = isListed;

            const currentPrice = variant
                ? (variant.salePrice != null ? variant.salePrice : variant.regularPrice)
                : null;

            return {
                variantId: item.variantId,
                addedAt: item.addedAt,
                product,
                variant,
                isListed,
                isInStock,
                isAvailable,
                currentPrice,
            };
        })
    );

    return {
        items,
        totalItems,
        totalPages,
        currentPage: clampedPage,
        limit: safeLimit,
    };
};

module.exports = { getOrCreateWishlist, addToWishlist, removeFromWishlist, getWishlistDetails };
