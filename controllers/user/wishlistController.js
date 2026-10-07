const { addToWishlist, removeFromWishlist, getWishlistDetails } = require("../../services/user/wishlistService");
const Wishlist = require("../../models/user/wishlistModel");

const addToWishlistController = async (req, res) => {
    try {
        const { variantId } = req.body;
        const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");

        if (!variantId) {
            if (isAjax) return res.status(400).json({ success: false, message: "No variant specified." });
            return res.redirect("/products");
        }

        await addToWishlist(req.session.userId, variantId);

        if (isAjax) {
            const wishlist = await Wishlist.findOne({ userId: req.session.userId }).lean();
            const wishlistCount = wishlist ? wishlist.items.length : 0;
            return res.json({ success: true, wishlistCount });
        }

        const back = req.get("Referer") || "/products";
        res.redirect(back);
    } catch (error) {
        console.error("Add To Wishlist Error:", error);
        if (req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json")) {
            return res.status(500).json({ success: false, message: "Something went wrong." });
        }
        res.status(500).send("Something went wrong");
    }
};

const removeFromWishlistController = async (req, res) => {
    try {
        const { variantId } = req.params;
        const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");

        await removeFromWishlist(req.session.userId, variantId);

        if (isAjax) {
            const wishlist = await Wishlist.findOne({ userId: req.session.userId }).lean();
            const wishlistCount = wishlist ? wishlist.items.length : 0;
            return res.json({ success: true, wishlistCount });
        }

        res.redirect("/wishlist");
    } catch (error) {
        console.error("Remove From Wishlist Error:", error);
        if (req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json")) {
            return res.status(500).json({ success: false, message: "Something went wrong." });
        }
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
