const mongoose = require("mongoose");
const Order = require("../../models/order/orderModel");
const Payment = require("../../models/order/paymentModel");
const User = require("../../models/user/userModel");
const Variant = require("../../models/product/variantModel");

const {
    validateStatusTransition,
    calculateOrderStatusFromItems,
    ALL_VALID_ORDER_STATUSES,
} = require("../../helpers/orderStatusHelper");

const VALID_ORDER_STATUSES = ALL_VALID_ORDER_STATUSES;

const VALID_PAYMENT_STATUSES = [
    "PENDING",
    "COMPLETED",
    "FAILED",
    "REFUNDED",
    "CANCELLED",
];

/**
 * Fetch orders with search, sort, filter, and pagination for Admin
 */
const getAdminOrders = async ({
    search = "",
    status = "all",
    paymentMethod = "all",
    paymentStatus = "all",
    sort = "date_desc",
    page = 1,
    limit = 10,
}) => {
    const query = {};

    // 1. Status Filter
    if (status && status !== "all") {
        if (status === "PENDING" || status === "PLACED") {
            query.orderStatus = { $in: ["PENDING", "PLACED"] };
        } else {
            query.orderStatus = status;
        }
    }

    // 2. Payment Method Filter
    if (paymentMethod && paymentMethod !== "all") {
        query.paymentMethod = paymentMethod;
    }

    // 3. Payment Status Filter
    if (paymentStatus && paymentStatus !== "all") {
        query.paymentStatus = paymentStatus;
    }

    // 4. Search Filter with regex escaping
    if (search && search.trim()) {
        const term = search.trim();
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const searchRegex = { $regex: escapedTerm, $options: "i" };

        const matchingUsers = await User.find({
            $or: [
                { fullName: searchRegex },
                { email: searchRegex },
                { phone: searchRegex },
            ],
        }).select("_id");

        const matchingUserIds = matchingUsers.map((u) => u._id);

        query.$or = [
            { orderNumber: searchRegex },
            { "shippingAddress.firstName": searchRegex },
            { "shippingAddress.lastName": searchRegex },
            { "shippingAddress.phone": searchRegex },
            { "shippingAddress.city": searchRegex },
            { "items.productName": searchRegex },
            { "items.sku": searchRegex },
            ...(matchingUserIds.length > 0 ? [{ userId: { $in: matchingUserIds } }] : []),
        ];
    }

    // 5. Sorting
    let sortOption = { placedAt: -1, createdAt: -1, _id: -1 };
    if (sort === "date_asc") {
        sortOption = { placedAt: 1, createdAt: 1, _id: 1 };
    } else if (sort === "amount_desc") {
        sortOption = { "pricing.totalAmount": -1, _id: -1 };
    } else if (sort === "amount_asc") {
        sortOption = { "pricing.totalAmount": 1, _id: 1 };
    }

    // 6. Pagination validation & clamping
    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedLimit = Math.max(1, Math.min(100, Number(limit) || 10));

    const totalOrders = await Order.countDocuments(query);
    const totalPages = Math.ceil(totalOrders / parsedLimit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const skip = (currentPage - 1) * parsedLimit;

    const [orders, statusCounts] = await Promise.all([
        Order.find(query)
            .populate("userId", "fullName email phone avatar")
            .sort(sortOption)
            .skip(skip)
            .limit(parsedLimit)
            .lean(),

        Order.aggregate([
            {
                $group: {
                    _id: "$orderStatus",
                    count: { $sum: 1 },
                },
            },
        ]),
    ]);

    const countsMap = {
        all: 0,
        PENDING: 0,
        PROCESSING: 0,
        SHIPPED: 0,
        OUT_FOR_DELIVERY: 0,
        DELIVERED: 0,
        CANCELLED: 0,
        RETURN_REQUESTED: 0,
        RETURNED: 0,
    };

    statusCounts.forEach((s) => {
        countsMap.all += s.count;
        if (s._id === "PLACED") {
            countsMap.PENDING += s.count;
        } else if (countsMap[s._id] !== undefined) {
            countsMap[s._id] += s.count;
        }
    });

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
 * Fetch a single order's complete details for Admin
 */
const getAdminOrderDetails = async (orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findById(orderId)
        .populate("userId", "fullName email phone avatar createdAt")
        .lean();

    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const payments = await Payment.find({ orderId: order._id }).lean();

    return {
        success: true,
        order,
        payments,
    };
};

/**
 * Update order status across eligible items with forward-only delivery progression
 * Generic status endpoints cannot bypass return approval or restocking rules.
 */
const updateOrderStatus = async (orderId, newStatus, { deliveryNotes = "", adminNote = "" } = {}) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const normalizedStatus = (newStatus || "").trim().toUpperCase();
    if (!VALID_ORDER_STATUSES.includes(normalizedStatus)) {
        return { success: false, message: `Invalid status: ${newStatus}` };
    }

    // Generic order update cannot bypass return workflow
    if (["RETURN_APPROVED", "RETURN_REJECTED", "RETURNED"].includes(normalizedStatus)) {
        return {
            success: false,
            message: "Return workflow actions must be performed using explicit return review endpoints.",
        };
    }

    const order = await Order.findById(orderId);
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const previousStatus = order.orderStatus;
    if (previousStatus === normalizedStatus && !deliveryNotes && !adminNote) {
        return { success: true, message: `Order is already "${normalizedStatus}".`, order };
    }

    const now = new Date();

    // 1. Bulk Cancellation
    if (normalizedStatus === "CANCELLED") {
        const cancellableItems = order.items.filter((i) =>
            ["PENDING", "PLACED", "ACTIVE", "PROCESSING"].includes(i.status)
        );

        if (cancellableItems.length === 0) {
            return {
                success: false,
                message: "Cannot cancel order: no active cancellable items remain (items already shipped/delivered cannot be cancelled).",
            };
        }

        for (const item of cancellableItems) {
            await Variant.updateOne({ _id: item.variantId }, { $inc: { stock: item.quantity } });
            item.status = "CANCELLED";
            item.cancellationReason = adminNote ? `Admin Cancelled: ${adminNote.trim()}` : "Cancelled by Admin";
            item.cancelledAt = now;
            item.cancelledBy = "ADMIN";
        }

        const remainingActive = order.items.filter((i) => !["CANCELLED", "RETURNED"].includes(i.status));
        const totalCancelled = order.items
            .filter((i) => i.status === "CANCELLED")
            .reduce((s, i) => s + i.lineTotal, 0);

        order.pricing.cancellationDeduction = totalCancelled;

        if (remainingActive.length === 0) {
            order.orderStatus = "CANCELLED";
            order.cancellationReason = adminNote ? `Admin Cancelled: ${adminNote.trim()}` : "Cancelled by Admin";
            order.cancelledAt = now;
            order.cancelledBy = "ADMIN";
            order.pricing.currentPayable = 0;

            if (order.paymentMethod === "COD") {
                order.paymentStatus = "CANCELLED";
                await Payment.updateMany({ orderId: order._id }, { $set: { status: "CANCELLED" } });
            }
        } else {
            order.orderStatus = calculateOrderStatusFromItems(order.items);
            order.pricing.currentPayable = Math.max(
                0,
                (order.pricing.originalTotalAmount || order.pricing.totalAmount) - totalCancelled - (order.pricing.returnCredit || 0)
            );

            if (order.paymentMethod === "COD") {
                await Payment.updateMany(
                    { orderId: order._id, status: "PENDING" },
                    { $set: { amount: order.pricing.currentPayable } }
                );
            }
        }
    } else {
        // Forward progression delivery workflow: PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED
        let modifiedAny = false;

        for (const item of order.items) {
            // Never modify items in terminal or return states
            if (["CANCELLED", "RETURNED", "RETURN_REQUESTED", "RETURN_APPROVED", "RETURN_REJECTED"].includes(item.status)) {
                continue;
            }

            const check = validateStatusTransition(item.status, normalizedStatus);
            if (check.allowed && item.status !== normalizedStatus) {
                item.status = normalizedStatus;
                modifiedAny = true;
            }
        }

        if (!modifiedAny && previousStatus !== normalizedStatus) {
            return {
                success: false,
                message: `None of the items in this order can transition to "${normalizedStatus}".`,
            };
        }

        if (normalizedStatus === "DELIVERED") {
            order.deliveredAt = now;
            // Complete COD payment when order is delivered
            if (order.paymentMethod === "COD" && order.paymentStatus === "PENDING") {
                order.paymentStatus = "COMPLETED";
                order.paidAt = now;
                await Payment.updateMany(
                    { orderId: order._id, paymentMethod: "COD" },
                    { $set: { status: "COMPLETED", paidAt: now } }
                );
            }
        }

        order.orderStatus = calculateOrderStatusFromItems(order.items);
    }

    if (adminNote) {
        order.adminFeedback = adminNote.trim();
        order.adminFeedbackAt = now;
    }

    if (deliveryNotes) {
        order.deliveryNotes = deliveryNotes.trim();
    }

    await order.save();

    return {
        success: true,
        message: `Order updated to "${order.orderStatus.replace(/_/g, " ")}".`,
        order,
    };
};

/**
 * Update individual order item status with forward-only validation and parent sync
 */
const updateAdminOrderItemStatus = async (orderId, itemId, newStatus, { adminNote = "" } = {}) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const normalizedStatus = (newStatus || "").trim().toUpperCase();
    if (!VALID_ORDER_STATUSES.includes(normalizedStatus)) {
        return { success: false, message: `Invalid status: ${newStatus}` };
    }

    // Direct return modifications must use approval/restock endpoints
    if (["RETURN_APPROVED", "RETURN_REJECTED", "RETURNED"].includes(normalizedStatus)) {
        return {
            success: false,
            message: "Return workflow actions must be performed using dedicated return approval and restock functions.",
        };
    }

    const order = await Order.findById(orderId);
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const item = order.items.id(itemId);
    if (!item) {
        return { success: false, message: "Item not found in order." };
    }

    const previousStatus = item.status;
    if (previousStatus === normalizedStatus && !adminNote) {
        return { success: true, message: `Item is already "${normalizedStatus}".`, order };
    }

    const transitionCheck = validateStatusTransition(previousStatus, normalizedStatus);
    if (!transitionCheck.allowed) {
        return { success: false, message: transitionCheck.message };
    }

    const now = new Date();

    // Handle cancellation of item
    if (normalizedStatus === "CANCELLED" && previousStatus !== "CANCELLED") {
        await Variant.updateOne(
            { _id: item.variantId },
            { $inc: { stock: item.quantity } }
        );
        item.status = "CANCELLED";
        item.cancellationReason = adminNote ? `Admin Cancelled: ${adminNote.trim()}` : "Cancelled by Admin";
        item.cancelledAt = now;
        item.cancelledBy = "ADMIN";

        const remainingActive = order.items.filter((i) => !["CANCELLED", "RETURNED"].includes(i.status));
        const totalCancelled = order.items
            .filter((i) => i.status === "CANCELLED")
            .reduce((s, i) => s + i.lineTotal, 0);

        order.pricing.cancellationDeduction = totalCancelled;

        if (remainingActive.length === 0) {
            order.orderStatus = "CANCELLED";
            order.cancellationReason = item.cancellationReason;
            order.cancelledAt = now;
            order.cancelledBy = "ADMIN";
            order.pricing.currentPayable = 0;

            if (order.paymentMethod === "COD") {
                order.paymentStatus = "CANCELLED";
                await Payment.updateMany({ orderId: order._id }, { $set: { status: "CANCELLED" } });
            }
        } else {
            order.orderStatus = calculateOrderStatusFromItems(order.items);
            order.pricing.currentPayable = Math.max(
                0,
                (order.pricing.originalTotalAmount || order.pricing.totalAmount) - totalCancelled - (order.pricing.returnCredit || 0)
            );

            if (order.paymentMethod === "COD") {
                await Payment.updateMany(
                    { orderId: order._id, status: "PENDING" },
                    { $set: { amount: order.pricing.currentPayable } }
                );
            }
        }
    } else {
        item.status = normalizedStatus;
        if (normalizedStatus === "DELIVERED") {
            const allRemainingDelivered = order.items
                .filter((i) => !["CANCELLED", "RETURNED"].includes(i.status))
                .every((i) => i.status === "DELIVERED");

            if (allRemainingDelivered) {
                order.deliveredAt = now;
                if (order.paymentMethod === "COD" && order.paymentStatus === "PENDING") {
                    order.paymentStatus = "COMPLETED";
                    order.paidAt = now;
                    await Payment.updateMany(
                        { orderId: order._id, paymentMethod: "COD" },
                        { $set: { status: "COMPLETED", paidAt: now } }
                    );
                }
            }
        }
        order.orderStatus = calculateOrderStatusFromItems(order.items);
    }

    if (adminNote) {
        item.adminFeedback = adminNote.trim();
        item.adminFeedbackAt = now;
    }

    await order.save();

    return {
        success: true,
        message: `Product "${item.productName}" updated to "${normalizedStatus.replace(/_/g, " ")}".`,
        order,
    };
};

/**
 * Approve a return request for an item (Return Initiated / Accepted)
 * Requires mandatory nonblank customer message. Does NOT auto-restock before receipt confirmation.
 */
const approveReturnItem = async (orderId, itemId, adminMessage = "") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const cleanMessage = (adminMessage || "").trim();
    if (!cleanMessage) {
        return { success: false, message: "A non-blank message to the customer is required when approving a return." };
    }

    const order = await Order.findById(orderId);
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const item = order.items.id(itemId);
    if (!item) {
        return { success: false, message: "Item not found in order." };
    }

    if (item.status !== "RETURN_REQUESTED") {
        return {
            success: false,
            message: `Cannot approve return: Item is currently "${item.status.replace(/_/g, " ")}", not "RETURN REQUESTED".`,
        };
    }

    const now = new Date();
    item.status = "RETURN_APPROVED";
    item.adminFeedback = cleanMessage;
    item.adminFeedbackAt = now;

    order.orderStatus = calculateOrderStatusFromItems(order.items);
    await order.save();

    return {
        success: true,
        message: `Return approved for "${item.productName}". You can restock it once the item is received and inspected.`,
        order,
    };
};

/**
 * Reject a return request for an item
 * Requires mandatory nonblank customer message.
 */
const rejectReturnItem = async (orderId, itemId, adminMessage = "") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const cleanMessage = (adminMessage || "").trim();
    if (!cleanMessage) {
        return { success: false, message: "A non-blank message explaining the rejection to the customer is required." };
    }

    const order = await Order.findById(orderId);
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const item = order.items.id(itemId);
    if (!item) {
        return { success: false, message: "Item not found in order." };
    }

    if (item.status !== "RETURN_REQUESTED") {
        return {
            success: false,
            message: `Cannot reject return: Item is currently "${item.status.replace(/_/g, " ")}", not "RETURN REQUESTED".`,
        };
    }

    const now = new Date();
    item.status = "RETURN_REJECTED";
    item.adminFeedback = cleanMessage;
    item.adminFeedbackAt = now;

    order.orderStatus = calculateOrderStatusFromItems(order.items);
    await order.save();

    return {
        success: true,
        message: `Return request rejected for "${item.productName}".`,
        order,
    };
};

/**
 * Restock an approved return item back into inventory after receipt confirmation.
 * Never permits restocking a merely RETURN_REQUESTED item.
 */
const restockReturnItem = async (orderId, itemId, adminMessage = "") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const order = await Order.findById(orderId);
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const item = order.items.id(itemId);
    if (!item) {
        return { success: false, message: "Item not found in order." };
    }

    if (item.status === "RETURN_REQUESTED") {
        return {
            success: false,
            message: "Cannot restock: Item is merely RETURN_REQUESTED and must be approved before receiving and restocking.",
        };
    }

    if (!["RETURN_APPROVED", "RETURNED"].includes(item.status)) {
        return {
            success: false,
            message: `Cannot restock: Item must be in "RETURN_APPROVED" status. Current status: "${item.status}".`,
        };
    }

    if (item.isRestocked) {
        return { success: false, message: `"${item.productName}" is already restocked into inventory.` };
    }

    // Atomically increment inventory back
    const vRes = await Variant.updateOne(
        { _id: item.variantId },
        { $inc: { stock: item.quantity } }
    );

    if (vRes.matchedCount === 0) {
        return { success: false, message: "Variant not found for inventory restoration." };
    }

    const now = new Date();
    item.isRestocked = true;
    item.restockedAt = now;
    item.restockedBy = "ADMIN";
    item.status = "RETURNED";

    if (adminMessage && adminMessage.trim()) {
        item.adminFeedback = adminMessage.trim();
        item.adminFeedbackAt = now;
    }

    const totalReturnCredit = order.items
        .filter((i) => i.status === "RETURNED")
        .reduce((s, i) => s + i.lineTotal, 0);

    order.pricing.returnCredit = totalReturnCredit;
    order.pricing.currentPayable = Math.max(
        0,
        (order.pricing.originalTotalAmount || order.pricing.totalAmount) - (order.pricing.cancellationDeduction || 0) - totalReturnCredit
    );

    order.orderStatus = calculateOrderStatusFromItems(order.items);
    await order.save();

    return {
        success: true,
        message: `Stock for "${item.productName}" (+${item.quantity} units) has been restored to inventory successfully.`,
        order,
    };
};

/**
 * Update payment status of an order
 */
const updatePaymentStatus = async (orderId, newPaymentStatus) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const normalizedStatus = (newPaymentStatus || "").trim().toUpperCase();
    if (!VALID_PAYMENT_STATUSES.includes(normalizedStatus)) {
        return { success: false, message: `Invalid payment status: ${newPaymentStatus}` };
    }

    const order = await Order.findById(orderId);
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    order.paymentStatus = normalizedStatus;
    const now = new Date();

    const updateObj = { status: normalizedStatus };
    if (normalizedStatus === "COMPLETED") {
        updateObj.paidAt = now;
    } else if (normalizedStatus === "REFUNDED") {
        updateObj.refundedAt = now;
        updateObj.refundAmount = order.pricing.returnCredit || order.pricing.totalAmount;
    }

    await order.save();

    await Payment.updateMany(
        { orderId: order._id },
        { $set: updateObj }
    );

    return {
        success: true,
        message: `Payment status updated to "${normalizedStatus}".`,
        order,
    };
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
