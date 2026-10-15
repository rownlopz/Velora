const {
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
} = require("../../services/admin/orderService");

/**
 * Reusable helper for admin actions (AJAX JSON vs redirect with notification)
 */
const handleAdminAction = (req, res, result, orderId) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    if (!result.success) {
        if (isAjax) return res.status(400).json({ success: false, message: result.message });
        return res.redirect(`/admin/orders/${orderId}?error=${encodeURIComponent(result.message)}`);
    }
    if (isAjax) return res.json({ success: true, message: result.message, order: result.order });
    return res.redirect(`/admin/orders/${orderId}?success=${encodeURIComponent(result.message)}`);
};

/**
 * Lists all orders with descending order by date, filtering, sorting, and pagination
 */
const loadOrders = async (req, res) => {
    try {
        const {
            search = "",
            status = "all",
            paymentMethod = "all",
            paymentStatus = "all",
            sort = "date_desc",
            page = 1,
        } = req.query;

        const result = await getAdminOrders({
            search,
            status,
            paymentMethod,
            paymentStatus,
            sort,
            page: parseInt(page, 10) || 1,
            limit: 10,
        });

        res.render("admin/orders", {
            orders: result.orders || [],
            totalOrders: result.totalOrders || 0,
            totalPages: result.totalPages || 1,
            currentPage: result.currentPage || 1,
            countsMap: result.countsMap || result.statusCounts || { all: 0, PENDING: 0, SHIPPED: 0, DELIVERED: 0, CANCELLED: 0 },
            search: result.search || "",
            status: result.status || "all",
            paymentMethod: result.paymentMethod || "all",
            paymentStatus: result.paymentStatus || "all",
            sort: result.sort || "date_desc",
            validStatuses: VALID_ORDER_STATUSES,
        });
    } catch (error) {
        console.error("Admin Load Orders Error:", error);
        res.status(500).send("Something went wrong");
    }
};

/**
 * Detailed view of an individual order
 */
const loadOrderDetails = async (req, res) => {
    try {
        const { orderId } = req.params;
        const result = await getAdminOrderDetails(orderId);

        if (!result.success) {
            return res.redirect(`/admin/orders?error=${encodeURIComponent(result.message)}`);
        }

        res.render("admin/order-details", {
            order: result.order,
            payments: result.payments,
            validStatuses: VALID_ORDER_STATUSES,
            validPaymentStatuses: VALID_PAYMENT_STATUSES,
        });
    } catch (error) {
        console.error("Admin Load Order Details Error:", error);
        res.status(500).send("Something went wrong");
    }
};

/**
 * Update order status (pending, shipped, out for delivery, delivered, cancelled, etc.)
 */
const updateOrderStatusController = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status, deliveryNotes, adminNote } = req.body;
        const result = await updateOrderStatus(orderId, status, { deliveryNotes, adminNote });
        return handleAdminAction(req, res, result, orderId);
    } catch (error) {
        console.error("Admin Update Order Status Error:", error);
        return handleAdminAction(req, res, { success: false, message: "Internal server error" }, req.params.orderId);
    }
};

/**
 * Update individual item status in order
 */
const updateOrderItemStatusController = async (req, res) => {
    try {
        const { orderId, itemId } = req.params;
        const { status, adminNote } = req.body;
        const result = await updateAdminOrderItemStatus(orderId, itemId, status, { adminNote });
        return handleAdminAction(req, res, result, orderId);
    } catch (error) {
        console.error("Admin Update Order Item Status Error:", error);
        return handleAdminAction(req, res, { success: false, message: "Internal server error" }, req.params.orderId);
    }
};

/**
 * Admin approves return for an item
 */
const approveReturnItemController = async (req, res) => {
    try {
        const { orderId, itemId } = req.params;
        const { adminMessage, restockImmediately } = req.body;
        const result = await approveReturnItem(
            orderId,
            itemId,
            adminMessage,
            restockImmediately === true || restockImmediately === "true"
        );
        return handleAdminAction(req, res, result, orderId);
    } catch (error) {
        console.error("Admin Approve Return Error:", error);
        return handleAdminAction(req, res, { success: false, message: "Internal server error" }, req.params.orderId);
    }
};

/**
 * Admin rejects return for an item
 */
const rejectReturnItemController = async (req, res) => {
    try {
        const { orderId, itemId } = req.params;
        const result = await rejectReturnItem(orderId, itemId, req.body.adminMessage);
        return handleAdminAction(req, res, result, orderId);
    } catch (error) {
        console.error("Admin Reject Return Error:", error);
        return handleAdminAction(req, res, { success: false, message: "Internal server error" }, req.params.orderId);
    }
};

/**
 * Admin clicks Add Back to Stock for an approved return item
 */
const restockReturnItemController = async (req, res) => {
    try {
        const { orderId, itemId } = req.params;
        const result = await restockReturnItem(orderId, itemId, req.body.adminMessage);
        return handleAdminAction(req, res, result, orderId);
    } catch (error) {
        console.error("Admin Restock Return Error:", error);
        return handleAdminAction(req, res, { success: false, message: "Internal server error" }, req.params.orderId);
    }
};

/**
 * Update payment status
 */
const updatePaymentStatusController = async (req, res) => {
    try {
        const { orderId } = req.params;
        const result = await updatePaymentStatus(orderId, req.body.paymentStatus);
        return handleAdminAction(req, res, result, orderId);
    } catch (error) {
        console.error("Admin Update Payment Status Error:", error);
        return handleAdminAction(req, res, { success: false, message: "Internal server error" }, req.params.orderId);
    }
};

module.exports = {
    loadOrders,
    loadOrderDetails,
    updateOrderStatusController,
    updateOrderItemStatusController,
    approveReturnItemController,
    rejectReturnItemController,
    restockReturnItemController,
    updatePaymentStatusController,
};
