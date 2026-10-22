const mongoose = require("mongoose");
const Order = require("../../models/order/orderModel");
const Payment = require("../../models/order/paymentModel");
const User = require("../../models/user/userModel");
const Transaction = require("../../models/user/transactionModel");
const Variant = require("../../models/product/variantModel");
const escapeRegex = require("../../utils/escapeRegex");
const walletService = require("../user/walletService");
const restoreCancellationStock = require("../../helpers/restoreCancellationStock");
const restoreReturnStock = require("../../helpers/restoreReturnStock");
const {
    validateStatusTransition,
    calculateOrderStatusFromItems,
    shouldCompleteCodPayment,
} = require("../../helpers/orderStatusHelper");

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
 * Fetch paginated orders for Admin with comprehensive filters, search, and status counters
 */
const getAdminOrders = async (options = {}) => {
    const {
        search = "",
        status = "ALL",
        paymentMethod = "ALL",
        paymentStatus = "ALL",
        sort = "placedAt_desc",
        page = 1,
        limit = 10,
    } = options;

    const filter = {};

    if (status && status !== "ALL") {
        if (status === "ACTIVE") {
            filter.orderStatus = { $in: ["PENDING", "PLACED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"] };
        } else {
            filter.orderStatus = status;
        }
    }

    if (paymentMethod && paymentMethod !== "ALL") {
        filter.paymentMethod = paymentMethod;
    }

    if (paymentStatus && paymentStatus !== "ALL") {
        filter.paymentStatus = paymentStatus;
    }

    if (typeof search === "string" && search.trim()) {
        const escaped = escapeRegex(search.trim());
        const regex = new RegExp(escaped, "i");

        const matchedUsers = await User.find({
            $or: [{ fullName: regex }, { email: regex }, { phone: regex }],
        }).select("_id");

        const userIds = matchedUsers.map((u) => u._id);

        filter.$or = [
            { orderNumber: regex },
            { orderId: regex },
            { "shippingAddress.firstName": regex },
            { "shippingAddress.lastName": regex },
            { "shippingAddress.phone": regex },
            { "items.productName": regex },
            { "items.sku": regex },
            ...(userIds.length > 0 ? [{ userId: { $in: userIds } }] : []),
        ];
    }

    const countsPipeline = [
        ...(Object.keys(filter).length > 0 && !filter.orderStatus ? [{ $match: filter }] : []),
        {
            $group: {
                _id: "$orderStatus",
                count: { $sum: 1 },
            },
        },
    ];
    const statusCountsRaw = await Order.aggregate(countsPipeline);
    const countsMap = { ALL: 0 };
    for (const row of statusCountsRaw) {
        countsMap[row._id] = row.count;
        countsMap.ALL += row.count;
    }

    let sortStage = { placedAt: -1, createdAt: -1 };
    if (sort === "placedAt_asc") sortStage = { placedAt: 1, createdAt: 1 };
    else if (sort === "totalAmount_desc") sortStage = { "pricing.totalAmount": -1 };
    else if (sort === "totalAmount_asc") sortStage = { "pricing.totalAmount": 1 };

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
 * Enforces:
 * - Refunds paid orders to wallet on cancellation (Finding 2)
 * - Block unpaid online fulfillment (Finding 25)
 * - Accurate cancellation deduction using allocated purchase amount (Finding 4)
 * - Current payable 0 when all items cancelled (Finding 5)
 * - Non-destructive status sync (Findings 6, 8, 10)
 */
const updateOrderStatus = async (orderId, newStatus, { deliveryNotes = "", adminNote = "" } = {}) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const normalizedStatus = (newStatus || "").trim().toUpperCase();
    if (!VALID_ORDER_STATUSES.includes(normalizedStatus)) {
        return { success: false, message: `Invalid status: ${newStatus}` };
    }

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

    // Finding 25: Block fulfilling unpaid ONLINE orders
    if (order.paymentMethod === "ONLINE" && order.paymentStatus !== "COMPLETED") {
        if (["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].includes(normalizedStatus)) {
            return {
                success: false,
                message: "Cannot fulfill unpaid online order. Customer payment must be completed first.",
            };
        }
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

        const cancelledSuccessfully = [];
        for (const item of cancellableItems) {
            const updated = await Order.findOneAndUpdate(
                {
                    _id: orderId,
                    items: {
                        $elemMatch: {
                            _id: item._id,
                            status: { $in: ["PENDING", "PLACED", "ACTIVE", "PROCESSING"] },
                        },
                    },
                },
                {
                    $set: {
                        "items.$.status": "CANCELLED",
                        "items.$.cancellationReason": adminNote ? `Admin Cancelled: ${adminNote.trim()}` : "Cancelled by Admin",
                        "items.$.cancelledAt": now,
                        "items.$.cancelledBy": "ADMIN",
                    },
                },
                { returnDocument: "after" }
            );

            if (updated) {
                await restoreCancellationStock(order._id, item);
                cancelledSuccessfully.push(item);
            }
        }

        if (cancelledSuccessfully.length === 0) {
            return {
                success: false,
                message: "Cannot cancel order: items were already cancelled or shipped concurrently.",
            };
        }

        // Reload latest order state after atomic item updates
        const latestOrder = await Order.findById(orderId);
        const remainingActive = latestOrder.items.filter((i) => !["CANCELLED", "RETURNED"].includes(i.status));

        // Finding 4: Use allocated purchase amount (finalPayable) rather than pre-coupon lineTotal
        const totalCancelledDeduction = latestOrder.items
            .filter((i) => i.status === "CANCELLED")
            .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

        const totalReturnCredit = latestOrder.items
            .filter((i) => ["RETURNED", "RETURN_APPROVED"].includes(i.status))
            .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

        latestOrder.pricing.cancellationDeduction = totalCancelledDeduction;
        latestOrder.pricing.returnCredit = totalReturnCredit;

        const isAllCancelled = remainingActive.length === 0 && latestOrder.items.every((i) => i.status === "CANCELLED");

        // Finding 5: Fully cancelled orders have currentPayable = 0
        const currentPayable = isAllCancelled
            ? 0
            : Math.max(
                  0,
                  (latestOrder.pricing.originalTotalAmount || latestOrder.pricing.totalAmount) -
                      totalCancelledDeduction -
                      totalReturnCredit
              );
        latestOrder.pricing.currentPayable = currentPayable;

        // Finding 2: Admin cancellation refunds paid ONLINE/WALLET orders to customer's wallet
        let totalRefundCredited = 0;
        if (latestOrder.paymentStatus === "COMPLETED") {
            for (const item of cancelledSuccessfully) {
                const refundAmount = item.finalPayable != null ? item.finalPayable : item.lineTotal;
                if (refundAmount > 0) {
                    await walletService.creditWallet({
                        userId: latestOrder.userId,
                        amount: refundAmount,
                        reason: "ORDER_CANCELLATION",
                        description: `Admin cancellation refund for "${item.productName}" in Order #${latestOrder.orderNumber}`,
                        orderId: latestOrder._id,
                        orderNumber: latestOrder.orderNumber,
                        referenceId: `REFUND_ADM_CAN_${latestOrder._id}_${item._id}`,
                    });
                    totalRefundCredited += refundAmount;
                }
            }

            if (isAllCancelled && latestOrder.pricing?.shippingFee > 0) {
                await walletService.creditWallet({
                    userId: latestOrder.userId,
                    amount: latestOrder.pricing.shippingFee,
                    reason: "ORDER_CANCELLATION",
                    description: `Admin cancellation refund for shipping fee in Order #${latestOrder.orderNumber}`,
                    orderId: latestOrder._id,
                    orderNumber: latestOrder.orderNumber,
                    referenceId: `REFUND_ADM_CAN_${latestOrder._id}_SHIPPING`,
                });
                totalRefundCredited += latestOrder.pricing.shippingFee;
            }
        }

        if (totalRefundCredited > 0) {
            latestOrder.pricing.walletRefundIssued =
                (latestOrder.pricing.walletRefundIssued || 0) + totalRefundCredited;
        }

        // Finding 6: Accurately derive overall order status
        latestOrder.orderStatus = calculateOrderStatusFromItems(latestOrder.items);

        if (isAllCancelled) {
            latestOrder.cancellationReason = adminNote ? `Admin Cancelled: ${adminNote.trim()}` : "Cancelled by Admin";
            latestOrder.cancelledAt = now;
            latestOrder.cancelledBy = "ADMIN";
            if (latestOrder.paymentMethod === "COD") {
                latestOrder.paymentStatus = "CANCELLED";
                await Payment.updateMany({ orderId: latestOrder._id }, { $set: { status: "CANCELLED" } });
            } else if (latestOrder.paymentStatus === "COMPLETED") {
                latestOrder.paymentStatus = "REFUNDED";
                await Payment.updateMany(
                    { orderId: latestOrder._id },
                    { $set: { status: "REFUNDED", refundedAt: now, refundAmount: latestOrder.pricing?.walletRefundIssued || totalRefundCredited } }
                );
            }
        } else {
            if (latestOrder.paymentMethod === "COD") {
                await Payment.updateMany(
                    { orderId: latestOrder._id, status: "PENDING" },
                    { $set: { amount: currentPayable } }
                );
            } else if (totalRefundCredited > 0) {
                await Payment.updateMany(
                    { orderId: latestOrder._id },
                    { $inc: { refundAmount: totalRefundCredited } }
                );
            }
        }

        if (adminNote) {
            latestOrder.adminFeedback = adminNote.trim();
            latestOrder.adminFeedbackAt = now;
        }
        if (deliveryNotes) {
            latestOrder.deliveryNotes = deliveryNotes.trim();
        }

        await latestOrder.save();
        return {
            success: true,
            message: `Order updated to "${latestOrder.orderStatus.replace(/_/g, " ")}".${totalRefundCredited > 0 ? ` ₹${totalRefundCredited.toFixed(2)} refunded to customer's wallet.` : ""}`,
            order: latestOrder,
        };
    } else {
        // Forward progression delivery workflow: PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED
        // Finding 10: Atomic item transitions to avoid clobbering concurrent updates
        let modifiedAny = false;

        for (const item of order.items) {
            if (["CANCELLED", "RETURNED", "RETURN_REQUESTED", "RETURN_APPROVED", "RETURN_REJECTED"].includes(item.status)) {
                continue;
            }

            const check = validateStatusTransition(item.status, normalizedStatus);
            if (check.allowed && item.status !== normalizedStatus) {
                const res = await Order.updateOne(
                    {
                        _id: orderId,
                        items: {
                            $elemMatch: {
                                _id: item._id,
                                status: item.status,
                            },
                        },
                    },
                    {
                        $set: {
                            "items.$.status": normalizedStatus,
                            ...(adminNote ? { "items.$.adminFeedback": adminNote.trim(), "items.$.adminFeedbackAt": now } : {}),
                        },
                    }
                );
                if (res.modifiedCount > 0) modifiedAny = true;
            }
        }

        if (!modifiedAny && previousStatus !== normalizedStatus) {
            return {
                success: false,
                message: `None of the items in this order can transition to "${normalizedStatus}".`,
            };
        }

        const reloadedOrder = await Order.findById(orderId);

        if (normalizedStatus === "DELIVERED") {
            reloadedOrder.deliveredAt = now;
            if (reloadedOrder.paymentMethod === "COD" && reloadedOrder.paymentStatus === "PENDING") {
                if (shouldCompleteCodPayment(reloadedOrder.items)) {
                    reloadedOrder.paymentStatus = "COMPLETED";
                    reloadedOrder.paidAt = now;
                    await Payment.updateMany(
                        { orderId: reloadedOrder._id, paymentMethod: "COD" },
                        { $set: { status: "COMPLETED", paidAt: now } }
                    );
                }
            }
        }

        reloadedOrder.orderStatus = calculateOrderStatusFromItems(reloadedOrder.items);
        if (adminNote) {
            reloadedOrder.adminFeedback = adminNote.trim();
            reloadedOrder.adminFeedbackAt = now;
        }
        if (deliveryNotes) {
            reloadedOrder.deliveryNotes = deliveryNotes.trim();
        }

        await reloadedOrder.save();

        return {
            success: true,
            message: `Order updated to "${reloadedOrder.orderStatus.replace(/_/g, " ")}".`,
            order: reloadedOrder,
        };
    }
};

/**
 * Update individual order item status with forward-only validation and parent sync
 * Fixes:
 * - currentPayable undefined reference (Finding 1)
 * - Admin cancellation wallet refund (Finding 2)
 * - Use allocated purchase amount instead of lineTotal (Finding 4)
 * - Bound elemMatch item ID & status to same element (Finding 9)
 * - Block unpaid online progression (Finding 25)
 */
const updateAdminOrderItemStatus = async (orderId, itemId, newStatus, { adminNote = "" } = {}) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const normalizedStatus = (newStatus || "").trim().toUpperCase();
    if (!VALID_ORDER_STATUSES.includes(normalizedStatus)) {
        return { success: false, message: `Invalid status: ${newStatus}` };
    }

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

    // Finding 25: Block forward delivery progression on unpaid ONLINE orders
    if (order.paymentMethod === "ONLINE" && order.paymentStatus !== "COMPLETED") {
        if (["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].includes(normalizedStatus)) {
            return {
                success: false,
                message: "Cannot fulfill unpaid online order. Payment must be completed before order fulfillment.",
            };
        }
    }

    const transitionCheck = validateStatusTransition(previousStatus, normalizedStatus);
    if (!transitionCheck.allowed) {
        return { success: false, message: transitionCheck.message };
    }

    const now = new Date();

    // Handle cancellation of item atomically
    if (normalizedStatus === "CANCELLED") {
        let updatedOrder = null;
        if (previousStatus !== "CANCELLED") {
            updatedOrder = await Order.findOneAndUpdate(
                {
                    _id: orderId,
                    items: {
                        $elemMatch: {
                            _id: itemId,
                            status: { $in: ["PENDING", "PLACED", "ACTIVE", "PROCESSING"] },
                        },
                    },
                },
                {
                    $set: {
                        "items.$.status": "CANCELLED",
                        "items.$.cancellationReason": adminNote ? `Admin Cancelled: ${adminNote.trim()}` : "Cancelled by Admin",
                        "items.$.cancelledAt": now,
                        "items.$.cancelledBy": "ADMIN",
                        ...(adminNote ? { "items.$.adminFeedback": adminNote.trim(), "items.$.adminFeedbackAt": now } : {}),
                    },
                },
                { returnDocument: "after" }
            );
        } else {
            // Safe recovery path for orders left partially processed
            updatedOrder = await Order.findById(orderId);
        }

        if (!updatedOrder) {
            return {
                success: false,
                message: "Cannot cancel item: it is no longer in a cancellable status or was already cancelled/shipped.",
            };
        }

        const cancelledItem = updatedOrder.items.id(itemId);
        if (!cancelledItem.isStockRestored) {
            await restoreCancellationStock(orderId, cancelledItem);
            await Order.updateOne(
                { _id: orderId, "items._id": itemId },
                { $set: { "items.$.isStockRestored": true, "items.$.restockedQuantity": cancelledItem.quantity } }
            ).catch(() => {});
        }

        // Finding 2: Admin cancellation refunds paid orders to wallet
        let totalRefundCredited = 0;
        if (updatedOrder.paymentStatus === "COMPLETED" || updatedOrder.paymentStatus === "REFUNDED") {
            const itemRefund = cancelledItem.finalPayable != null ? cancelledItem.finalPayable : cancelledItem.lineTotal;
            const refundRef = `REFUND_CAN_${updatedOrder._id}_${cancelledItem._id}`;
            const existingTx = await Transaction.findOne({
                referenceId: { $in: [refundRef, `REFUND_ADM_CAN_${updatedOrder._id}_${cancelledItem._id}`] },
            });
            if (itemRefund > 0 && !cancelledItem.refundIssued && !existingTx) {
                const credRes = await walletService.creditWallet({
                    userId: updatedOrder.userId,
                    amount: itemRefund,
                    reason: "ORDER_CANCELLATION",
                    description: `Admin cancellation refund for "${cancelledItem.productName}" in Order #${updatedOrder.orderNumber}`,
                    orderId: updatedOrder._id,
                    orderNumber: updatedOrder.orderNumber,
                    referenceId: refundRef,
                });
                if (credRes.success && !credRes.isDuplicate) {
                    totalRefundCredited += itemRefund;
                }
                await Order.updateOne(
                    { _id: orderId, "items._id": itemId },
                    { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund } }
                ).catch(() => {});
            }

            const isAllNowCancelled = updatedOrder.items.every((i) => i.status === "CANCELLED");
            if (isAllNowCancelled && updatedOrder.pricing?.shippingFee > 0) {
                const shipRef = `REFUND_CAN_${updatedOrder._id}_SHIPPING`;
                const shipTx = await Transaction.findOne({
                    referenceId: { $in: [shipRef, `REFUND_ADM_CAN_${updatedOrder._id}_SHIPPING`] },
                });
                if (!shipTx) {
                    const shipRes = await walletService.creditWallet({
                        userId: updatedOrder.userId,
                        amount: updatedOrder.pricing.shippingFee,
                        reason: "ORDER_CANCELLATION",
                        description: `Admin cancellation refund for shipping fee in Order #${updatedOrder.orderNumber}`,
                        orderId: updatedOrder._id,
                        orderNumber: updatedOrder.orderNumber,
                        referenceId: shipRef,
                    });
                    if (shipRes.success && !shipRes.isDuplicate) {
                        totalRefundCredited += updatedOrder.pricing.shippingFee;
                    }
                }
            }
        }

        // Concurrency-safe reload: reload fresh order to ensure totals reflect concurrent actions on other items
        const freshOrder = await Order.findById(orderId);
        const orderForCalc = freshOrder || updatedOrder;

        // Finding 4: Accurate cancellation deduction using allocated purchase amount
        const totalCancelledDeduction = orderForCalc.items
            .filter((i) => i.status === "CANCELLED")
            .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

        const totalReturnCredit = orderForCalc.items
            .filter((i) => ["RETURNED", "RETURN_APPROVED"].includes(i.status))
            .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

        const isAllCancelled = orderForCalc.items.every((i) => i.status === "CANCELLED");

        // Finding 1 & 5: Define currentPayable properly; if all cancelled, currentPayable is 0
        const currentPayable = isAllCancelled
            ? 0
            : Math.max(
                  0,
                  (orderForCalc.pricing.originalTotalAmount || orderForCalc.pricing.totalAmount) -
                      totalCancelledDeduction -
                      totalReturnCredit
              );

        // Finding 6: Calculate order status using item array
        const newOrderStatus = calculateOrderStatusFromItems(orderForCalc.items);

        const setFields = {
            orderStatus: newOrderStatus,
            "pricing.cancellationDeduction": totalCancelledDeduction,
            "pricing.returnCredit": totalReturnCredit,
            "pricing.currentPayable": currentPayable,
            ...(isAllCancelled
                ? {
                      cancellationReason: cancelledItem.cancellationReason,
                      cancelledAt: now,
                      cancelledBy: "ADMIN",
                      ...(updatedOrder.paymentMethod === "COD" ? { paymentStatus: "CANCELLED" } : { paymentStatus: "REFUNDED" }),
                  }
                : {}),
        };

        const updateOps = { $set: setFields };
        if (totalRefundCredited > 0) {
            updateOps.$inc = { "pricing.walletRefundIssued": totalRefundCredited };
        }

        const cumulativeRefund = (updatedOrder.pricing?.walletRefundIssued || 0) + totalRefundCredited;
        if (isAllCancelled) {
            if (updatedOrder.paymentMethod === "COD") {
                await Payment.updateMany({ orderId }, { $set: { status: "CANCELLED" } });
            } else if (updatedOrder.paymentStatus === "COMPLETED" || updatedOrder.paymentStatus === "REFUNDED") {
                await Payment.updateMany(
                    { orderId },
                    { $set: { status: "REFUNDED", refundedAt: now, refundAmount: cumulativeRefund } }
                );
            }
        } else if (updatedOrder.paymentMethod === "COD") {
            await Payment.updateMany({ orderId, status: "PENDING" }, { $set: { amount: currentPayable } });
        } else if (totalRefundCredited > 0) {
            await Payment.updateMany({ orderId }, { $inc: { refundAmount: totalRefundCredited } });
        }

        await Order.updateOne({ _id: orderId }, updateOps);
        const finalOrder = await Order.findById(orderId);

        return {
            success: true,
            message: `Product "${cancelledItem.productName}" cancelled successfully.${totalRefundCredited > 0 ? ` ₹${totalRefundCredited.toFixed(2)} refunded to customer's wallet.` : ""}`,
            order: finalOrder,
        };
    } else {
        // Forward progression delivery workflow:
        // Finding 9: Bind item ID and status to the SAME array element using $elemMatch
        const updatedOrder = await Order.findOneAndUpdate(
            {
                _id: orderId,
                items: {
                    $elemMatch: {
                        _id: itemId,
                        status: previousStatus,
                    },
                },
            },
            {
                $set: {
                    "items.$.status": normalizedStatus,
                    ...(adminNote ? { "items.$.adminFeedback": adminNote.trim(), "items.$.adminFeedbackAt": now } : {}),
                },
            },
            { returnDocument: "after" }
        );

        if (!updatedOrder) {
            return {
                success: false,
                message: `Cannot transition item to "${normalizedStatus}": item status changed concurrently.`,
            };
        }

        const parentStatus = calculateOrderStatusFromItems(updatedOrder.items);
        const parentUpdate = { orderStatus: parentStatus };

        if (normalizedStatus === "DELIVERED") {
            if (shouldCompleteCodPayment(updatedOrder.items)) {
                parentUpdate.deliveredAt = now;
                if (updatedOrder.paymentMethod === "COD" && updatedOrder.paymentStatus === "PENDING") {
                    parentUpdate.paymentStatus = "COMPLETED";
                    parentUpdate.paidAt = now;
                    await Payment.updateMany(
                        { orderId: updatedOrder._id, paymentMethod: "COD" },
                        { $set: { status: "COMPLETED", paidAt: now } }
                    );
                }
            }
        }

        await Order.updateOne({ _id: orderId }, { $set: parentUpdate });
        const finalOrder = await Order.findById(orderId);

        return {
            success: true,
            message: `Product "${item.productName}" updated to "${normalizedStatus.replace(/_/g, " ")}".`,
            order: finalOrder,
        };
    }
};

/**
 * Approve a return request for an item (Return Initiated / Accepted)
 * Requires mandatory nonblank customer message.
 * Credits refund to user's wallet if order was paid (ONLINE/WALLET or delivered COD item).
 * Uses atomic conditional update to prevent concurrent approval vs rejection races (Finding 32).
 */
const approveReturnItem = async (orderId, itemId, adminMessage = "") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const cleanMessage = (adminMessage || "").trim();
    if (!cleanMessage) {
        return { success: false, message: "A non-blank message to the customer is required when approving a return." };
    }

    const now = new Date();

    // Atomic conditional check: allow transition from RETURN_REQUESTED or retry if already RETURN_APPROVED but unrefunded
    let updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            items: {
                $elemMatch: {
                    _id: itemId,
                    status: "RETURN_REQUESTED",
                },
            },
        },
        {
            $set: {
                "items.$.status": "RETURN_APPROVED",
                "items.$.adminFeedback": cleanMessage,
                "items.$.adminFeedbackAt": now,
            },
        },
        { returnDocument: "after" }
    );

    if (!updatedOrder) {
        // Check if item is already RETURN_APPROVED but unrefunded (resumption path)
        updatedOrder = await Order.findOne({
            _id: orderId,
            items: {
                $elemMatch: {
                    _id: itemId,
                    status: "RETURN_APPROVED",
                    refundIssued: { $ne: true },
                },
            },
        });

        if (!updatedOrder) {
            const order = await Order.findById(orderId);
            if (!order) return { success: false, message: "Order not found." };
            const item = order.items.id(itemId);
            if (!item) return { success: false, message: "Item not found in order." };
            return {
                success: false,
                message: `Cannot approve return: Item is currently "${item.status.replace(/_/g, " ")}", not "RETURN REQUESTED".`,
            };
        }
    }

    const item = updatedOrder.items.id(itemId);
    const refundAmount = item.finalPayable != null ? item.finalPayable : item.lineTotal;
    let walletCredited = false;

    const isPaid = updatedOrder.paymentStatus === "COMPLETED" || updatedOrder.paymentMethod === "COD";

    if (isPaid && refundAmount > 0 && !item.refundIssued) {
        const currentRefunded = updatedOrder.pricing.walletRefundIssued || 0;
        const maxAllowedRefund = Math.max(0, updatedOrder.pricing.totalAmount - currentRefunded);
        const actualRefund = Math.min(refundAmount, maxAllowedRefund);

        if (actualRefund > 0) {
            const credRes = await walletService.creditWallet({
                userId: updatedOrder.userId,
                amount: actualRefund,
                reason: "ORDER_RETURN",
                description: `Refund for return of "${item.productName}" in Order #${updatedOrder.orderNumber}`,
                orderId: updatedOrder._id,
                orderNumber: updatedOrder.orderNumber,
                referenceId: `REFUND_RET_${updatedOrder._id}_${item._id}`,
            });

            if (credRes.success) {
                item.refundIssued = true;
                item.refundAmount = actualRefund;
                await Order.updateOne(
                    { _id: orderId, "items._id": itemId },
                    { $set: { "items.$.refundIssued": true, "items.$.refundAmount": actualRefund } }
                ).catch(() => {});

                if (!credRes.isDuplicate) {
                    updatedOrder.pricing.walletRefundIssued = (updatedOrder.pricing.walletRefundIssued || 0) + actualRefund;
                    walletCredited = true;
                    await Payment.updateMany(
                        { orderId: updatedOrder._id },
                        { $inc: { refundAmount: actualRefund } }
                    ).catch(() => {});
                }
            }
        }
    }

    // Accurately calculate returnCredit using all approved and returned items
    const totalReturnCredit = updatedOrder.items
        .filter((i) => ["RETURNED", "RETURN_APPROVED"].includes(i.status))
        .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

    updatedOrder.pricing.returnCredit = totalReturnCredit;
    updatedOrder.pricing.currentPayable = Math.max(
        0,
        (updatedOrder.pricing.originalTotalAmount || updatedOrder.pricing.totalAmount) -
            (updatedOrder.pricing.cancellationDeduction || 0) -
            totalReturnCredit
    );

    // Referral reversal policy: only reverse if full return and matches first qualifying order, not unrelated orders
    const remainingActive = updatedOrder.items.filter((i) => !["RETURNED", "RETURN_APPROVED", "CANCELLED"].includes(i.status));
    if (remainingActive.length === 0 && !updatedOrder.referralClawbackApplied) {
        const user = await User.findById(updatedOrder.userId);
        if (user && user.referredBy && !user.referralRewardClawedBack) {
            // Check if this is unrelated: if the referee already had other completed non-returned orders, do not reverse
            const priorCompletedOrders = await Order.countDocuments({
                userId: user._id,
                _id: { $ne: updatedOrder._id },
                orderStatus: { $in: ["DELIVERED", "COMPLETED"] },
            });

            if (priorCompletedOrders === 0) {
                const clawbackRes = await walletService
                    .debitWallet({
                        userId: user.referredBy,
                        amount: 100,
                        reason: "REFERRAL_CLAWBACK",
                        description: `Referral bonus clawback due to full return of Order #${updatedOrder.orderNumber}`,
                        referenceId: `REF_CLAWBACK:${user._id}`,
                    })
                    .catch((err) => {
                        console.error("Clawback error:", err);
                        return { success: false };
                    });

                if (clawbackRes && clawbackRes.success) {
                    user.referralRewardClawedBack = true;
                    await user.save().catch(() => {});
                    updatedOrder.referralClawbackApplied = true;
                    updatedOrder.referralClawbackPending = false;
                } else {
                    updatedOrder.referralClawbackPending = true;
                }
            }
        }
    }

    updatedOrder.orderStatus = calculateOrderStatusFromItems(updatedOrder.items);
    await updatedOrder.save();

    return {
        success: true,
        message: `Return approved for "${item.productName}".${walletCredited ? ` ₹${refundAmount.toFixed(2)} has been refunded to customer's wallet.` : ""}`,
        order: updatedOrder,
    };
};

/**
 * Reject a return request for an item
 * Uses atomic conditional update to prevent conflicting race with approval (Finding 32).
 */
const rejectReturnItem = async (orderId, itemId, adminMessage = "") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const cleanMessage = (adminMessage || "").trim();
    if (!cleanMessage) {
        return { success: false, message: "A non-blank message explaining the rejection to the customer is required." };
    }

    const now = new Date();

    // Finding 32: Atomic conditional transition
    const updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            items: {
                $elemMatch: {
                    _id: itemId,
                    status: "RETURN_REQUESTED",
                },
            },
        },
        {
            $set: {
                "items.$.status": "RETURN_REJECTED",
                "items.$.adminFeedback": cleanMessage,
                "items.$.adminFeedbackAt": now,
            },
        },
        { returnDocument: "after" }
    );

    if (!updatedOrder) {
        const order = await Order.findById(orderId);
        if (!order) return { success: false, message: "Order not found." };
        const item = order.items.id(itemId);
        if (!item) return { success: false, message: "Item not found in order." };
        return {
            success: false,
            message: `Cannot reject return: Item is currently "${item.status.replace(/_/g, " ")}", not "RETURN REQUESTED".`,
        };
    }

    const item = updatedOrder.items.id(itemId);
    updatedOrder.orderStatus = calculateOrderStatusFromItems(updatedOrder.items);
    await updatedOrder.save();

    return {
        success: true,
        message: `Return request rejected for "${item.productName}".`,
        order: updatedOrder,
    };
};

/**
 * Restock an approved return item back into inventory after receipt confirmation.
 * Never sets isRestocked: true before inventory restoration succeeds (Finding 36).
 * Recalculates credits using discounted purchase amounts (Findings 33 & 34).
 */
const restockReturnItem = async (orderId, itemId, adminMessage = "") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const now = new Date();
    const leaseThreshold = new Date(Date.now() - 30000); // 30-second claim lease

    // 1. Atomically claim restock: must be in RETURN_APPROVED status (physical receipt starting)
    const updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            items: {
                $elemMatch: {
                    _id: itemId,
                    status: "RETURN_APPROVED",
                    isRestocked: { $ne: true },
                    $or: [
                        { restockClaimAt: { $exists: false } },
                        { restockClaimAt: null },
                        { restockClaimAt: { $lt: leaseThreshold } },
                    ],
                },
            },
        },
        {
            $set: {
                "items.$.restockClaimAt": now,
            },
        },
        { returnDocument: "after" }
    );

    if (!updatedOrder) {
        const existingOrder = await Order.findById(orderId);
        if (!existingOrder) {
            return { success: false, message: "Order not found." };
        }
        const existingItem = existingOrder.items.id(itemId);
        if (!existingItem) {
            return { success: false, message: "Item not found in order." };
        }
        if (existingItem.isRestocked && existingItem.status === "RETURNED") {
            return { success: false, message: `"${existingItem.productName}" is already restocked into inventory.` };
        }
        if (existingItem.status === "RETURN_REQUESTED") {
            return {
                success: false,
                message: "Cannot restock: Item is merely RETURN_REQUESTED and must be approved before receiving and restocking.",
            };
        }
        return {
            success: false,
            message: `Cannot restock: Item must be in "RETURN_APPROVED" status. Current status: "${existingItem.status}".`,
        };
    }

    // 2. Finding 36: Safely restore physical stock back into inventory FIRST
    const restockedItem = updatedOrder.items.id(itemId);
    await restoreReturnStock(orderId, restockedItem);

    // 3. Mark RETURNED and isRestocked ONLY AFTER physical stock restoration succeeded
    await Order.updateOne(
        {
            _id: orderId,
            "items._id": itemId,
        },
        {
            $set: {
                "items.$.status": "RETURNED",
                "items.$.isRestocked": true,
                "items.$.restockedAt": now,
                "items.$.restockedBy": "ADMIN",
                ...(adminMessage && adminMessage.trim()
                    ? { "items.$.adminFeedback": adminMessage.trim(), "items.$.adminFeedbackAt": now }
                    : {}),
            },
            $unset: {
                "items.$.restockClaimAt": "",
            },
        }
    );

    // 4. Finding 33 & 34: Recalculate order accounting using allocated purchase amounts (finalPayable)
    // preserving all approved and returned items
    const reloadedOrder = await Order.findById(orderId);
    const totalReturnCredit = reloadedOrder.items
        .filter((i) => ["RETURNED", "RETURN_APPROVED"].includes(i.status))
        .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

    reloadedOrder.pricing.returnCredit = totalReturnCredit;
    reloadedOrder.pricing.currentPayable = Math.max(
        0,
        (reloadedOrder.pricing.originalTotalAmount || reloadedOrder.pricing.totalAmount) -
            (reloadedOrder.pricing.cancellationDeduction || 0) -
            totalReturnCredit
    );

    reloadedOrder.orderStatus = calculateOrderStatusFromItems(reloadedOrder.items);
    await reloadedOrder.save();

    return {
        success: true,
        message: `Stock for "${restockedItem.productName}" (+${restockedItem.quantity} units) has been restored to inventory successfully.`,
        order: reloadedOrder,
    };
};

/**
 * Update payment status of an order
 * Protects against fake transitions (Findings 38 & 39).
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

    // Finding 39: Cannot manually mark unpaid online order as COMPLETED without gateway payment ID
    if (normalizedStatus === "COMPLETED" && order.paymentMethod === "ONLINE" && !order.razorpayPaymentId) {
        return {
            success: false,
            message: "Cannot mark online order as COMPLETED without a valid Razorpay payment ID. Use online verification.",
        };
    }

    // Finding 38: Cannot mark payment as REFUNDED if never paid
    if (normalizedStatus === "REFUNDED" && order.paymentStatus !== "COMPLETED") {
        return {
            success: false,
            message: "Cannot mark payment as REFUNDED because payment was not previously completed. Unpaid orders should be marked CANCELLED or FAILED.",
        };
    }

    const now = new Date();
    const updateObj = { status: normalizedStatus };

    if (normalizedStatus === "COMPLETED") {
        order.paymentStatus = "COMPLETED";
        order.paidAt = now;
        updateObj.paidAt = now;
    } else if (normalizedStatus === "REFUNDED") {
        const targetRefundAmt =
            order.pricing.returnCredit > 0 ? order.pricing.returnCredit : order.pricing.totalAmount || 0;

        // Concurrency-safe claim: only one concurrent call can claim from COMPLETED
        const claimedOrder = await Order.findOneAndUpdate(
            {
                _id: orderId,
                paymentStatus: { $in: ["COMPLETED", "PARTIALLY_REFUNDED"] },
                "pricing.walletRefundIssued": { $lt: targetRefundAmt },
            },
            {
                $set: {
                    paymentStatus: "REFUNDED",
                    refundedAt: now,
                    "pricing.refundAmount": targetRefundAmt,
                },
            },
            { returnDocument: "after" }
        );

        if (!claimedOrder) {
            const current = await Order.findById(orderId);
            return {
                success: current?.paymentStatus === "REFUNDED",
                message: current?.paymentStatus === "REFUNDED" ? "Payment status is already REFUNDED." : "Cannot mark payment as REFUNDED.",
                order: current,
            };
        }

        const deltaToRefund = Math.max(0, targetRefundAmt - (claimedOrder.pricing?.walletRefundIssued || 0));
        if (deltaToRefund > 0) {
            const refundRef = `REFUND_MANUAL_${order._id}_FINAL`;
            const credRes = await walletService.creditWallet({
                userId: claimedOrder.userId,
                amount: deltaToRefund,
                reason: "ORDER_REFUND",
                description: `Manual admin refund for Order #${claimedOrder.orderNumber}`,
                orderId: claimedOrder._id,
                orderNumber: claimedOrder.orderNumber,
                referenceId: refundRef,
            });

            if (credRes.success && !credRes.isDuplicate) {
                await Order.updateOne(
                    { _id: orderId },
                    { $inc: { "pricing.walletRefundIssued": deltaToRefund } }
                );
                claimedOrder.pricing.walletRefundIssued = (claimedOrder.pricing.walletRefundIssued || 0) + deltaToRefund;
            }
        }

        await Payment.updateMany(
            { orderId: order._id },
            { $set: { status: "REFUNDED", refundedAt: now, refundAmount: targetRefundAmt } }
        );

        return {
            success: true,
            message: `Payment status updated to "REFUNDED".`,
            order: claimedOrder,
        };
    } else {
        order.paymentStatus = normalizedStatus;
        await order.save();
        await Payment.updateMany({ orderId: order._id }, { $set: updateObj });
        return {
            success: true,
            message: `Payment status updated to "${normalizedStatus}".`,
            order,
        };
    }
};

/**
 * Reconcile and recover order state on standalone MongoDB.
 * Safely resumes interrupted cancellations, returns, refunds, inventory restorations, and clawbacks.
 */
const reconcileOrderState = async (orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID for reconciliation." };
    }

    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: "Order not found." };

    const isPaid = order.paymentStatus === "COMPLETED" || order.paymentStatus === "REFUNDED" || order.paymentMethod === "COD";
    let refundDelta = 0;

    // 1. Repair interrupted item cancellations (stock + wallet)
    for (const item of order.items) {
        if (item.status === "CANCELLED") {
            if (!item.isStockRestored) {
                await restoreCancellationStock(order._id, item).catch(() => {});
                await Order.updateOne(
                    { _id: order._id, "items._id": item._id },
                    { $set: { "items.$.isStockRestored": true, "items.$.restockedQuantity": item.quantity } }
                ).catch(() => {});
                item.isStockRestored = true;
            }

            if (isPaid && order.paymentMethod !== "COD" && !item.refundIssued) {
                const itemRefund = item.finalPayable != null ? item.finalPayable : item.lineTotal;
                const refundRef = `REFUND_CAN_${order._id}_${item._id}`;
                const existingTx = await Transaction.findOne({
                    referenceId: { $in: [refundRef, `REFUND_ADM_CAN_${order._id}_${item._id}`] },
                });
                if (itemRefund > 0 && !existingTx) {
                    const cred = await walletService.creditWallet({
                        userId: order.userId,
                        amount: itemRefund,
                        reason: "ORDER_CANCELLATION",
                        description: `Reconciled cancellation refund for "${item.productName}" in Order #${order.orderNumber}`,
                        orderId: order._id,
                        orderNumber: order.orderNumber,
                        referenceId: refundRef,
                    });
                    if (cred.success && !cred.isDuplicate) {
                        refundDelta += itemRefund;
                    }
                }
                await Order.updateOne(
                    { _id: order._id, "items._id": item._id },
                    { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund } }
                ).catch(() => {});
                item.refundIssued = true;
            }
        } else if (item.status === "RETURNED" && !item.isRestocked) {
            await restoreReturnStock(order._id, item).catch(() => {});
            await Order.updateOne(
                { _id: order._id, "items._id": item._id },
                { $set: { "items.$.isRestocked": true } }
            ).catch(() => {});
            item.isRestocked = true;
        } else if (["RETURN_APPROVED", "RETURNED"].includes(item.status) && isPaid && !item.refundIssued) {
            const itemRefund = item.finalPayable != null ? item.finalPayable : item.lineTotal;
            const refundRef = `REFUND_RET_${order._id}_${item._id}`;
            const existingTx = await Transaction.findOne({ referenceId: refundRef });
            if (itemRefund > 0 && !existingTx) {
                const cred = await walletService.creditWallet({
                    userId: order.userId,
                    amount: itemRefund,
                    reason: "ORDER_RETURN",
                    description: `Reconciled return refund for "${item.productName}" in Order #${order.orderNumber}`,
                    orderId: order._id,
                    orderNumber: order.orderNumber,
                    referenceId: refundRef,
                });
                if (cred.success && !cred.isDuplicate) {
                    refundDelta += itemRefund;
                }
            }
            await Order.updateOne(
                { _id: order._id, "items._id": item._id },
                { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund } }
            ).catch(() => {});
            item.refundIssued = true;
        }
    }

    // 2. Shipping refund for all-cancelled paid orders
    const allCancelled = order.items.every((i) => i.status === "CANCELLED");
    if (allCancelled && isPaid && order.paymentMethod !== "COD" && order.pricing?.shippingFee > 0) {
        const shipRef = `REFUND_CAN_${order._id}_SHIPPING`;
        const shipTx = await Transaction.findOne({
            referenceId: { $in: [shipRef, `REFUND_ADM_CAN_${order._id}_SHIPPING`] },
        });
        if (!shipTx) {
            const cred = await walletService.creditWallet({
                userId: order.userId,
                amount: order.pricing.shippingFee,
                reason: "ORDER_CANCELLATION",
                description: `Reconciled shipping refund for Order #${order.orderNumber}`,
                orderId: order._id,
                orderNumber: order.orderNumber,
                referenceId: shipRef,
            });
            if (cred.success && !cred.isDuplicate) {
                refundDelta += order.pricing.shippingFee;
            }
        }
    }

    // 3. Retry pending referral clawback if recorded
    if (order.referralClawbackPending && !order.referralClawbackApplied) {
        const user = await User.findById(order.userId);
        if (user && user.referredBy && !user.referralRewardClawedBack) {
            const clawRes = await walletService.debitWallet({
                userId: user.referredBy,
                amount: 100,
                reason: "REFERRAL_CLAWBACK",
                description: `Reconciled referral bonus clawback for Order #${order.orderNumber}`,
                referenceId: `REF_CLAWBACK:${user._id}`,
            }).catch(() => null);

            if (clawRes && clawRes.success) {
                user.referralRewardClawedBack = true;
                await user.save().catch(() => {});
                order.referralClawbackApplied = true;
                order.referralClawbackPending = false;
            }
        }
    }

    // 4. Update order accounting
    const totalCancelledDeduction = order.items
        .filter((i) => i.status === "CANCELLED")
        .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);
    const totalReturnCredit = order.items
        .filter((i) => ["RETURNED", "RETURN_APPROVED"].includes(i.status))
        .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

    order.pricing.cancellationDeduction = totalCancelledDeduction;
    order.pricing.returnCredit = totalReturnCredit;
    order.pricing.currentPayable = allCancelled
        ? 0
        : Math.max(
              0,
              (order.pricing.originalTotalAmount || order.pricing.totalAmount) -
                  totalCancelledDeduction -
                  totalReturnCredit
          );

    if (refundDelta > 0) {
        order.pricing.walletRefundIssued = (order.pricing.walletRefundIssued || 0) + refundDelta;
        await Payment.updateMany({ orderId: order._id }, { $inc: { refundAmount: refundDelta } }).catch(() => {});
    }

    order.orderStatus = calculateOrderStatusFromItems(order.items);
    await order.save();

    return { success: true, message: "Order reconciled successfully.", order };
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
    reconcileOrderState,
    VALID_ORDER_STATUSES,
    VALID_PAYMENT_STATUSES,
};
