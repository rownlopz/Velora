const { addToWishlist, removeFromWishlist, getWishlistDetails } = require("../../services/user/wishlistService");
const Wishlist = require("../../models/user/wishlistModel");

const addToWishlistController = async (req, res) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    try {
        const { variantId } = req.body;

        if (!variantId) {
            if (isAjax) return res.status(400).json({ success: false, message: "No variant specified." });
            return res.redirect("/products");
        }

        await addToWishlist(req.session.userId, variantId);

        if (isAjax) {
            const wishlist = await Wishlist.findOne({ userId: req.session.userId }).lean();
            const wishlistCount = wishlist ? wishlist.items.length : 0;
            return res.json({ success: true, wishlistCount, message: "Item added to wishlist." });
        }

        const back = req.get("Referer") || "/products";
        res.redirect(back);
    } catch (error) {
        console.error("Add To Wishlist Error:", error);
        if (isAjax) {
            return res.status(400).json({ success: false, message: error.message || "Something went wrong." });
        }
        res.status(400).send(error.message || "Something went wrong");
    }
};

const removeFromWishlistController = async (req, res) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    try {
        const { variantId } = req.params;

        await removeFromWishlist(req.session.userId, variantId);

        if (isAjax) {
            const wishlist = await Wishlist.findOne({ userId: req.session.userId }).lean();
            const wishlistCount = wishlist ? wishlist.items.length : 0;
            return res.json({ success: true, wishlistCount, message: "Item removed from wishlist." });
        }

        res.redirect("/wishlist");
    } catch (error) {
        console.error("Remove From Wishlist Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: error.message || "Something went wrong." });
        }
        res.status(500).send("Something went wrong");
    }
};

const loadWishlist = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = 8;
        const result = await getWishlistDetails(req.session.userId, { page, limit });
        res.render("user/wishlist", {
            title: "My Wishlist",
            items: result.items,
            currentPage: result.currentPage,
            totalPages: result.totalPages,
            totalItems: result.totalItems,
        });
    } catch (error) {
        console.error("Load Wishlist Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = { addToWishlistController, removeFromWishlistController, loadWishlist };
