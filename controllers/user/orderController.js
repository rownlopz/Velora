const {
    getCheckoutDetails,
    placeCodOrder,
    getUserOrders,
    getOrderDetails,
    cancelEntireOrder,
    cancelOrderItem,
    returnEntireOrder,
    returnOrderItem,
    generateInvoicePdf,
    SHIPPING_THRESHOLD,
    SHIPPING_FLAT_FEE,
    PREDEFINED_CANCELLATION_REASONS,
} = require("../../services/user/orderService");

/**
 * Clean helper to handle action responses (AJAX JSON vs HTML redirect)
 */
const handleActionResponse = (req, res, result, redirectUrl, fallbackMsg = "Action failed") => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    if (!result.success) {
        const msg = result.message || fallbackMsg;
        if (isAjax) return res.status(400).json({ success: false, message: msg });
        return res.redirect(`${redirectUrl}?notice=${encodeURIComponent(msg)}`);
    }
    if (isAjax) return res.json({ success: true, message: result.message, order: result.order });
    return res.redirect(`${redirectUrl}?notice=${encodeURIComponent(result.message)}`);
};

const loadCheckout = async (req, res) => {
    try {
        const result = await getCheckoutDetails(req.session.userId);
        if (!result.success) return res.redirect(`/cart?notice=${encodeURIComponent(result.message)}`);

        const checkoutToken = "chk_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 10);
        req.session.checkoutToken = checkoutToken;

        res.render("user/checkout", {
            title: "Checkout",
            items: result.items,
            subtotal: result.subtotal,
            shippingFee: result.shippingFee,
            totalAmount: result.totalAmount,
            addresses: result.addresses,
            selectedAddress: result.selectedAddress,
            shippingThreshold: SHIPPING_THRESHOLD,
            shippingFlatFee: SHIPPING_FLAT_FEE,
            checkoutToken,
            notice: req.query.notice || null,
        });
    } catch (error) {
        console.error("Load Checkout Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const placeOrderController = async (req, res) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    try {
        const { addressId, checkoutToken } = req.body;
        if (!addressId) {
            const msg = "Please select a delivery address.";
            if (isAjax) return res.status(400).json({ success: false, message: msg });
            return res.redirect(`/checkout?notice=${encodeURIComponent(msg)}`);
        }

        const token = checkoutToken || req.session.checkoutToken || "";
        const result = await placeCodOrder(req.session.userId, addressId, token);
        if (!result.success) {
            if (isAjax) return res.status(400).json({ success: false, message: result.message });
            return res.redirect(`/checkout?notice=${encodeURIComponent(result.message)}`);
        }

        delete req.session.checkoutToken;

        const redirectUrl = `/orders/${result.order._id}/success`;
        if (isAjax) return res.json({ success: true, orderId: result.order._id, redirectUrl });
        return res.redirect(redirectUrl);
    } catch (error) {
        console.error("Place Order Error:", error);
        if (isAjax) return res.status(500).json({ success: false, message: "Failed to place order." });
        res.status(500).send("Something went wrong");
    }
};

const loadOrderSuccess = async (req, res) => {
    try {
        const result = await getOrderDetails(req.session.userId, req.params.orderId);
        if (!result.success) return res.redirect("/products?notice=" + encodeURIComponent("Order not found."));

        res.render("user/order-success", { title: "Order Confirmed", order: result.order });
    } catch (error) {
        console.error("Load Order Success Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadOrderList = async (req, res) => {
    try {
        const { search, status, page } = req.query;
        const result = await getUserOrders(req.session.userId, {
            search,
            status,
            page: parseInt(page, 10) || 1,
            limit: 10,
        });

        res.render("user/orders", {
            title: "My Orders",
            orders: result.orders,
            totalOrders: result.totalOrders,
            totalPages: result.totalPages,
            currentPage: result.currentPage,
            search: result.search,
            status: result.status,
            notice: req.query.notice || null,
        });
    } catch (error) {
        console.error("Load Order List Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadOrderDetails = async (req, res) => {
    try {
        const result = await getOrderDetails(req.session.userId, req.params.orderId);
        if (!result.success) return res.redirect("/orders?notice=" + encodeURIComponent("Order not found."));

        res.render("user/order-details", {
            title: `Order #${result.order.orderNumber}`,
            order: result.order,
            notice: req.query.notice || null,
            cancellationReasons: PREDEFINED_CANCELLATION_REASONS,
        });
    } catch (error) {
        console.error("Load Order Details Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const cancelOrderController = async (req, res) => {
    try {
        const { orderId } = req.params;
        const result = await cancelEntireOrder(req.session.userId, orderId, req.body.reason);
        return handleActionResponse(req, res, result, `/orders/${orderId}`, "Failed to cancel order.");
    } catch (error) {
        console.error("Cancel Order Error:", error);
        return handleActionResponse(req, res, { success: false, message: "Failed to cancel order." }, `/orders/${req.params.orderId}`);
    }
};

const cancelOrderItemController = async (req, res) => {
    try {
        const { orderId, itemId } = req.params;
        const result = await cancelOrderItem(req.session.userId, orderId, itemId, req.body.reason);
        return handleActionResponse(req, res, result, `/orders/${orderId}`, "Failed to cancel product.");
    } catch (error) {
        console.error("Cancel Order Item Error:", error);
        return handleActionResponse(req, res, { success: false, message: "Failed to cancel product." }, `/orders/${req.params.orderId}`);
    }
};

const returnOrderController = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return handleActionResponse(req, res, { success: false, message: "Return reason is mandatory." }, `/orders/${orderId}`);
        }
        const result = await returnEntireOrder(req.session.userId, orderId, reason);
        return handleActionResponse(req, res, result, `/orders/${orderId}`, "Failed to submit return request.");
    } catch (error) {
        console.error("Return Order Error:", error);
        return handleActionResponse(req, res, { success: false, message: "Failed to submit return request." }, `/orders/${req.params.orderId}`);
    }
};

const returnOrderItemController = async (req, res) => {
    try {
        const { orderId, itemId } = req.params;
        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return handleActionResponse(req, res, { success: false, message: "Return reason is mandatory." }, `/orders/${orderId}`);
        }
        const result = await returnOrderItem(req.session.userId, orderId, itemId, reason);
        return handleActionResponse(req, res, result, `/orders/${orderId}`, "Failed to submit return request.");
    } catch (error) {
        console.error("Return Order Item Error:", error);
        return handleActionResponse(req, res, { success: false, message: "Failed to submit return request." }, `/orders/${req.params.orderId}`);
    }
};

const downloadInvoiceController = async (req, res) => {
    try {
        const { orderId } = req.params;
        const result = await getOrderDetails(req.session.userId, orderId);
        if (!result.success) return res.status(404).send("Order not found or invoice unavailable.");
        generateInvoicePdf(result.order, res);
    } catch (error) {
        console.error("Download Invoice Error:", error);
        res.status(500).send("Failed to generate invoice.");
    }
};

module.exports = {
    loadCheckout,
    placeOrderController,
    loadOrderSuccess,
    loadOrderList,
    loadOrderDetails,
    cancelOrderController,
    cancelOrderItemController,
    returnOrderController,
    returnOrderItemController,
    downloadInvoiceController,
};
