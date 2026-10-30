const mongoose = require("mongoose");
const Order = require("../../models/order/orderModel");
const Payment = require("../../models/order/paymentModel");
const User = require("../../models/user/userModel");
const Variant = require("../../models/product/variantModel");
const walletService = require("../user/walletService");
const escapeRegex = require("../../utils/escapeRegex");

const VALID_ORDER_STATUSES = [
    "PENDING",
    "PLACED",
    "PROCESSING",
    "SHIPPED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED",
    "RETURN_REQUESTED",
    "RETURN_APPROVED",
    "RETURN_REJECTED",
    "RETURNED",
];

const VALID_PAYMENT_STATUSES = ["PENDING", "COMPLETED", "FAILED", "REFUNDED", "CANCELLED"];

/**
 * 1. Fetch paginated orders for Admin with filters, search, and status counters
 */
const getAdminOrders = async (options = {}) => {
    let {
        search = "",
        status = "ALL",
        paymentMethod = "ALL",
        paymentStatus = "ALL",
        sort = "date_desc",
        page = 1,
        limit = 10,
    } = options;

    const cleanStatus = (typeof status === "string" ? status.trim() : "").toUpperCase();
    const cleanPaymentMethod = (typeof paymentMethod === "string" ? paymentMethod.trim() : "").toUpperCase();
    const cleanPaymentStatus = (typeof paymentStatus === "string" ? paymentStatus.trim() : "").toUpperCase();

    const filter = {};

    if (cleanStatus && cleanStatus !== "ALL") {
        if (cleanStatus === "ACTIVE") {
            filter.orderStatus = { $in: ["PENDING", "PLACED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"] };
        } else if (cleanStatus === "PENDING" || cleanStatus === "PLACED") {
            filter.orderStatus = { $in: ["PENDING", "PLACED"] };
        } else if (VALID_ORDER_STATUSES.includes(cleanStatus)) {
            filter.orderStatus = cleanStatus;
        }
    }

    if (cleanPaymentMethod && cleanPaymentMethod !== "ALL" && ["COD", "ONLINE", "WALLET"].includes(cleanPaymentMethod)) {
        filter.paymentMethod = cleanPaymentMethod;
    }

    if (cleanPaymentStatus && cleanPaymentStatus !== "ALL" && VALID_PAYMENT_STATUSES.includes(cleanPaymentStatus)) {
        filter.paymentStatus = cleanPaymentStatus;
    }

    if (typeof search === "string" && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), "i");
        const matchedUsers = await User.find({
            $or: [{ fullName: regex }, { email: regex }, { phone: regex }],
        }).select("_id");
        const userIds = matchedUsers.map((u) => u._id);

        filter.$or = [
            { orderNumber: regex },
            { orderId: regex },
            { "shippingAddress.firstName": regex },
            { "shippingAddress.lastName": regex },
            { "items.productName": regex },
            { "items.sku": regex },
            ...(userIds.length > 0 ? [{ userId: { $in: userIds } }] : []),
        ];
    }

    // Counts breakdown for top tabs
    const countBase = { ...filter };
    delete countBase.orderStatus;
    const statusCountsRaw = await Order.aggregate([
        ...(Object.keys(countBase).length > 0 ? [{ $match: countBase }] : []),
        { $group: { _id: "$orderStatus", count: { $sum: 1 } } },
    ]);

    const countsMap = { ALL: 0, all: 0 };
    for (const row of statusCountsRaw) {
        if (row._id) countsMap[row._id] = row.count;
        countsMap.ALL += row.count;
        countsMap.all += row.count;
    }
    const pendingCount = (countsMap.PENDING || 0) + (countsMap.PLACED || 0);
    countsMap.PENDING = pendingCount;
    countsMap.PLACED = pendingCount;

    const sortStage = sort === "date_asc" ? { placedAt: 1, createdAt: 1 }
        : sort === "amount_desc" ? { "pricing.totalAmount": -1 }
            : sort === "amount_asc" ? { "pricing.totalAmount": 1 }
                : { placedAt: -1, createdAt: -1 };

    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedLimit = Math.max(1, Math.min(100, Number(limit) || 10));
    const totalOrders = await Order.countDocuments(filter);
    const totalPages = Math.ceil(totalOrders / parsedLimit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const skip = (currentPage - 1) * parsedLimit;

    const orders = await Order.find(filter)
        .populate("userId", "fullName email phone")
        .sort(sortStage)
        .skip(skip)
        .limit(parsedLimit)
        .lean();

    return {
        success: true,
        orders,
        totalOrders,
        totalPages,
        currentPage,
        countsMap,
        statusCounts: countsMap,
        search,
        status,
        paymentMethod,
        paymentStatus,
        sort,
    };
};

/**
 * 2. Fetch single order details for Admin
 */
const getAdminOrderDetails = async (orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findById(orderId)
        .populate("userId", "fullName email phone avatar createdAt")
        .lean();

    if (!order) return { success: false, message: "Order not found." };

    const payments = await Payment.find({ orderId: order._id }).lean();
    return { success: true, order, payments };
};

/**
 * Helper: Restore stock for items
 */
const restoreItemsStock = async (items) => {
    for (const item of items) {
        if (item.variantId && !item.isRestocked) {
            await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
            item.isRestocked = true;
            item.isStockRestored = true;
        }
    }
};

/**
 * 3. Update entire order status (e.g. PROCESSING, SHIPPED, DELIVERED, CANCELLED)
 */
const updateOrderStatus = async (orderId, newStatus, { deliveryNotes = "", adminNote = "" } = {}) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }
    if (!VALID_ORDER_STATUSES.includes(newStatus)) {
        return { success: false, message: `Invalid order status: ${newStatus}` };
    }

    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: "Order not found." };

    // Prevent changing terminal states
    if (order.orderStatus === "CANCELLED") {
        return { success: false, message: "Cancelled orders cannot be modified." };
    }
    if (order.orderStatus === "DELIVERED" && newStatus !== "DELIVERED") {
        return { success: false, message: "Delivered orders cannot be moved back to an earlier status." };
    }

    const previousStatus = order.orderStatus;
    order.orderStatus = newStatus;

    if (deliveryNotes) order.deliveryNotes = deliveryNotes;
    if (adminNote) order.adminFeedback = adminNote;

    // Handle DELIVERED
    if (newStatus === "DELIVERED") {
        order.deliveredAt = new Date();
        if (order.paymentMethod === "COD" && order.paymentStatus !== "COMPLETED") {
            order.paymentStatus = "COMPLETED";
            order.paidAt = new Date();
        }
        (order.items || []).forEach((item) => {
            if (!["CANCELLED", "RETURN_REQUESTED", "RETURN_APPROVED", "RETURNED"].includes(item.status)) {
                item.status = "DELIVERED";
            }
        });
    }

    // Handle CANCELLED by Admin
    if (newStatus === "CANCELLED") {
        order.cancelledAt = new Date();
        order.cancelledBy = "ADMIN";
        order.cancellationReason = adminNote || "Cancelled by admin";

        const activeItems = (order.items || []).filter((i) => !["CANCELLED", "RETURNED"].includes(i.status));
        await restoreItemsStock(activeItems);

        activeItems.forEach((item) => {
            item.status = "CANCELLED";
            item.cancelledAt = new Date();
            item.cancellationReason = adminNote || "Cancelled by admin";
        });

        // Issue full refund to wallet if payment was collected
        const isPaid = order.paymentStatus === "COMPLETED" || (order.paymentMethod === "COD" && previousStatus === "DELIVERED");
        const payable = order.pricing?.currentPayable != null ? order.pricing.currentPayable : (order.pricing?.totalAmount || 0);

        if (isPaid && payable > 0) {
            await walletService.creditWallet({
                userId: order.userId,
                amount: payable,
                reason: "ORDER_CANCELLATION",
                description: `Refund for cancelled Order #${order.orderNumber}`,
                orderId: order._id,
                orderNumber: order.orderNumber,
            });
            order.paymentStatus = "REFUNDED";
            order.refundedAt = new Date();
        }
    }

    // Handle normal progression: sync active items status
    if (["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"].includes(newStatus)) {
        (order.items || []).forEach((item) => {
            if (!["CANCELLED", "RETURN_REQUESTED", "RETURN_APPROVED", "RETURNED"].includes(item.status)) {
                item.status = newStatus;
            }
        });
    }

    await order.save();
    return { success: true, message: `Order status updated to ${newStatus}.`, order };
};

/**
 * 4. Update individual item status in an order
 */
const updateAdminOrderItemStatus = async (orderId, itemId, newStatus, { adminNote = "" } = {}) => {
    if (!orderId || !itemId) return { success: false, message: "Order ID and Item ID required." };

    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: "Order not found." };

    const item = order.items.id(itemId);
    if (!item) return { success: false, message: "Item not found in order." };

    item.status = newStatus;
    if (adminNote) item.adminFeedback = adminNote;

    // If cancelled, restore stock and refund item payable
    if (newStatus === "CANCELLED") {
        item.cancelledAt = new Date();
        item.cancellationReason = adminNote || "Cancelled by admin";
        if (item.variantId) {
            await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
            item.isRestocked = true;
        }

        const isPaid = order.paymentStatus === "COMPLETED" || order.paymentMethod === "COD";
        const itemRefund = item.finalPayable != null ? item.finalPayable : item.lineTotal;
        if (isPaid && itemRefund > 0 && !item.refundIssued) {
            await walletService.creditWallet({
                userId: order.userId,
                amount: itemRefund,
                reason: "ORDER_CANCELLATION",
                description: `Refund for cancelled item (${item.productName}) in Order #${order.orderNumber}`,
                orderId: order._id,
                orderNumber: order.orderNumber,
            });
            item.refundIssued = true;
            item.refundAmount = itemRefund;
        }
    }

    // If all items are cancelled, cancel entire order
    const allCancelled = order.items.every((i) => i.status === "CANCELLED");
    if (allCancelled) {
        order.orderStatus = "CANCELLED";
    }

    await order.save();
    return { success: true, message: `Item status updated to ${newStatus}.`, order };
};

/**
 * 5. Approve Return Item (credits refund to wallet)
 */
const approveReturnItem = async (orderId, itemId, adminMessage = "", restockImmediately = false) => {
    if (!orderId || !itemId) return { success: false, message: "Order ID and Item ID required." };

    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: "Order not found." };

    const item = order.items.id(itemId);
    if (!item) return { success: false, message: "Item not found in order." };

    item.status = "RETURN_APPROVED";
    item.adminFeedback = adminMessage || "Return approved by admin";
    item.adminFeedbackAt = new Date();

    const itemRefund = item.finalPayable != null ? item.finalPayable : item.lineTotal;
    const isPaid = order.paymentStatus === "COMPLETED" || order.paymentMethod === "COD";

    if (isPaid && itemRefund > 0 && !item.refundIssued) {
        await walletService.creditWallet({
            userId: order.userId,
            amount: itemRefund,
            reason: "ORDER_RETURN",
            description: `Refund for returned item (${item.productName}) in Order #${order.orderNumber}`,
            orderId: order._id,
            orderNumber: order.orderNumber,
        });
        item.refundIssued = true;
        item.refundAmount = itemRefund;
    }

    if (restockImmediately && item.variantId && !item.isRestocked) {
        await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
        item.isRestocked = true;
        item.status = "RETURNED";
    }

    await order.save();
    return { success: true, message: "Return request approved and refund credited.", order };
};

/**
 * 6. Reject Return Item
 */
const rejectReturnItem = async (orderId, itemId, adminMessage = "") => {
    if (!orderId || !itemId) return { success: false, message: "Order ID and Item ID required." };

    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: "Order not found." };

    const item = order.items.id(itemId);
    if (!item) return { success: false, message: "Item not found in order." };

    item.status = "RETURN_REJECTED";
    item.adminFeedback = adminMessage || "Return rejected by admin";
    item.adminFeedbackAt = new Date();

    await order.save();
    return { success: true, message: "Return request rejected.", order };
};

/**
 * 7. Restock Return Item
 */
const restockReturnItem = async (orderId, itemId, adminMessage = "") => {
    if (!orderId || !itemId) return { success: false, message: "Order ID and Item ID required." };

    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: "Order not found." };

    const item = order.items.id(itemId);
    if (!item) return { success: false, message: "Item not found in order." };

    if (item.variantId && !item.isRestocked) {
        await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
        item.isRestocked = true;
        item.status = "RETURNED";
    }
    if (adminMessage) item.adminFeedback = adminMessage;

    await order.save();
    return { success: true, message: "Item stock restored successfully.", order };
};

/**
 * 8. Update Payment Status directly
 */
const updatePaymentStatus = async (orderId, newPaymentStatus) => {
    if (!orderId) return { success: false, message: "Order ID is required." };
    if (!VALID_PAYMENT_STATUSES.includes(newPaymentStatus)) {
        return { success: false, message: `Invalid payment status: ${newPaymentStatus}` };
    }

    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: "Order not found." };

    order.paymentStatus = newPaymentStatus;
    if (newPaymentStatus === "COMPLETED") order.paidAt = new Date();
    await order.save();

    return { success: true, message: `Payment status updated to ${newPaymentStatus}.`, order };
};

module.exports = {
    getAdminOrders,
    getAdminOrderDetails,
    updateOrderStatus,
    updateAdminOrderItemStatus,
    approveReturnItem,
    rejectReturnItem,
    restockReturnItem,
    updatePaymentStatus,
    VALID_ORDER_STATUSES,
    VALID_PAYMENT_STATUSES,
};