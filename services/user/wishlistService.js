const Wishlist = require("../../models/user/wishlistModel");
const Variant = require("../../models/product/variantModel");
const Product = require("../../models/product/productModel");

const getOrCreateWishlist = async (userId) => {
    let wishlist = await Wishlist.findOne({ userId });
    if (!wishlist) {
        wishlist = await Wishlist.create({ userId, items: [] });
    }
    return wishlist;
};

const addToWishlist = async (userId, variantId) => {
    const wishlist = await getOrCreateWishlist(userId);

    const alreadyExists = wishlist.items.some((item) => item.variantId.toString() === variantId.toString());
    if (!alreadyExists) {
        wishlist.items.push({ variantId });
        await wishlist.save();
    }

    return { success: true };
};

const removeFromWishlist = async (userId, variantId) => {
    await Wishlist.updateOne(
        { userId },
        { $pull: { items: { variantId } } }
    );
    return { success: true };
};


const getWishlistDetails = async (userId) => {
    const wishlist = await getOrCreateWishlist(userId);

    const items = await Promise.all(
        wishlist.items.map(async (item) => {
            const variant = await Variant.findById(item.variantId);
            const product = variant ? await Product.findById(variant.productId) : null;

            const isAvailable = !!(
                variant && variant.isActive &&
                product && !product.isDeleted && product.status === "ACTIVE" &&
                variant.stock > 0
            );

            const currentPrice = variant
                ? (variant.salePrice || variant.regularPrice)
                : null;

            return {
                variantId: item.variantId,
                addedAt: item.addedAt,
                product,
                variant,
                isAvailable,
                currentPrice,
            };
        })
    );

    return { items };
};

module.exports = { getOrCreateWishlist, addToWishlist, removeFromWishlist, getWishlistDetails };
