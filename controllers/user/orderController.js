const Cart = require("../../models/order/cartModel");
const Order = require("../../models/order/orderModel");
const {
    getCheckoutDetails,
    placeOrder,
    placeCodOrder,
    verifyRazorpayPayment,
    retryOrderPayment,
    getPaymentStatus,
    handleRazorpayWebhook,
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
const { applyCoupon, removeCoupon } = require("../../services/user/cartService");
const { getWalletDetails } = require("../../services/user/walletService");

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

        await Cart.updateOne(
            { userId: req.session.userId },
            { $set: { checkoutToken, checkoutTokenCreatedAt: new Date() } }
        );

        res.render("user/checkout", {
            title: "Checkout",
            items: result.items,
            rawSubtotal: result.rawSubtotal,
            subtotal: result.subtotal,
            totalOfferDiscount: result.totalOfferDiscount || 0,
            totalSaleDiscount: result.totalSaleDiscount || 0,
            couponDiscount: result.couponDiscount,
            appliedCoupon: result.appliedCoupon,
            couponError: result.couponError,
            shippingFee: result.shippingFee,
            taxRate: result.taxRate || 0.05,
            taxableAmount: result.taxableAmount,
            taxAmount: result.taxAmount,
            totalAmount: result.totalAmount,
            addresses: result.addresses,
            selectedAddress: result.selectedAddress,
            walletBalance: result.walletBalance,
            availableCoupons: result.availableCoupons || [],
            shippingThreshold: SHIPPING_THRESHOLD,
            shippingFlatFee: SHIPPING_FLAT_FEE,
            checkoutToken,
            razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
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
        const { addressId, checkoutToken, paymentMethod = "COD" } = req.body;
        if (!addressId) {
            const msg = "Please select a delivery address.";
            if (isAjax) return res.status(400).json({ success: false, message: msg });
            return res.redirect(`/checkout?notice=${encodeURIComponent(msg)}`);
        }

        if (checkoutToken) {
            const existingOrder = await Order.findOne({ checkoutToken: checkoutToken.trim(), userId: req.session.userId });
            if (existingOrder) {
                if (existingOrder.paymentMethod === "ONLINE" && existingOrder.paymentStatus === "PENDING") {
                    return res.json({
                        success: true,
                        isOnline: true,
                        orderId: existingOrder._id,
                        razorpay: {
                            keyId: process.env.RAZORPAY_KEY_ID || "",
                            orderId: existingOrder.razorpayOrderId,
                            amount: Math.round(existingOrder.pricing.totalAmount * 100),
                            currency: "INR",
                            name: "Velora",
                            description: `Order ${existingOrder.orderNumber}`,
                        },
                    });
                }
                const redirectUrl = `/orders/${existingOrder._id}/success`;
                if (isAjax) return res.json({ success: true, isOnline: false, orderId: existingOrder._id, redirectUrl });
                return res.redirect(redirectUrl);
            }
        }

        const sessionToken = req.session.checkoutToken;
        if (!checkoutToken || !sessionToken || checkoutToken !== sessionToken) {
            const msg = "Invalid or expired checkout session. Please return to your shopping bag.";
            if (isAjax) return res.status(400).json({ success: false, message: msg });
            return res.redirect(`/cart?notice=${encodeURIComponent(msg)}`);
        }

        const result = await placeOrder(req.session.userId, addressId, paymentMethod, checkoutToken);
        if (!result.success) {
            if (isAjax) return res.status(400).json({ success: false, message: result.message });
            return res.redirect(`/checkout?notice=${encodeURIComponent(result.message)}`);
        }

        delete req.session.checkoutToken;

        if (result.isOnline) {
            return res.json({
                success: true,
                isOnline: true,
                orderId: result.order._id,
                razorpay: result.razorpay,
            });
        }

        const redirectUrl = `/orders/${result.order._id}/success`;
        if (isAjax) return res.json({ success: true, isOnline: false, orderId: result.order._id, redirectUrl });
        return res.redirect(redirectUrl);
    } catch (error) {
        console.error("Place Order Error:", error);
        if (isAjax) return res.status(500).json({ success: false, message: "Failed to place order." });
        res.status(500).send("Something went wrong");
    }
};

const applyCouponController = async (req, res) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    try {
        const { couponCode } = req.body;
        const result = await applyCoupon(req.session.userId, couponCode);
        if (!result.success) {
            if (isAjax) return res.status(400).json({ success: false, message: result.message });
            return res.redirect(`/checkout?notice=${encodeURIComponent(result.message)}`);
        }
        if (isAjax) return res.json({ success: true, message: result.message, details: result.details });
        return res.redirect("/checkout");
    } catch (error) {
        console.error("Apply Coupon Error:", error);
        if (isAjax) return res.status(500).json({ success: false, message: "Failed to apply coupon." });
        res.status(500).send("Something went wrong");
    }
};

const removeCouponController = async (req, res) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    try {
        const result = await removeCoupon(req.session.userId);
        if (isAjax) return res.json({ success: true, message: result.message, details: result.details });
        return res.redirect("/checkout");
    } catch (error) {
        console.error("Remove Coupon Error:", error);
        if (isAjax) return res.status(500).json({ success: false, message: "Failed to remove coupon." });
        res.status(500).send("Something went wrong");
    }
};

const verifyRazorpayPaymentController = async (req, res) => {
    try {
        const result = await verifyRazorpayPayment(req.session.userId, req.body);
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message,
                redirectUrl: `/orders/${req.body.orderId}/payment-failed?error=${encodeURIComponent(result.message)}`,
            });
        }
        return res.json({
            success: true,
            message: result.message,
            redirectUrl: `/orders/${req.body.orderId}/payment-success`,
        });
    } catch (error) {
        console.error("Verify Razorpay Payment Error:", error);
        return res.status(500).json({
            success: false,
            message: "Payment verification failed.",
            redirectUrl: `/orders/${req.body.orderId}/payment-failed?error=${encodeURIComponent("Server error during verification")}`,
        });
    }
};

const loadPaymentSuccess = async (req, res) => {
    try {
        const result = await getOrderDetails(req.session.userId, req.params.orderId);
        if (!result.success) return res.redirect("/products?notice=" + encodeURIComponent("Order not found."));

        if (result.order.paymentMethod === "COD") {
            return res.redirect(`/orders/${result.order._id}/success`);
        }

        if (result.order.paymentStatus !== "COMPLETED") {
            return res.redirect(`/orders/${result.order._id}/payment-failed?error=${encodeURIComponent("Payment is not yet confirmed.")}`);
        }

        res.render("user/payment-success", {
            title: "Payment Successful",
            order: result.order,
        });
    } catch (error) {
        console.error("Load Payment Success Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadPaymentFailed = async (req, res) => {
    try {
        const result = await getOrderDetails(req.session.userId, req.params.orderId);
        if (!result.success) return res.redirect("/products?notice=" + encodeURIComponent("Order not found."));

        if (result.order.paymentStatus === "COMPLETED") {
            return res.redirect(`/orders/${result.order._id}/payment-success`);
        }

        if (result.order.orderStatus === "CANCELLED") {
            return res.redirect(`/orders/${result.order._id}?notice=${encodeURIComponent("This order has been cancelled.")}`);
        }

        res.render("user/payment-failed", {
            title: "Payment Failed",
            order: result.order,
            errorMessage: req.query.error || "The payment could not be completed.",
            razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
        });
    } catch (error) {
        console.error("Load Payment Failed Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const retryPaymentController = async (req, res) => {
    try {
        const result = await retryOrderPayment(req.session.userId, req.params.orderId);

        if (result.isAlreadyPaid || (result.order && result.order.paymentStatus === "COMPLETED")) {
            const destOrder = result.order;
            const redirectUrl = destOrder.paymentMethod === "COD"
                ? `/orders/${destOrder._id}/success`
                : `/orders/${destOrder._id}/payment-success`;

            return res.json({
                success: true,
                isAlreadyPaid: true,
                order: destOrder,
                redirectUrl,
                message: result.message || "Payment has already been confirmed.",
            });
        }

        if (result.isCancelledLateRefund || result.isAlreadyRefunded) {
            const destOrder = result.order;
            const noticeMsg = result.message || "Order was cancelled and payment has been refunded to your wallet.";
            const redirectUrl = `/orders/${destOrder._id}?notice=${encodeURIComponent(noticeMsg)}`;

            return res.json({
                success: false,
                isCancelledLateRefund: true,
                order: destOrder,
                redirectUrl,
                message: noticeMsg,
            });
        }

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message,
                retryable: result.retryable,
                requiresRecovery: result.requiresRecovery,
            });
        }

        return res.json({
            success: true,
            order: result.order,
            razorpay: result.razorpay,
            message: result.message,
        });
    } catch (error) {
        console.error("Retry Payment Error:", error);
        return res.status(500).json({ success: false, message: "Failed to initiate payment retry." });
    }
};

const razorpayWebhookController = async (req, res) => {

    return res.status(403).json({
        success: false,
        message: "Razorpay webhooks are disabled for this stage. No mutations will be performed.",
    });
};

const getPaymentStatusController = async (req, res) => {
    try {
        const result = await getPaymentStatus(req.session.userId, req.params.orderId);
        if (!result.success) {
            return res.status(404).json({ success: false, message: result.message });
        }
        return res.json({
            success: true,
            paymentStatus: result.paymentStatus,
            orderStatus: result.orderStatus,
            reconciled: !!result.reconciled,
            order: result.order,
        });
    } catch (error) {
        console.error("Get Payment Status Error:", error);
        return res.status(500).json({ success: false, message: "Failed to check payment status." });
    }
};

const loadWallet = async (req, res) => {
    try {
        const result = await getWalletDetails(req.session.userId, {
            page: parseInt(req.query.page, 10) || 1,
            limit: 10,
        });

        res.render("user/wallet", {
            title: "My Wallet",
            balance: result.balance,
            currency: result.currency,
            transactions: result.transactions,
            totalTransactions: result.totalTransactions,
            totalPages: result.totalPages,
            currentPage: result.currentPage,
            notice: req.query.notice || null,
        });
    } catch (error) {
        console.error("Load Wallet Error:", error);
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
    applyCouponController,
    removeCouponController,
    verifyRazorpayPaymentController,
    loadPaymentSuccess,
    loadPaymentFailed,
    retryPaymentController,
    getPaymentStatusController,
    razorpayWebhookController,
    loadWallet,
    loadOrderSuccess,
    loadOrderList,
    loadOrderDetails,
    cancelOrderController,
    cancelOrderItemController,
    returnOrderController,
    returnOrderItemController,
    downloadInvoiceController,
};
