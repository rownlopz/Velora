const { getCartDetails, addToCart, changeQuantity, removeFromCart } = require("../../services/user/cartService");

const loadCart = async (req, res) => {
    try {
        const result = await getCartDetails(req.session.userId);
        res.render("user/cart", {
            title: "Shopping Bag",
            items: result.items,
            subtotal: result.subtotal,
            hasUnavailableItems: result.hasUnavailableItems,
            notice: req.query.notice || null,
            removedUnlistedCount: result.removedUnlistedCount || 0,
        });
    } catch (error) {
        console.error("Load Cart Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const addToCartController = async (req, res) => {
    try {
        const { variantId, quantity } = req.body;
        const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");

        if (!variantId) {
            if (isAjax) return res.status(400).json({ success: false, message: "Please select a product option." });
            return res.redirect("/products?notice=" + encodeURIComponent("Please select a product option."));
        }

        const result = await addToCart(req.session.userId, variantId, quantity || 1);

        if (isAjax) {
            // Return updated cart and wishlist count for navbar badges
            const cartDetails = await getCartDetails(req.session.userId);
            const cartCount = cartDetails.items.reduce((sum, i) => sum + i.quantity, 0);
            const Wishlist = require("../../models/user/wishlistModel");
            const wishlist = await Wishlist.findOne({ userId: req.session.userId }).lean();
            const wishlistCount = wishlist ? (wishlist.items || []).length : 0;

            return res.json({
                success: result.success,
                message: result.message || (result.success ? "Product added to cart" : "Unable to add to cart"),
                cartCount,
                wishlistCount,
            });
        }

        const back = req.get("Referer") || "/products";
        const separator = back.includes("?") ? "&" : "?";
        if (!result.success) {
            return res.redirect(`${back}${separator}cartError=${encodeURIComponent(result.message)}`);
        }

        return res.redirect(`${back}${separator}cartSuccess=true`);
    } catch (error) {
        console.error("Add To Cart Error:", error);
        if (req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json")) {
            return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
        }
        res.status(500).send("Something went wrong");
    }
};

const incrementController = async (req, res) => {
    try {
        const result = await changeQuantity(req.session.userId, req.params.variantId, "increment");
        const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");

        if (isAjax) {
            const cartDetails = await getCartDetails(req.session.userId);
            const cartCount = cartDetails.items.reduce((sum, i) => sum + i.quantity, 0);
            const item = cartDetails.items.find(i => i.variantId.toString() === req.params.variantId);
            return res.json({
                success: result.success,
                message: result.message || null,
                removed: result.removed || false,
                cartCount,
                subtotal: cartDetails.subtotal,
                hasUnavailableItems: cartDetails.hasUnavailableItems,
                item: item ? {
                    quantity: item.quantity,
                    currentPrice: item.currentPrice,
                    lineTotal: item.lineTotal,
                    stockExceeded: item.stockExceeded,
                } : null,
            });
        }

        if (!result.success) {
            return res.redirect("/cart?notice=" + encodeURIComponent(result.message));
        }
        res.redirect("/cart");
    } catch (error) {
        console.error("Increment Cart Item Error:", error);
        if (req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json")) {
            return res.status(500).json({ success: false, message: "Something went wrong." });
        }
        res.status(500).send("Something went wrong");
    }
};

const decrementController = async (req, res) => {
    try {
        const result = await changeQuantity(req.session.userId, req.params.variantId, "decrement");
        const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");

        if (isAjax) {
            const cartDetails = await getCartDetails(req.session.userId);
            const cartCount = cartDetails.items.reduce((sum, i) => sum + i.quantity, 0);
            const item = cartDetails.items.find(i => i.variantId.toString() === req.params.variantId);
            return res.json({
                success: result.success,
                message: result.message || null,
                removed: result.removed || false,
                atMinimum: result.atMinimum || false,
                cartCount,
                subtotal: cartDetails.subtotal,
                hasUnavailableItems: cartDetails.hasUnavailableItems,
                item: item ? {
                    quantity: item.quantity,
                    currentPrice: item.currentPrice,
                    lineTotal: item.lineTotal,
                    stockExceeded: item.stockExceeded,
                } : null,
            });
        }

        res.redirect("/cart");
    } catch (error) {
        console.error("Decrement Cart Item Error:", error);
        if (req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json")) {
            return res.status(500).json({ success: false, message: "Something went wrong." });
        }
        res.status(500).send("Something went wrong");
    }
};

const removeController = async (req, res) => {
    try {
        await removeFromCart(req.session.userId, req.params.variantId);
        const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");

        if (isAjax) {
            const cartDetails = await getCartDetails(req.session.userId);
            const cartCount = cartDetails.items.reduce((sum, i) => sum + i.quantity, 0);
            return res.json({
                success: true,
                cartCount,
                subtotal: cartDetails.subtotal,
                hasUnavailableItems: cartDetails.hasUnavailableItems,
            });
        }

        res.redirect("/cart");
    } catch (error) {
        console.error("Remove Cart Item Error:", error);
        if (req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json")) {
            return res.status(500).json({ success: false, message: "Something went wrong." });
        }
        res.status(500).send("Something went wrong");
    }
};

module.exports = { loadCart, addToCartController, incrementController, decrementController, removeController };