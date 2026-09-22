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
        });
    } catch (error) {
        console.error("Load Cart Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const addToCartController = async (req, res) => {
    try {
        const { variantId, quantity } = req.body;

        if (!variantId) {
            return res.redirect("/products?notice=" + encodeURIComponent("Please select a product option."));
        }

        const result = await addToCart(req.session.userId, variantId, quantity || 1);

        if (!result.success) {
            // Send them back where they came from with a clear reason,
            // rather than a dead end — the referring product page will
            // naturally re-check availability on its own next load too.
            const back = req.get("Referer") || "/products";
            const separator = back.includes("?") ? "&" : "?";
            return res.redirect(`${back}${separator}cartError=${encodeURIComponent(result.message)}`);
        }

        res.redirect("/cart");
    } catch (error) {
        console.error("Add To Cart Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const incrementController = async (req, res) => {
    try {
        const result = await changeQuantity(req.session.userId, req.params.variantId, "increment");
        if (!result.success) {
            return res.redirect("/cart?notice=" + encodeURIComponent(result.message));
        }
        res.redirect("/cart");
    } catch (error) {
        console.error("Increment Cart Item Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const decrementController = async (req, res) => {
    try {
        await changeQuantity(req.session.userId, req.params.variantId, "decrement");
        res.redirect("/cart");
    } catch (error) {
        console.error("Decrement Cart Item Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const removeController = async (req, res) => {
    try {
        await removeFromCart(req.session.userId, req.params.variantId);
        res.redirect("/cart");
    } catch (error) {
        console.error("Remove Cart Item Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = { loadCart, addToCartController, incrementController, decrementController, removeController };
