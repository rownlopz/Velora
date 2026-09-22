const { addToWishlist } = require("../../services/user/wishlistService");

const addToWishlistController = async (req, res) => {
    try {
        const { variantId } = req.body;
        if (!variantId) {
            return res.redirect("/products");
        }

        await addToWishlist(req.session.userId, variantId);

        const back = req.get("Referer") || "/products";
        res.redirect(back);
    } catch (error) {
        console.error("Add To Wishlist Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = { addToWishlistController };
