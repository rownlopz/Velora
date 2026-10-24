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
    let {
        search = "",
        status = "ALL",
        paymentMethod = "ALL",
        paymentStatus = "ALL",
        sort = "date_desc",
        page = 1,
        limit = 10,
    } = options;

    // Normalise casing: handle both lowercase 'all' and uppercase 'ALL', or empty strings
    const cleanStatus = (typeof status === "string" ? status.trim() : "").toUpperCase();
    const cleanPaymentMethod = (typeof paymentMethod === "string" ? paymentMethod.trim() : "").toUpperCase();
    const cleanPaymentStatus = (typeof paymentStatus === "string" ? paymentStatus.trim() : "").toUpperCase();

    const filter = {};

    // Filter orderStatus
    if (cleanStatus && cleanStatus !== "ALL") {
        if (cleanStatus === "ACTIVE") {
            filter.orderStatus = { $in: ["PENDING", "PLACED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"] };
        } else if (cleanStatus === "PENDING" || cleanStatus === "PLACED") {
            // "Pending / Placed" behaves consistently with its label
            filter.orderStatus = { $in: ["PENDING", "PLACED"] };
        } else if (VALID_ORDER_STATUSES.includes(cleanStatus)) {
            filter.orderStatus = cleanStatus;
        }
    }

    if (cleanPaymentMethod && cleanPaymentMethod !== "ALL") {
        if (["COD", "ONLINE", "WALLET"].includes(cleanPaymentMethod)) {
            filter.paymentMethod = cleanPaymentMethod;
        }
    }

    if (cleanPaymentStatus && cleanPaymentStatus !== "ALL") {
        if (VALID_PAYMENT_STATUSES.includes(cleanPaymentStatus)) {
            filter.paymentStatus = cleanPaymentStatus;
        }
    }

    if (typeof search === "string" && search.trim()) {
        const escaped = escapeRegex(search.trim());  // Makes (. , *) As normal search methods
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


    delete countBaseFilter.orderStatus;

    const countsPipeline = [
        ...(Object.keys(countBaseFilter).length > 0 ? [{ $match: countBaseFilter }] : []),
        {
            $group: {
                _id: "$orderStatus",
                count: { $sum: 1 },
            },
        },
    ];
    const statusCountsRaw = await Order.aggregate(countsPipeline);
    const countsMap = { ALL: 0, all: 0 };
    for (const row of statusCountsRaw) {
        countsMap[row._id] = row.count;
        countsMap.ALL += row.count;
        countsMap.all += row.count;
    }
    // "Pending / Placed" KPI card reads countsMap.PENDING: combine PENDING + PLACED
    const pendingCount = (countsMap.PENDING || 0) + (countsMap.PLACED || 0);
    countsMap.PENDING = pendingCount;
    countsMap.PLACED = pendingCount;

    // Stable sort stage with tie-breaker _id
    let sortStage = { placedAt: -1, createdAt: -1, _id: -1 };
    if (sort === "date_asc" || sort === "placedAt_asc") {
        sortStage = { placedAt: 1, createdAt: 1, _id: 1 };
    } else if (sort === "amount_desc" || sort === "totalAmount_desc") {
        sortStage = { "pricing.totalAmount": -1, _id: -1 };
    } else if (sort === "amount_asc" || sort === "totalAmount_asc") {
        sortStage = { "pricing.totalAmount": 1, _id: 1 };
    } else {
        sortStage = { placedAt: -1, createdAt: -1, _id: -1 };
    }

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

        const isPaidOrder = await isCancellationRefundEligible(order);
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
                        "items.$.cancelledBeforePayment": !isPaidOrder,
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
        const currentPayable = isAllCancelled
            ? 0
            : Math.max(
                  0,
                  (latestOrder.pricing.originalTotalAmount || latestOrder.pricing.totalAmount) -
                      totalCancelledDeduction -
                      totalReturnCredit
              );
        latestOrder.pricing.currentPayable = currentPayable;

        let totalRefundCredited = 0;
        let hadRefundFailure = false;
        if (isPaidOrder && (latestOrder.paymentStatus === "COMPLETED" || latestOrder.paymentStatus === "REFUNDED")) {
            for (const item of cancelledSuccessfully) {
                const refundAmount = item.finalPayable != null ? item.finalPayable : item.lineTotal;
                const refundRef = `REFUND_ADM_CAN_${latestOrder._id}_${item._id}`;
                const existingTx = await Transaction.findOne({
                    referenceId: { $in: [refundRef, `REFUND_CAN_${latestOrder._id}_${item._id}`] },
                });
                if (refundAmount > 0 && !item.refundIssued && !existingTx) {
                    const credRes = await walletService.creditWallet({
                        userId: latestOrder.userId,
                        amount: refundAmount,
                        reason: "ORDER_CANCELLATION",
                        description: `Admin cancellation refund for "${item.productName}" in Order #${latestOrder.orderNumber}`,
                        orderId: latestOrder._id,
                        orderNumber: latestOrder.orderNumber,
                        referenceId: refundRef,
                    });
                    if (credRes && credRes.success) {
                        if (!credRes.isDuplicate) {
                            totalRefundCredited += refundAmount;
                        }
                        await Order.updateOne(
                            { _id: orderId, "items._id": item._id },
                            { $set: { "items.$.refundIssued": true, "items.$.refundAmount": refundAmount, "items.$.refundStatus": "COMPLETED" } }
                        ).catch(() => {});
                    } else {
                        hadRefundFailure = true;
                        await Order.updateOne(
                            { _id: orderId, "items._id": item._id },
                            { $set: { "items.$.refundStatus": "REFUND_PENDING", "items.$.refundAmount": refundAmount } }
                        ).catch(() => {});
                    }
                }
            }

            if (isAllCancelled && latestOrder.pricing?.shippingFee > 0) {
                const shipRef = `REFUND_ADM_CAN_${latestOrder._id}_SHIPPING`;
                const existingShipTx = await Transaction.findOne({
                    referenceId: { $in: [shipRef, `REFUND_CAN_${latestOrder._id}_SHIPPING`] },
                });
                if (!existingShipTx) {
                    const shipRes = await walletService.creditWallet({
                        userId: latestOrder.userId,
                        amount: latestOrder.pricing.shippingFee,
                        reason: "ORDER_CANCELLATION",
                        description: `Admin cancellation refund for shipping fee in Order #${latestOrder.orderNumber}`,
                        orderId: latestOrder._id,
                        orderNumber: latestOrder.orderNumber,
                        referenceId: shipRef,
                    });
                    if (shipRes && shipRes.success) {
                        if (!shipRes.isDuplicate) {
                            totalRefundCredited += latestOrder.pricing.shippingFee;
                        }
                        await Order.updateOne(
                            { _id: orderId },
                            { $set: { "pricing.shippingRefundStatus": "COMPLETED" } }
                        ).catch(() => {});
                    } else {
                        hadRefundFailure = true;
                        await Order.updateOne(
                            { _id: orderId },
                            { $set: { "pricing.shippingRefundStatus": "REFUND_PENDING" } }
                        ).catch(() => {});
                    }
                }
            }
        }

        if (totalRefundCredited > 0) {
            latestOrder.pricing.walletRefundIssued =
                (latestOrder.pricing.walletRefundIssued || 0) + totalRefundCredited;
            latestOrder.pricing.purchaseRefundTotal =
                (latestOrder.pricing.purchaseRefundTotal || 0) + totalRefundCredited;
            latestOrder.pricing.refundAmount =
                (latestOrder.pricing.refundAmount || 0) + totalRefundCredited;
        }

        // Accurately derive overall order status
        latestOrder.orderStatus = calculateOrderStatusFromItems(latestOrder.items);

        if (isAllCancelled) {
            latestOrder.cancellationReason = adminNote ? `Admin Cancelled: ${adminNote.trim()}` : "Cancelled by Admin";
            latestOrder.cancelledAt = now;
            latestOrder.cancelledBy = "ADMIN";
            if (latestOrder.paymentMethod === "COD" || !isPaidOrder) {
                latestOrder.paymentStatus = "CANCELLED";
                await Payment.updateMany({ orderId: latestOrder._id }, { $set: { status: "CANCELLED" } });
            } else if (latestOrder.paymentStatus === "COMPLETED" || latestOrder.paymentStatus === "REFUNDED") {
                latestOrder.paymentStatus = "REFUNDED";
            }
        } else {
            if (latestOrder.paymentMethod === "COD") {
                await Payment.updateMany(
                    { orderId: latestOrder._id, status: "PENDING" },
                    { $set: { amount: currentPayable } }
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
        await syncOrderRefundAccounting(latestOrder._id);

        if (isAllCancelled && latestOrder.pricing?.couponId && !latestOrder.pricing?.isCouponReleased) {
            try {
                const { releaseCouponUsage } = require("../admin/couponService");
                await releaseCouponUsage(latestOrder.pricing.couponId, latestOrder.userId, latestOrder.orderNumber);
                await Order.updateOne(
                    { _id: latestOrder._id },
                    { $set: { "pricing.isCouponReleased": true, "pricing.couponReleasedAt": new Date() } }
                );
            } catch (couponErr) {
                console.error("Failed to release coupon on admin cancellation:", couponErr);
            }
        }

        const refreshedLatestOrder = await Order.findById(latestOrder._id);
        if (refreshedLatestOrder) {
            latestOrder.pricing = refreshedLatestOrder.pricing;
            latestOrder.paymentStatus = refreshedLatestOrder.paymentStatus;
            latestOrder.orderStatus = refreshedLatestOrder.orderStatus;
        }
        let message = `Order updated to "${latestOrder.orderStatus.replace(/_/g, " ")}".`;
        if (totalRefundCredited > 0) {
            message += ` ₹${totalRefundCredited.toFixed(2)} refunded to customer's wallet.`;
        }
        if (hadRefundFailure) {
            message += " Some wallet refunds could not be processed and are queued for retry/reconciliation.";
        }
        return {
            success: true,
            message,
            order: latestOrder,
            hadRefundFailure,
        };
    } else {
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
        const isPaidOrder = await isCancellationRefundEligible(order);
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
                        "items.$.cancelledBeforePayment": !isPaidOrder,
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
        if (isPaidOrder && (updatedOrder.paymentStatus === "COMPLETED" || updatedOrder.paymentStatus === "REFUNDED")) {
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
                if (credRes.success) {
                    if (!credRes.isDuplicate) {
                        totalRefundCredited += itemRefund;
                    }
                    await Order.updateOne(
                        { _id: orderId, "items._id": itemId },
                        { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund, "items.$.refundStatus": "COMPLETED" } }
                    ).catch(() => {});
                } else {
                    await Order.updateOne(
                        { _id: orderId, "items._id": itemId },
                        { $set: { "items.$.refundStatus": "REFUND_PENDING", "items.$.refundAmount": itemRefund } }
                    ).catch(() => {});
                }
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
                        await Order.updateOne(
                            { _id: orderId },
                            { $set: { "pricing.shippingRefundStatus": "COMPLETED" } }
                        ).catch(() => {});
                    } else if (!shipRes.success) {
                        await Order.updateOne(
                            { _id: orderId },
                            { $set: { "pricing.shippingRefundStatus": "REFUND_PENDING" } }
                        ).catch(() => {});
                    }
                }
            }
        }

        // Concurrency-safe reload: reload fresh order to ensure totals reflect concurrent actions on other items
        const freshOrder = await Order.findById(orderId);
        const orderForCalc = freshOrder || updatedOrder;

        // Accurate cancellation deduction using allocated purchase amount
        const totalCancelledDeduction = orderForCalc.items
            .filter((i) => i.status === "CANCELLED")
            .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

        const totalReturnCredit = orderForCalc.items
            .filter((i) => ["RETURNED", "RETURN_APPROVED"].includes(i.status))
            .reduce((s, i) => s + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

        const isAllCancelled = orderForCalc.items.every((i) => i.status === "CANCELLED");

        const currentPayable = isAllCancelled
            ? 0
            : Math.max(
                  0,
                  (orderForCalc.pricing.originalTotalAmount || orderForCalc.pricing.totalAmount) -
                      totalCancelledDeduction -
                      totalReturnCredit
              );

        const newOrderStatus = calculateOrderStatusFromItems(orderForCalc.items);

        const wasPaid = updatedOrder.paymentStatus === "COMPLETED" || totalRefundCredited > 0;
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
                      ...(updatedOrder.paymentMethod === "COD" || !wasPaid
                          ? { paymentStatus: "CANCELLED" }
                          : { paymentStatus: "REFUNDED" }),
                  }
                : {}),
        };

        const updateOps = { $set: setFields };
        if (totalRefundCredited > 0) {
            updateOps.$inc = {
                "pricing.walletRefundIssued": totalRefundCredited,
                "pricing.purchaseRefundTotal": totalRefundCredited,
                "pricing.refundAmount": totalRefundCredited,
            };
        }

        await Order.updateOne({ _id: orderId }, updateOps);
        await syncOrderRefundAccounting(orderId);

        if (isAllCancelled && orderForCalc.pricing?.couponId && !orderForCalc.pricing?.isCouponReleased) {
            try {
                const { releaseCouponUsage } = require("../admin/couponService");
                await releaseCouponUsage(orderForCalc.pricing.couponId, orderForCalc.userId, orderForCalc.orderNumber);
                await Order.updateOne(
                    { _id: orderId },
                    { $set: { "pricing.isCouponReleased": true, "pricing.couponReleasedAt": new Date() } }
                );
            } catch (couponErr) {
                console.error("Failed to release coupon on admin item cancellation:", couponErr);
            }
        }

        const finalOrder = await Order.findById(orderId);

        return {
            success: true,
            message: `Product "${cancelledItem.productName}" cancelled successfully.${totalRefundCredited > 0 ? ` ₹${totalRefundCredited.toFixed(2)} refunded to customer's wallet.` : ""}`,
            order: finalOrder,
        };
    } else {
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

    const isPaid = updatedOrder.paymentStatus === "COMPLETED" || updatedOrder.paymentStatus === "REFUNDED" || Boolean(updatedOrder.paidAt) || updatedOrder.paymentMethod === "COD";

    if (isPaid && refundAmount > 0 && !item.refundIssued) {
        const currentRefunded = updatedOrder.pricing.purchaseRefundTotal != null
            ? updatedOrder.pricing.purchaseRefundTotal
            : Math.max(0, (updatedOrder.pricing.walletRefundIssued || 0) - (updatedOrder.pricing.duplicateRefundTotal || 0));
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

            if (credRes && credRes.success) {
                item.refundIssued = true;
                item.refundAmount = actualRefund;
                item.refundStatus = "COMPLETED";
                await Order.updateOne(
                    { _id: orderId, "items._id": itemId },
                    {
                        $set: { "items.$.refundIssued": true, "items.$.refundAmount": actualRefund, "items.$.refundStatus": "COMPLETED" },
                        $inc: {
                            "pricing.walletRefundIssued": actualRefund,
                            "pricing.purchaseRefundTotal": actualRefund,
                            "pricing.refundAmount": actualRefund,
                        },
                    }
                ).catch(() => {});

                if (!credRes.isDuplicate) {
                    updatedOrder.pricing.walletRefundIssued = (updatedOrder.pricing.walletRefundIssued || 0) + actualRefund;
                    updatedOrder.pricing.purchaseRefundTotal = (updatedOrder.pricing.purchaseRefundTotal || 0) + actualRefund;
                    walletCredited = true;
                    await Payment.updateMany(
                        {
                            orderId: updatedOrder._id,
                            $or: [
                                { razorpayPaymentId: updatedOrder.razorpayPaymentId },
                                { razorpayPaymentId: { $in: [null, ""] } },
                            ],
                        },
                        { $inc: { refundAmount: actualRefund } }
                    ).catch(() => {});
                }
            } else {
                item.refundStatus = "REFUND_PENDING";
                item.refundAmount = actualRefund;
                await Order.updateOne(
                    { _id: orderId, "items._id": itemId },
                    {
                        $set: { "items.$.refundStatus": "REFUND_PENDING", "items.$.refundAmount": actualRefund },
                    }
                ).catch(() => {});

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
                updatedOrder.orderStatus = calculateOrderStatusFromItems(updatedOrder.items);
                await updatedOrder.save();

                return {
                    success: false,
                    message: `Return approved, but wallet credit failed: ${credRes?.message || "Wallet service error"}. Refund obligation preserved for retry.`,
                    order: updatedOrder,
                };
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

    // Documented referral policy rewards signup & email verification; order returns do not claw back signup rewards.

    updatedOrder.orderStatus = calculateOrderStatusFromItems(updatedOrder.items);
    await updatedOrder.save();

    return {
        success: true,
        message: `Return approved for "${item.productName}".${walletCredited ? ` ₹${refundAmount.toFixed(2)} has been refunded to customer's wallet.` : ""}`,
        order: updatedOrder,
    };
};

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

    // Cannot manually mark unpaid online order as COMPLETED without gateway payment ID
    if (normalizedStatus === "COMPLETED" && order.paymentMethod === "ONLINE" && !order.razorpayPaymentId) {
        return {
            success: false,
            message: "Cannot mark online order as COMPLETED without a valid Razorpay payment ID. Use online verification.",
        };
    }

    // Cannot mark payment as REFUNDED if never paid
    if (normalizedStatus === "REFUNDED" && order.paymentStatus !== "COMPLETED" && order.paymentStatus !== "PARTIALLY_REFUNDED") {
        return {
            success: false,
            message: "Cannot mark payment as REFUNDED because payment was not previously completed. Unpaid orders should be marked CANCELLED or FAILED.",
        };
    }

    const now = new Date();
    const updateObj = { status: normalizedStatus };

    if (normalizedStatus === "COMPLETED") {
        order.paymentStatus = "COMPLETED";
        order.paidAt = order.paidAt || now;
        updateObj.paidAt = order.paidAt;
        await order.save();
        await Payment.updateMany({ orderId: order._id }, { $set: { status: "COMPLETED", paidAt: order.paidAt } });
        return {
            success: true,
            message: `Payment status updated to "COMPLETED".`,
            order,
        };
    } else if (normalizedStatus === "REFUNDED") {
        const targetRefundAmt =
            order.pricing.returnCredit > 0 ? order.pricing.returnCredit : order.pricing.totalAmount || 0;

        const currentRefundIssued = order.pricing?.purchaseRefundTotal != null
            ? order.pricing.purchaseRefundTotal
            : Math.max(0, (order.pricing?.walletRefundIssued || 0) - (order.pricing?.duplicateRefundTotal || 0));
        const deltaToRefund = Math.max(0, targetRefundAmt - currentRefundIssued);

        if (deltaToRefund > 0) {
            const refundRef = `REFUND_MANUAL_${order._id}_FINAL`;
            const credRes = await walletService.creditWallet({
                userId: order.userId,
                amount: deltaToRefund,
                reason: "ORDER_REFUND",
                description: `Manual admin refund for Order #${order.orderNumber}`,
                orderId: order._id,
                orderNumber: order.orderNumber,
                referenceId: refundRef,
            });

            if (!credRes.success) {
                return {
                    success: false,
                    message: credRes.message || "Failed to credit wallet for manual refund.",
                    order,
                };
            }
        }

        // Set REFUNDED ONLY AFTER wallet credit has successfully succeeded
        order.paymentStatus = "REFUNDED";
        order.refundedAt = now;
        order.pricing.refundAmount = targetRefundAmt;
        if (deltaToRefund > 0) {
            order.pricing.purchaseRefundTotal = (order.pricing.purchaseRefundTotal || 0) + deltaToRefund;
            order.pricing.walletRefundIssued = (order.pricing.walletRefundIssued || 0) + deltaToRefund;
        }
        await order.save();

        await Payment.updateMany(
            {
                orderId: order._id,
                $or: [
                    { razorpayPaymentId: order.razorpayPaymentId },
                    { razorpayPaymentId: { $in: [null, ""] } },
                ],
            },
            { $set: { status: "REFUNDED", refundedAt: now, refundAmount: targetRefundAmt } }
        );

        return {
            success: true,
            message: `Payment status updated to "REFUNDED".`,
            order,
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

const getVerifiedCollectedAmount = async (order) => {
    const method = (order.paymentMethod || "").toUpperCase();

    if (method === "COD") {
        // COD collects cash on delivery. Cancellations occur prior to delivery/collection,
        // so no cash was ever collected for cancelled items.
        // For completed delivery, only delivered/returned items were paid for.
        const isDeliveredOrCompleted =
            order.paymentStatus === "COMPLETED" || order.orderStatus === "DELIVERED";
        if (!isDeliveredOrCompleted) {
            return { collectedAmount: 0, isAmbiguous: false, ambiguousReason: "" };
        }
        const deliveredPayable = (order.items || [])
            .filter((i) => i.status !== "CANCELLED")
            .reduce((sum, i) => sum + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0) +
            (order.pricing?.shippingFee || 0);
        return { collectedAmount: deliveredPayable, isAmbiguous: false, ambiguousReason: "" };
    }

    if (method === "WALLET") {
        // Verify actual successful debit transactions from the wallet ledger
        const debitTxs = await Transaction.find({
            orderId: order._id,
            type: "DEBIT",
            reason: { $in: ["ORDER_PURCHASE", "ORDER_PAYMENT"] },
        });
        const totalDebited = debitTxs.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

        if (totalDebited > 0) {
            return { collectedAmount: totalDebited, isAmbiguous: false, ambiguousReason: "" };
        }

        // If order claims to be COMPLETED or has paidAt, but no debit transaction exists: ambiguous!
        if (order.paymentStatus === "COMPLETED" || order.paymentStatus === "REFUNDED" || Boolean(order.paidAt)) {
            return {
                collectedAmount: 0,
                isAmbiguous: true,
                ambiguousReason: `Wallet payment ambiguous: Order #${order.orderNumber} is marked ${order.paymentStatus} with paidAt=${order.paidAt}, but no wallet debit transaction was found in ledger.`,
            };
        }

        return { collectedAmount: 0, isAmbiguous: false, ambiguousReason: "" };
    }

    if (method === "ONLINE") {
        // 1. Explicitly verified pricing.collectedAmount
        if (order.pricing?.collectedAmount != null && order.pricing.collectedAmount > 0) {
            return { collectedAmount: order.pricing.collectedAmount, isAmbiguous: false, ambiguousReason: "" };
        }

        // 2. Successful payment attempts
        const successfulAttempts = (order.paymentAttempts || []).filter(
            (a) => a.status === "SUCCESS" && a.amount > 0
        );
        if (successfulAttempts.length > 0) {
            const capturedSum = successfulAttempts.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
            return { collectedAmount: capturedSum, isAmbiguous: false, ambiguousReason: "" };
        }

        // 3. Completed Payment document
        const completedPayment = await Payment.findOne({
            orderId: order._id,
            status: { $in: ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"] },
            amount: { $gt: 0 },
        });
        if (completedPayment && completedPayment.amount > 0) {
            return { collectedAmount: completedPayment.amount, isAmbiguous: false, ambiguousReason: "" };
        }

        const isPaidStatus =
            order.paymentStatus === "COMPLETED" || order.paymentStatus === "REFUNDED" || Boolean(order.paidAt);
        if (!isPaidStatus) {
            return { collectedAmount: 0, isAmbiguous: false, ambiguousReason: "" };
        }

        // 4. Payment document with positive amount on a paid order
        const anyPayment = await Payment.findOne({ orderId: order._id, amount: { $gt: 0 } });
        if (anyPayment && anyPayment.amount > 0) {
            return { collectedAmount: anyPayment.amount, isAmbiguous: false, ambiguousReason: "" };
        }

        // 5. For orders marked COMPLETED/REFUNDED in database where payment document is omitted (e.g. legacy/mock records),
        // fallback to currentPayable or totalAmount
        if (order.paymentStatus === "COMPLETED" || order.paymentStatus === "REFUNDED") {
            const fallbackAmount =
                order.pricing?.currentPayable != null && order.pricing.currentPayable > 0
                    ? order.pricing.currentPayable
                    : order.pricing?.totalAmount || 0;
            if (fallbackAmount > 0) {
                return { collectedAmount: fallbackAmount, isAmbiguous: false, ambiguousReason: "" };
            }
        }

        return {
            collectedAmount: 0,
            isAmbiguous: true,
            ambiguousReason: `Online payment verification ambiguous: Order #${order.orderNumber} is marked ${order.paymentStatus} with paidAt=${order.paidAt}, but no verified payment attempt or payment record was found.`,
        };
    }

    return { collectedAmount: 0, isAmbiguous: false, ambiguousReason: "" };
};

const isItemCancelledBeforePayment = (order, item) => {
    if (item.cancelledBeforePayment === true) return true;
    if (order.paymentMethod === "COD") {
        // COD cancellation is ALWAYS pre-collection because payment occurs on delivery
        return true;
    }

    const isOrderPaid =
        order.paymentStatus === "COMPLETED" || order.paymentStatus === "REFUNDED" || Boolean(order.paidAt);
    if (!isOrderPaid) return true;

    if (item.cancelledAt && order.paidAt) {
        const cancelTime = new Date(item.cancelledAt).getTime();
        const paidTime = new Date(order.paidAt).getTime();
        if (cancelTime < paidTime) return true;
    }

    return false;
};

const classifyRefundTransaction = (tx, { primaryPaymentId, duplicatePaymentIds, itemIds }) => {
    const reason = (tx.reason || "").toUpperCase();
    const refId = tx.referenceId || "";
    const desc = tx.description || "";

    // 1. Exclude unrelated non-refund transactions
    const UNRELATED_REASONS = [
        "REFERRAL_REWARD",
        "REFERRAL_CLAWBACK",
        "ADMIN_ADJUSTMENT",
        "BONUS",
        "ORDER_PURCHASE_ROLLBACK",
        "ORDER_PAYMENT",
        "ORDER_PURCHASE",
    ];
    if (UNRELATED_REASONS.includes(reason) || tx.type !== "CREDIT") {
        return { type: "UNRELATED" };
    }

    // 2. Check for DUPLICATE refund indicators
    const hasDuplicateReason = reason === "DUPLICATE_PAYMENT";
    const hasDuplicateRefPrefix = Boolean(
        refId && (/^REFUND_DUP_/i.test(refId) || /_DUP_/i.test(refId) || /^DUP_/i.test(refId))
    );
    const hasDuplicateInDesc = Boolean(desc && /duplicate/i.test(desc));
    const hasDuplicatePaymentId = Array.from(duplicatePaymentIds).some(
        (dupId) => (refId && refId.includes(dupId)) || (desc && desc.includes(dupId))
    );

    if (hasDuplicateReason || hasDuplicateRefPrefix || hasDuplicateInDesc || hasDuplicatePaymentId) {
        return { type: "DUPLICATE" };
    }

    // 3. Check for PURCHASE refund indicators
    const hasPurchaseReason = ["ORDER_CANCELLATION", "CANCELLATION_REFUND", "ORDER_RETURN", "RETURN_REFUND"].includes(reason);
    const hasPurchaseRefPrefix = Boolean(
        refId && (/^REFUND_(?:CAN|ADM_CAN|RET|EXCESS|MANUAL|LATE)/i.test(refId) || /SHIPPING/i.test(refId))
    );
    const hasPurchaseInDesc = Boolean(desc && /(cancellation|cancelled|return|returned|restock|shipping fee|late payment)/i.test(desc));
    const hasItemId = itemIds.some((id) => refId && refId.includes(id));
    const hasPrimaryPaymentId = Boolean(
        primaryPaymentId && ((refId && refId.includes(primaryPaymentId)) || (desc && desc.includes(primaryPaymentId)))
    );

    if (hasPurchaseReason || hasPurchaseRefPrefix || hasPurchaseInDesc || hasItemId || (hasPrimaryPaymentId && !hasDuplicateRefPrefix)) {
        return { type: "PURCHASE" };
    }

    // 4. Ambiguous check: If reason is ORDER_REFUND (or other refund reason) with unclear metadata
    return { type: "AMBIGUOUS" };
};

const isCancellationRefundEligible = async (order) => {
    if (!order) return false;
    const method = (order.paymentMethod || "COD").toUpperCase();

    // 1. COD cancellation is NEVER eligible for refund prior to collection (payment occurs on delivery)
    if (method === "COD") {
        return false;
    }

    // 2. WALLET orders: confirm verified successful debit transaction from ledger
    if (method === "WALLET") {
        const debitTx = await Transaction.findOne({
            orderId: order._id,
            type: "DEBIT",
            reason: { $in: ["ORDER_PURCHASE", "ORDER_PAYMENT"] },
        });
        return Boolean(debitTx && Number(debitTx.amount) > 0);
    }

    // 3. ONLINE orders: verify payment was captured / completed
    if (method === "ONLINE") {
        const isPaid = order.paymentStatus === "COMPLETED" || order.paymentStatus === "REFUNDED" || Boolean(order.paidAt);
        if (!isPaid && (!order.pricing?.collectedAmount || order.pricing.collectedAmount <= 0)) {
            return false;
        }
        return true;
    }

    return false;
};

const syncOrderRefundAccounting = async (orderIdOrDoc) => {
    const order = typeof orderIdOrDoc === "object" && orderIdOrDoc._id
        ? orderIdOrDoc
        : await Order.findById(orderIdOrDoc);
    if (!order) return null;

    let primaryPaymentId = order.razorpayPaymentId || null;
    if (!primaryPaymentId) {
        const completedPayment = await Payment.findOne({
            orderId: order._id,
            status: "COMPLETED",
            razorpayPaymentId: { $ne: null },
        });
        if (completedPayment && completedPayment.razorpayPaymentId) {
            primaryPaymentId = completedPayment.razorpayPaymentId;
        }
    }
    if (!primaryPaymentId && (order.paymentAttempts || []).length > 0) {
        const firstSuccessAtt = order.paymentAttempts.find(
            (att) => att.status === "SUCCESS" && att.razorpayPaymentId
        );
        if (firstSuccessAtt) {
            primaryPaymentId = firstSuccessAtt.razorpayPaymentId;
        }
    }

    const duplicatePaymentIds = new Set();
    for (const att of order.paymentAttempts || []) {
        if (!att.razorpayPaymentId) continue;
        if (att.status === "REFUNDED_DUPLICATE" || att.status === "REFUND_PENDING") {
            duplicatePaymentIds.add(att.razorpayPaymentId);
        } else if (primaryPaymentId && att.razorpayPaymentId !== primaryPaymentId && (att.status === "SUCCESS" || att.status === "CAPTURED")) {
            duplicatePaymentIds.add(att.razorpayPaymentId);
        }
    }

    const initialPayments = await Payment.find({ orderId: order._id });
    for (const p of initialPayments) {
        if (p.razorpayPaymentId && primaryPaymentId && p.razorpayPaymentId !== primaryPaymentId) {
            duplicatePaymentIds.add(p.razorpayPaymentId);
        }
    }

    const itemIds = (order.items || []).map((i) => i._id.toString());

    const allRefundTxs = await Transaction.find({
        type: "CREDIT",
        $or: [{ orderId: order._id }, { orderNumber: order.orderNumber }],
    });

    let totalPurchaseRefunds = 0;
    let totalDuplicateRefunds = 0;
    const ambiguousErrors = [];
    const seenTxIds = new Set();

    if (allRefundTxs.length > 0) {
        for (const tx of allRefundTxs) {
            if (seenTxIds.has(tx._id.toString())) continue;
            seenTxIds.add(tx._id.toString());

            const cls = classifyRefundTransaction(tx, { primaryPaymentId, duplicatePaymentIds, itemIds });
            if (cls.type === "PURCHASE") {
                totalPurchaseRefunds += Number(tx.amount) || 0;
            } else if (cls.type === "DUPLICATE") {
                totalDuplicateRefunds += Number(tx.amount) || 0;
            } else if (cls.type === "AMBIGUOUS") {
                ambiguousErrors.push(
                    `Ambiguous refund transaction ${tx._id} (amount: ₹${tx.amount}, reason: "${tx.reason}", referenceId: "${tx.referenceId || "none"}", description: "${tx.description || ""}"): cannot be unambiguously classified as a purchase refund or duplicate refund.`
                );
            }
        }
    } else {
        totalPurchaseRefunds = order.pricing?.purchaseRefundTotal || 0;
        totalDuplicateRefunds = order.pricing?.duplicateRefundTotal || 0;
    }

    const allCancelled = (order.items || []).every((i) => i.status === "CANCELLED");

    if (!order.pricing) {
        order.pricing = {};
    }
    order.pricing.purchaseRefundTotal = totalPurchaseRefunds;
    order.pricing.duplicateRefundTotal = totalDuplicateRefunds;
    order.pricing.walletRefundIssued = totalPurchaseRefunds + totalDuplicateRefunds;
    order.pricing.refundAmount = totalPurchaseRefunds;
    order.refundAmount = totalPurchaseRefunds;

    if (allCancelled && totalPurchaseRefunds > 0) {
        order.paymentStatus = "REFUNDED";
        order.orderStatus = "CANCELLED";
    }

    await Order.updateOne(
        { _id: order._id },
        {
            $set: {
                "pricing.purchaseRefundTotal": totalPurchaseRefunds,
                "pricing.duplicateRefundTotal": totalDuplicateRefunds,
                "pricing.walletRefundIssued": totalPurchaseRefunds + totalDuplicateRefunds,
                "pricing.refundAmount": totalPurchaseRefunds,
                ...(allCancelled && totalPurchaseRefunds > 0 ? { paymentStatus: "REFUNDED", orderStatus: "CANCELLED" } : {}),
            },
        }
    );

    // Update Payment documents according to their actual meaning and associated payment
    const finalPayments = await Payment.find({ orderId: order._id });
    const now = new Date();
    for (const payment of finalPayments) {
        const isDuplicatePayment =
            (payment.razorpayPaymentId && duplicatePaymentIds.has(payment.razorpayPaymentId)) ||
            (payment.attemptId && Array.from(duplicatePaymentIds).includes(payment.attemptId));

        if (isDuplicatePayment) {
            const paymentRefund = Math.min(payment.amount, totalDuplicateRefunds);
            const isFullyRefunded = paymentRefund >= payment.amount && payment.amount > 0;
            await Payment.updateOne(
                { _id: payment._id },
                {
                    $set: {
                        refundAmount: paymentRefund,
                        ...(isFullyRefunded ? { status: "REFUNDED", refundedAt: payment.refundedAt || now } : {}),
                    },
                }
            ).catch(() => {});
        } else {
            const purchasePaymentRefund = Math.min(payment.amount, totalPurchaseRefunds);
            const isFullyRefunded = (allCancelled && totalPurchaseRefunds > 0) || (purchasePaymentRefund >= payment.amount && payment.amount > 0);
            await Payment.updateOne(
                { _id: payment._id },
                {
                    $set: {
                        refundAmount: purchasePaymentRefund,
                        ...(isFullyRefunded ? { status: "REFUNDED", refundedAt: payment.refundedAt || now } : {}),
                    },
                }
            ).catch(() => {});
        }
    }

    return { order, totalPurchaseRefunds, totalDuplicateRefunds, ambiguousErrors };
};

const reconcileOrderState = async (orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID for reconciliation." };
    }

    const order = await Order.findById(orderId);
    if (!order) return { success: false, message: "Order not found." };

    let refundDelta = 0;
    const unresolvedOps = [];

    // Verify actual collected amount
    const { collectedAmount: verifiedCollected, isAmbiguous, ambiguousReason } =
        await getVerifiedCollectedAmount(order);

    if (isAmbiguous) {
        unresolvedOps.push(ambiguousReason);
    }

    let primaryPaymentId = order.razorpayPaymentId || null;
    if (!primaryPaymentId) {
        const completedPayment = await Payment.findOne({
            orderId: order._id,
            status: "COMPLETED",
            razorpayPaymentId: { $ne: null },
        });
        if (completedPayment && completedPayment.razorpayPaymentId) {
            primaryPaymentId = completedPayment.razorpayPaymentId;
        }
    }
    if (!primaryPaymentId && (order.paymentAttempts || []).length > 0) {
        const firstSuccessAtt = order.paymentAttempts.find(
            (att) => att.status === "SUCCESS" && att.razorpayPaymentId
        );
        if (firstSuccessAtt) {
            primaryPaymentId = firstSuccessAtt.razorpayPaymentId;
        }
    }

    const duplicatePaymentIds = new Set();
    let primaryAttemptSeen = false;

    for (const att of order.paymentAttempts || []) {
        if (!att.razorpayPaymentId) continue;
        if (att.status === "REFUNDED_DUPLICATE" || att.status === "REFUND_PENDING") {
            duplicatePaymentIds.add(att.razorpayPaymentId);
        } else if (primaryPaymentId && att.razorpayPaymentId === primaryPaymentId) {
            primaryAttemptSeen = true;
        } else if (att.status === "SUCCESS" || att.status === "CAPTURED") {
            if (primaryAttemptSeen || primaryPaymentId) {
                duplicatePaymentIds.add(att.razorpayPaymentId);
            } else {
                primaryPaymentId = att.razorpayPaymentId;
                primaryAttemptSeen = true;
            }
        }
    }

    const initialPayments = await Payment.find({ orderId: order._id });
    for (const p of initialPayments) {
        if (p.razorpayPaymentId && primaryPaymentId && p.razorpayPaymentId !== primaryPaymentId) {
            duplicatePaymentIds.add(p.razorpayPaymentId);
        }
    }
    const itemIds = (order.items || []).map((i) => i._id.toString());

    // Step A: Stock restorations (must run regardless of payment or refund status)
    for (const item of order.items) {
        if (item.status === "CANCELLED" && !item.isStockRestored) {
            try {
                await restoreCancellationStock(order._id, item);
                await Order.updateOne(
                    { _id: order._id, "items._id": item._id },
                    { $set: { "items.$.isStockRestored": true, "items.$.restockedQuantity": item.quantity } }
                );
                item.isStockRestored = true;
            } catch (stockErr) {
                console.error(`Reconcile stock restoration error on item ${item._id}:`, stockErr);
                unresolvedOps.push(`Stock restoration failed for cancelled item ${item._id}: ${stockErr.message}`);
            }
        }

        if (item.status === "RETURNED" && !item.isRestocked) {
            try {
                await restoreReturnStock(order._id, item);
                await Order.updateOne(
                    { _id: order._id, "items._id": item._id },
                    { $set: { "items.$.isRestocked": true } }
                );
                item.isRestocked = true;
            } catch (restockErr) {
                console.error(`Reconcile return stock restoration error on item ${item._id}:`, restockErr);
                unresolvedOps.push(`Stock restoration failed for returned item ${item._id}: ${restockErr.message}`);
            }
        }
    }

    const existingRefundTxs = await Transaction.find({
        type: "CREDIT",
        $or: [{ orderId: order._id }, { orderNumber: order.orderNumber }],
    });

    let priorPurchaseRefunds = 0;
    let priorDuplicateRefunds = 0;

    for (const tx of existingRefundTxs) {
        const cls = classifyRefundTransaction(tx, { primaryPaymentId, duplicatePaymentIds, itemIds });
        if (cls.type === "PURCHASE") {
            priorPurchaseRefunds += Number(tx.amount) || 0;
        } else if (cls.type === "DUPLICATE") {
            priorDuplicateRefunds += Number(tx.amount) || 0;
        } else if (cls.type === "AMBIGUOUS") {
            unresolvedOps.push(
                `Ambiguous refund transaction ${tx._id} (amount: ₹${tx.amount}, reason: "${tx.reason}", referenceId: "${tx.referenceId || "none"}", description: "${tx.description || ""}"): cannot be unambiguously classified as a purchase refund or duplicate refund.`
            );
        }
    }

    // Active merchandise payable (items that are NOT cancelled or returned)
    const activeItemsPayable = (order.items || [])
        .filter((i) => !["CANCELLED", "RETURNED", "RETURN_APPROVED"].includes(i.status))
        .reduce((sum, i) => sum + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

    // Capped purchase collection excludes duplicate collections and cannot exceed order's total amount
    const maxPurchaseAmount = order.pricing?.originalTotalAmount || order.pricing?.totalAmount || 0;
    const purchaseCollectedAmount = Math.min(
        maxPurchaseAmount,
        Math.max(0, verifiedCollected - priorDuplicateRefunds)
    );

    // Available purchase refund pool
    let purchaseRefundPool = isAmbiguous
        ? 0
        : Math.max(0, purchaseCollectedAmount - activeItemsPayable - priorPurchaseRefunds);

    // Step C: Repair interrupted item cancellations & returns refunds
    for (const item of order.items) {
        // CANCELLATION REFUND
        if (item.status === "CANCELLED") {
            const isPrePayment = isItemCancelledBeforePayment(order, item);
            const itemPayable = item.finalPayable != null ? item.finalPayable : item.lineTotal;
            const refundRef = `REFUND_CAN_${order._id}_${item._id}`;
            const existingTx = existingRefundTxs.find(
                (tx) => tx.referenceId === refundRef || tx.referenceId === `REFUND_ADM_CAN_${order._id}_${item._id}`
            );

            if (existingTx) {
                if (!item.refundIssued || item.refundStatus !== "COMPLETED") {
                    await Order.updateOne(
                        { _id: order._id, "items._id": item._id },
                        { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemPayable, "items.$.refundStatus": "COMPLETED" } }
                    );
                    item.refundIssued = true;
                    item.refundStatus = "COMPLETED";
                }
            } else if (!isPrePayment && !item.refundIssued && itemPayable > 0 && order.paymentMethod !== "COD") {
                // Post-payment cancellation with no refund issued yet
                if (isAmbiguous) {
                    unresolvedOps.push(
                        `Cannot issue refund for item ${item._id}: payment collection status is ambiguous.`
                    );
                } else if (purchaseRefundPool >= itemPayable) {
                    const cred = await walletService.creditWallet({
                        userId: order.userId,
                        amount: itemPayable,
                        reason: "ORDER_CANCELLATION",
                        description: `Reconciled cancellation refund for "${item.productName}" in Order #${order.orderNumber}`,
                        orderId: order._id,
                        orderNumber: order.orderNumber,
                        referenceId: refundRef,
                    });
                    if (cred && cred.success) {
                        if (!cred.isDuplicate) {
                            refundDelta += itemPayable;
                            purchaseRefundPool = Math.max(0, purchaseRefundPool - itemPayable);
                        }
                        await Order.updateOne(
                            { _id: order._id, "items._id": item._id },
                            { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemPayable, "items.$.refundStatus": "COMPLETED" } }
                        );
                        item.refundIssued = true;
                        item.refundStatus = "COMPLETED";
                    } else {
                        await Order.updateOne(
                            { _id: order._id, "items._id": item._id },
                            { $set: { "items.$.refundStatus": "REFUND_PENDING", "items.$.refundAmount": itemPayable } }
                        ).catch(() => {});
                        item.refundStatus = "REFUND_PENDING";
                        unresolvedOps.push(
                            `Wallet credit failed for cancelled item ${item._id}: ${cred?.message || "Unknown error"}`
                        );
                    }
                } else {
                    unresolvedOps.push(
                        `Insufficient verified collected funds to refund cancelled item ${item._id} (available pool: ₹${purchaseRefundPool}, required: ₹${itemPayable}).`
                    );
                }
            }
        }

        // RETURN REFUND
        if (["RETURN_APPROVED", "RETURNED"].includes(item.status)) {
            const itemRefund = item.finalPayable != null ? item.finalPayable : item.lineTotal;
            const refundRef = `REFUND_RET_${order._id}_${item._id}`;
            const existingTx = existingRefundTxs.find((tx) => tx.referenceId === refundRef);

            if (existingTx) {
                if (!item.refundIssued || item.refundStatus !== "COMPLETED") {
                    await Order.updateOne(
                        { _id: order._id, "items._id": item._id },
                        { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund, "items.$.refundStatus": "COMPLETED" } }
                    );
                    item.refundIssued = true;
                    item.refundStatus = "COMPLETED";
                }
            } else if (!item.refundIssued && itemRefund > 0) {
                // Return refund is only valid if money was actually collected for delivered goods
                const canRefundReturn = !isAmbiguous && (
                    (order.paymentMethod === "COD" && (order.paymentStatus === "COMPLETED" || order.orderStatus === "DELIVERED")) ||
                    (order.paymentMethod !== "COD" && purchaseRefundPool >= itemRefund)
                );

                if (canRefundReturn) {
                    const cred = await walletService.creditWallet({
                        userId: order.userId,
                        amount: itemRefund,
                        reason: "ORDER_RETURN",
                        description: `Reconciled return refund for "${item.productName}" in Order #${order.orderNumber}`,
                        orderId: order._id,
                        orderNumber: order.orderNumber,
                        referenceId: refundRef,
                    });
                    if (cred && cred.success) {
                        if (!cred.isDuplicate) {
                            refundDelta += itemRefund;
                            if (order.paymentMethod !== "COD") {
                                purchaseRefundPool = Math.max(0, purchaseRefundPool - itemRefund);
                            }
                        }
                        await Order.updateOne(
                            { _id: order._id, "items._id": item._id },
                            { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund, "items.$.refundStatus": "COMPLETED" } }
                        );
                        item.refundIssued = true;
                        item.refundStatus = "COMPLETED";
                    } else {
                        await Order.updateOne(
                            { _id: order._id, "items._id": item._id },
                            { $set: { "items.$.refundStatus": "REFUND_PENDING", "items.$.refundAmount": itemRefund } }
                        ).catch(() => {});
                        item.refundStatus = "REFUND_PENDING";
                        unresolvedOps.push(
                            `Wallet credit failed for returned item ${item._id}: ${cred?.message || "Unknown error"}`
                        );
                    }
                } else if (!isAmbiguous) {
                    unresolvedOps.push(
                        `Insufficient verified collected funds to refund returned item ${item._id} (available pool: ₹${purchaseRefundPool}, required: ₹${itemRefund}).`
                    );
                }
            }
        }
    }

    // Step C.2: Recover interrupted duplicate and late payment refunds
    const pendingPaymentAttempts = (order.paymentAttempts || []).filter(
        (att) =>
            att.amount > 0 &&
            att.razorpayPaymentId &&
            (att.status === "REFUND_PENDING" || att.status === "SUCCESS" || att.status === "CAPTURED")
    );

    for (const att of pendingPaymentAttempts) {
        const isDuplicateAttempt =
            duplicatePaymentIds.has(att.razorpayPaymentId) ||
            (primaryPaymentId && att.razorpayPaymentId !== primaryPaymentId);

        const allItemsCancelledBeforePayment =
            (order.items || []).length > 0 &&
            (order.items || []).every((i) => i.status === "CANCELLED" && isItemCancelledBeforePayment(order, i));

        const isLatePaymentAttempt =
            !isDuplicateAttempt &&
            att.razorpayPaymentId === primaryPaymentId &&
            (att.status === "REFUND_PENDING" || allItemsCancelledBeforePayment) &&
            (order.orderStatus === "CANCELLED" || order.orderStatus === "EXPIRED" || allItemsCancelledBeforePayment);

        if (isDuplicateAttempt) {
            const dupRef = `REFUND_DUP_${order._id}_${att.razorpayPaymentId}`;
            const existingTx = existingRefundTxs.find(
                (tx) =>
                    tx.referenceId === dupRef ||
                    (tx.referenceId && tx.referenceId.includes(att.razorpayPaymentId)) ||
                    (tx.description && tx.description.includes(att.razorpayPaymentId))
            );

            if (existingTx) {
                if (att.status !== "REFUNDED_DUPLICATE") {
                    await Order.updateOne(
                        { _id: order._id, "paymentAttempts._id": att._id },
                        { $set: { "paymentAttempts.$.status": "REFUNDED_DUPLICATE" } }
                    );
                    att.status = "REFUNDED_DUPLICATE";
                }
            } else {
                const cred = await walletService.creditWallet({
                    userId: order.userId,
                    amount: att.amount,
                    reason: "DUPLICATE_PAYMENT",
                    description: `Reconciled duplicate payment refund for payment ${att.razorpayPaymentId} in Order #${order.orderNumber}`,
                    orderId: order._id,
                    orderNumber: order.orderNumber,
                    referenceId: dupRef,
                });

                if (cred && cred.success) {
                    await Order.updateOne(
                        { _id: order._id, "paymentAttempts._id": att._id },
                        { $set: { "paymentAttempts.$.status": "REFUNDED_DUPLICATE" } }
                    );
                    att.status = "REFUNDED_DUPLICATE";
                    duplicatePaymentIds.add(att.razorpayPaymentId);
                } else {
                    await Order.updateOne(
                        { _id: order._id, "paymentAttempts._id": att._id },
                        { $set: { "paymentAttempts.$.status": "REFUND_PENDING", "paymentAttempts.$.errorReason": cred?.message || "Wallet credit failed" } }
                    ).catch(() => {});
                    unresolvedOps.push(
                        `Failed to recover duplicate payment refund for ${att.razorpayPaymentId}: ${cred?.message || "Wallet credit failed"}`
                    );
                }
            }
        } else if (isLatePaymentAttempt) {
            const lateRef = `REFUND_LATE_${order._id}_${att.razorpayPaymentId}`;
            const existingTx = existingRefundTxs.find(
                (tx) =>
                    tx.referenceId === lateRef ||
                    (tx.referenceId && tx.referenceId.includes(att.razorpayPaymentId)) ||
                    (tx.description && tx.description.includes(att.razorpayPaymentId))
            );

            if (existingTx) {
                if (att.status !== "REFUNDED_LATE") {
                    await Order.updateOne(
                        { _id: order._id, "paymentAttempts._id": att._id },
                        { $set: { "paymentAttempts.$.status": "REFUNDED_LATE" } }
                    );
                    att.status = "REFUNDED_LATE";
                }
            } else {
                const cred = await walletService.creditWallet({
                    userId: order.userId,
                    amount: att.amount,
                    reason: "ORDER_REFUND",
                    description: `Reconciled late payment refund for payment ${att.razorpayPaymentId} on cancelled Order #${order.orderNumber}`,
                    orderId: order._id,
                    orderNumber: order.orderNumber,
                    referenceId: lateRef,
                });

                if (cred && cred.success) {
                    await Order.updateOne(
                        { _id: order._id, "paymentAttempts._id": att._id },
                        { $set: { "paymentAttempts.$.status": "REFUNDED_LATE" } }
                    );
                    att.status = "REFUNDED_LATE";
                } else {
                    await Order.updateOne(
                        { _id: order._id, "paymentAttempts._id": att._id },
                        { $set: { "paymentAttempts.$.status": "REFUND_PENDING", "paymentAttempts.$.errorReason": cred?.message || "Wallet credit failed" } }
                    ).catch(() => {});
                    unresolvedOps.push(
                        `Failed to recover late payment refund for ${att.razorpayPaymentId}: ${cred?.message || "Wallet credit failed"}`
                    );
                }
            }
        }
    }

    // Step D: Shipping refund for all-cancelled paid orders
    const allCancelled = order.items.every((i) => i.status === "CANCELLED");
    if (
        allCancelled &&
        !isAmbiguous &&
        order.paymentMethod !== "COD" &&
        order.pricing?.shippingFee > 0 &&
        purchaseRefundPool >= order.pricing.shippingFee
    ) {
        const shipRef = `REFUND_CAN_${order._id}_SHIPPING`;
        const existingShipTx = existingRefundTxs.find(
            (tx) => tx.referenceId === shipRef || tx.referenceId === `REFUND_ADM_CAN_${order._id}_SHIPPING`
        );
        if (existingShipTx) {
            if (order.pricing.shippingRefundStatus !== "COMPLETED") {
                order.pricing.shippingRefundStatus = "COMPLETED";
                await Order.updateOne(
                    { _id: order._id },
                    { $set: { "pricing.shippingRefundStatus": "COMPLETED" } }
                ).catch(() => {});
            }
        } else {
            const cred = await walletService.creditWallet({
                userId: order.userId,
                amount: order.pricing.shippingFee,
                reason: "ORDER_CANCELLATION",
                description: `Reconciled shipping refund for Order #${order.orderNumber}`,
                orderId: order._id,
                orderNumber: order.orderNumber,
                referenceId: shipRef,
            });
            if (cred && cred.success) {
                if (!cred.isDuplicate) {
                    refundDelta += order.pricing.shippingFee;
                    purchaseRefundPool = Math.max(0, purchaseRefundPool - order.pricing.shippingFee);
                }
                order.pricing.shippingRefundStatus = "COMPLETED";
                await Order.updateOne(
                    { _id: order._id },
                    { $set: { "pricing.shippingRefundStatus": "COMPLETED" } }
                ).catch(() => {});
            } else {
                order.pricing.shippingRefundStatus = "REFUND_PENDING";
                await Order.updateOne(
                    { _id: order._id },
                    { $set: { "pricing.shippingRefundStatus": "REFUND_PENDING" } }
                ).catch(() => {});
                unresolvedOps.push(`Shipping fee refund failed: ${cred?.message || "Unknown error"}`);
            }
        }
    }

    // Step E: Retry failed coupon release independently of stock restoration
    if (allCancelled && order.pricing?.couponId && !order.pricing?.isCouponReleased) {
        try {
            const { releaseCouponUsage } = require("../admin/couponService");
            await releaseCouponUsage(order.pricing.couponId, order.userId, order.orderNumber);
            order.pricing.isCouponReleased = true;
        } catch (couponErr) {
            console.error(`Reconcile coupon release error on order ${order.orderNumber}:`, couponErr);
            unresolvedOps.push(`Coupon release failed: ${couponErr.message}`);
        }
    }

    // Step E.2: Retry pending referral clawback if recorded
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

    // Step F: Update order accounting
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

    // Step G: Rebuild refund totals strictly separating purchase vs duplicate refunds from durable ledger
    const syncRes = await syncOrderRefundAccounting(order._id);
    if (syncRes && syncRes.ambiguousErrors && syncRes.ambiguousErrors.length > 0) {
        for (const err of syncRes.ambiguousErrors) {
            if (!unresolvedOps.includes(err)) unresolvedOps.push(err);
        }
    }
    const refreshedAfterSync = await Order.findById(order._id);
    if (refreshedAfterSync) {
        order.pricing = refreshedAfterSync.pricing;
        order.paymentStatus = refreshedAfterSync.paymentStatus;
        order.orderStatus = refreshedAfterSync.orderStatus;
    }

    if (unresolvedOps.length > 0) {
        return {
            success: false,
            unresolved: true,
            errors: unresolvedOps,
            message: `Order reconciliation partially completed with ${unresolvedOps.length} unresolved operations.`,
            order,
        };
    }

    return { success: true, message: "Order reconciled successfully.", order };
};

/**
 * @param {string|mongoose.Types.ObjectId|null} targetOrderId - Optional order ID for targeted recovery
 * @returns {Promise<{success: boolean, totalOrdersScanned: number, recoveredOrdersCount: number, unresolvedOrdersCount: number, details: Array}>}
 */
const recoverPendingRefunds = async (targetOrderId = null) => {
    let query = {};
    if (targetOrderId) {
        if (!mongoose.Types.ObjectId.isValid(targetOrderId)) {
            return {
                success: false,
                totalOrdersScanned: 0,
                recoveredOrdersCount: 0,
                unresolvedOrdersCount: 0,
                message: "Invalid target order ID.",
                details: [],
            };
        }
        query = { _id: targetOrderId };
    } else {
        query = {
            $or: [
                { "items.refundStatus": "REFUND_PENDING" },
                { "pricing.shippingRefundStatus": "REFUND_PENDING" },
                { "paymentAttempts.status": "REFUND_PENDING" },
                {
                    paymentStatus: { $in: ["COMPLETED", "REFUNDED"] },
                    items: {
                        $elemMatch: {
                            status: { $in: ["CANCELLED", "RETURN_APPROVED", "RETURNED"] },
                            refundIssued: { $ne: true },
                            refundStatus: { $ne: "COMPLETED" },
                        },
                    },
                },
            ],
        };
    }

    const pendingOrders = await Order.find(query).select("_id orderNumber");
    let recoveredOrdersCount = 0;
    let unresolvedOrdersCount = 0;
    const details = [];

    for (const ord of pendingOrders) {
        try {
            const res = await reconcileOrderState(ord._id);
            if (res && res.success) {
                recoveredOrdersCount++;
                details.push({ orderId: ord._id, orderNumber: ord.orderNumber, success: true });
            } else {
                unresolvedOrdersCount++;
                details.push({
                    orderId: ord._id,
                    orderNumber: ord.orderNumber,
                    success: false,
                    errors: res?.errors || [res?.message || "Reconciliation failed"],
                });
            }
        } catch (err) {
            unresolvedOrdersCount++;
            details.push({
                orderId: ord._id,
                orderNumber: ord.orderNumber,
                success: false,
                errors: [err.message],
            });
        }
    }

    const overallSuccess = unresolvedOrdersCount === 0;
    return {
        success: overallSuccess,
        totalOrdersScanned: pendingOrders.length,
        recoveredOrdersCount,
        unresolvedOrdersCount,
        details,
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
    reconcileOrderState,
    recoverPendingRefunds,
    isCancellationRefundEligible,
    syncOrderRefundAccounting,
    VALID_ORDER_STATUSES,
    VALID_PAYMENT_STATUSES,
};
