const Wishlist = require("../../models/user/wishlistModel");

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

module.exports = { getOrCreateWishlist, addToWishlist, removeFromWishlist };
