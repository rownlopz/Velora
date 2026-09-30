const { addToWishlist, removeFromWishlist, getWishlistDetails } = require("../../services/user/wishlistService");

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

const removeFromWishlistController = async (req, res) => {
    try {
        const { variantId } = req.params;
        await removeFromWishlist(req.session.userId, variantId);
        res.redirect("/wishlist");
    } catch (error) {
        console.error("Remove From Wishlist Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadWishlist = async (req, res) => {
    try {
        const result = await getWishlistDetails(req.session.userId);
        res.render("user/wishlist", {
            title: "My Wishlist",
            items: result.items,
        });
    } catch (error) {
        console.error("Load Wishlist Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = { addToWishlistController, removeFromWishlistController, loadWishlist };
