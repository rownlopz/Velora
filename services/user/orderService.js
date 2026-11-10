const mongoose = require("mongoose");
const Order = require("../../models/order/orderModel");
const Variant = require("../../models/product/variantModel");
const walletService = require("./walletService");
const placementService = require("./orderPlacementService");
const paymentService = require("./orderPaymentService");
const { generateInvoicePdf } = require("../../utils/invoiceGenerator");
const { calculateOrderStatusFromItems } = require("../../helpers/orderStatusHelper");

const PREDEFINED_CANCELLATION_REASONS = [
    "Ordered by mistake",
    "Found cheaper elsewhere",
    "Delayed delivery expectation",
    "Change of mind",
    "Incorrect address selected",
    "Other",
];

const getUserOrders = async (userId, options = {}) => {
    const { search = "", status = "", page = 1, limit = 10 } = options;
    const filter = { userId };

    if (status && status !== "ALL") {
        if (status === "PENDING" || status === "PLACED") {
            filter.orderStatus = { $in: ["PENDING", "PLACED"] };
        } else {
            filter.orderStatus = status;
        }
    }

    if (typeof search === "string" && search.trim()) {
        const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ orderNumber: regex }, { "items.productName": regex }];
    }

    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedLimit = Math.max(1, Math.min(50, Number(limit) || 10));

    const totalOrders = await Order.countDocuments(filter);
    const totalPages = Math.ceil(totalOrders / parsedLimit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const skip = (currentPage - 1) * parsedLimit;

    const orders = await Order.find(filter)
        .sort({ placedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean();

    return {
        success: true,
        orders,
        totalOrders,
        totalPages,
        currentPage,
        search,
        status,
    };
};

const getOrderDetails = async (userId, orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }
    const order = await Order.findOne({ _id: orderId, userId }).lean();
    if (!order) return { success: false, message: "Order not found." };
    return { success: true, order };
};

const cancelEntireOrder = async (userId, orderId, reason = "") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }
    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) return { success: false, message: "Order not found." };

    if (["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"].includes(order.orderStatus)) {
        return { success: false, message: `Orders that are ${order.orderStatus.toLowerCase()} cannot be cancelled.` };
    }

    const cleanReason = (reason || "").trim() || "Cancelled by customer";
    order.orderStatus = "CANCELLED";
    order.cancelledAt = new Date();
    order.cancellationReason = cleanReason;

    for (const item of order.items) {
        if (!["CANCELLED", "RETURNED"].includes(item.status)) {
            item.status = "CANCELLED";
            item.cancelledAt = new Date();
            item.cancellationReason = cleanReason;
            if (item.variantId && !item.isRestocked) {
                await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
                item.isRestocked = true;
            }
        }
    }

    const isPaid = order.paymentStatus === "COMPLETED" || order.paymentMethod === "WALLET";
    const payable = order.pricing?.currentPayable != null ? order.pricing.currentPayable : (order.pricing?.totalAmount || 0);

    if (isPaid && payable > 0) {
        await walletService.creditWallet({
            userId,
            amount: payable,
            reason: "ORDER_CANCELLATION",
            description: `Refund for cancelled Order #${order.orderNumber}`,
            orderId: order._id,
            orderNumber: order.orderNumber,
        });
        order.paymentStatus = "REFUNDED";
        order.refundedAt = new Date();
    }

    await order.save();
    return { success: true, message: "Order cancelled successfully.", order };
};

const cancelOrderItem = async (userId, orderId, itemId, reason = "") => {
    if (!orderId || !itemId) return { success: false, message: "Invalid order or item ID." };

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) return { success: false, message: "Order not found." };

    const item = order.items.id(itemId);
    if (!item) return { success: false, message: "Item not found in order." };

    if (["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"].includes(item.status)) {
        return { success: false, message: `This item is already ${item.status.toLowerCase()} and cannot be cancelled.` };
    }

    const cleanReason = (reason || "").trim() || "Cancelled by customer";
    item.status = "CANCELLED";
    item.cancelledAt = new Date();
    item.cancellationReason = cleanReason;

    if (item.variantId && !item.isRestocked) {
        await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
        item.isRestocked = true;
    }

    const isPaid = order.paymentStatus === "COMPLETED" || order.paymentMethod === "WALLET";
    const refundAmt = item.finalPayable != null ? item.finalPayable : item.lineTotal;

    if (isPaid && refundAmt > 0 && !item.refundIssued) {
        await walletService.creditWallet({
            userId,
            amount: refundAmt,
            reason: "ORDER_CANCELLATION",
            description: `Refund for cancelled item (${item.productName}) in Order #${order.orderNumber}`,
            orderId: order._id,
            orderNumber: order.orderNumber,
        });
        item.refundIssued = true;
        item.refundAmount = refundAmt;
    }

    order.orderStatus = calculateOrderStatusFromItems(order.items);
    await order.save();

    return { success: true, message: `Item "${item.productName}" cancelled successfully.`, order };
};

const returnEntireOrder = async (userId, orderId, reason) => {
    const cleanReason = (reason || "").trim();
    if (!cleanReason) return { success: false, message: "A reason is mandatory for returns." };

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) return { success: false, message: "Order not found." };

    if (order.orderStatus !== "DELIVERED") {
        return { success: false, message: "Only delivered orders can be returned." };
    }

    const now = new Date();
    for (const item of order.items) {
        if (item.status === "DELIVERED") {
            item.status = "RETURN_REQUESTED";
            item.returnReason = cleanReason;
            item.returnRequestedAt = now;
        }
    }

    order.orderStatus = "RETURN_REQUESTED";
    order.returnReason = cleanReason;
    order.returnRequestedAt = now;

    await order.save();
    return { success: true, message: "Return request submitted successfully.", order };
};

const returnOrderItem = async (userId, orderId, itemId, reason) => {
    const cleanReason = (reason || "").trim();
    if (!cleanReason) return { success: false, message: "A reason is mandatory for returns." };

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) return { success: false, message: "Order not found." };

    const item = order.items.id(itemId);
    if (!item) return { success: false, message: "Item not found in order." };

    if (item.status !== "DELIVERED") {
        return { success: false, message: "Only delivered products can be returned." };
    }

    const now = new Date();
    item.status = "RETURN_REQUESTED";
    item.returnReason = cleanReason;
    item.returnRequestedAt = now;

    order.orderStatus = calculateOrderStatusFromItems(order.items);
    order.returnReason = cleanReason;
    order.returnRequestedAt = now;

    await order.save();
    return { success: true, message: `Return request for "${item.productName}" submitted.`, order };
};

const releaseExpiredReservations = async (expirationWindowMinutes = 30) => {
    const cutoffTime = new Date(Date.now() - expirationWindowMinutes * 60 * 1000);
    const expiredOrders = await Order.find({
        paymentMethod: "ONLINE",
        paymentStatus: { $in: ["PENDING", "FAILED"] },
        orderStatus: { $in: ["PENDING", "PLACED"] },
        placedAt: { $lte: cutoffTime },
    });

    let releasedCount = 0;
    for (const order of expiredOrders) {
        order.orderStatus = "CANCELLED";
        order.cancellationReason = "Payment reservation expired";
        for (const item of order.items) {
            if (item.variantId && !item.isRestocked) {
                await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
                item.isRestocked = true;
            }
        }
        await order.save();
        releasedCount++;
    }
    return { success: true, releasedCount };
};

let expiryIntervalId = null;
const startReservationExpiryCron = (intervalMs = 60000, expirationWindowMinutes = 30) => {
    if (!expiryIntervalId) {
        expiryIntervalId = setInterval(async () => {
            try {
                await releaseExpiredReservations(expirationWindowMinutes);
            } catch (err) {
                console.error("Reservation expiry background task error:", err);
            }
        }, intervalMs);
        if (expiryIntervalId.unref) expiryIntervalId.unref();
    }
    return expiryIntervalId;
};

const stopReservationExpiryCron = () => {
    if (expiryIntervalId) {
        clearInterval(expiryIntervalId);
        expiryIntervalId = null;
    }
};

module.exports = {

    getUserOrders,
    getOrderDetails,
    generateInvoicePdf,

    cancelEntireOrder,
    cancelOrderItem,
    returnEntireOrder,
    returnOrderItem,
    PREDEFINED_CANCELLATION_REASONS,

    releaseExpiredReservations,
    startReservationExpiryCron,
    stopReservationExpiryCron,

    getCheckoutDetails: placementService.getCheckoutDetails,
    placeOrder: placementService.placeOrder,
    placeCodOrder: placementService.placeCodOrder,
    calculateShippingFee: placementService.calculateShippingFee,
    SHIPPING_THRESHOLD: placementService.SHIPPING_THRESHOLD,
    SHIPPING_FLAT_FEE: placementService.SHIPPING_FLAT_FEE,

    verifyRazorpayPayment: paymentService.verifyRazorpayPayment,
    retryOrderPayment: paymentService.retryOrderPayment,
    getPaymentStatus: paymentService.getPaymentStatus,
    handleRazorpayWebhook: paymentService.handleRazorpayWebhook,
    inspectOrderGatewayPaymentState: paymentService.inspectOrderGatewayPaymentState,
};
