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


const handleAdminAction = (req, res, result, orderId) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    if (!result.success) {
        if (isAjax) return res.status(400).json({ success: false, message: result.message });
        return res.redirect(`/admin/orders/${orderId}?error=${encodeURIComponent(result.message)}`);
    }
    if (isAjax) return res.json({ success: true, message: result.message, order: result.order });
    return res.redirect(`/admin/orders/${orderId}?success=${encodeURIComponent(result.message)}`);
};

 // Lists all orders with descending order by date, filtering, sorting, and pagination
const loadOrders = async (req, res) => {
    try {
        let {
            search = "",
            status = "all",
            paymentMethod = "all",
            paymentStatus = "all",
            sort = "date_desc",
            page = 1,
        } = req.query;

        // Normalise strings
        search = typeof search === "string" ? search.trim() : "";
        status = typeof status === "string" ? status.trim() : "all";
        paymentMethod = typeof paymentMethod === "string" ? paymentMethod.trim() : "all";
        paymentStatus = typeof paymentStatus === "string" ? paymentStatus.trim() : "all";
        sort = typeof sort === "string" ? sort.trim() : "date_desc";

        const sortMap = {
            date_desc: "date_desc",
            placedAt_desc: "date_desc",
            date_asc: "date_asc",
            placedAt_asc: "date_asc",
            amount_desc: "amount_desc",
            totalAmount_desc: "amount_desc",
            amount_asc: "amount_asc",
            totalAmount_asc: "amount_asc",
        };
        const normalizedSort = sortMap[sort] || "date_desc";
    
        const allowedStatuses = [
            "all", "ALL", "ACTIVE",
            "PENDING", "PLACED", "PROCESSING", "SHIPPED",
            "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED",
            "RETURN_REQUESTED", "RETURN_APPROVED", "RETURN_REJECTED", "RETURNED"
        ];
        const normalizedStatus = allowedStatuses.includes(status) ? status : "all";
      
        const allowedPaymentMethods = ["all", "ALL", "COD", "ONLINE", "WALLET"];
        const normalizedPaymentMethod = allowedPaymentMethods.includes(paymentMethod) ? paymentMethod : "all";
      
        const allowedPaymentStatuses = ["all", "ALL", "PENDING", "COMPLETED", "FAILED", "REFUNDED", "CANCELLED"];
        const normalizedPaymentStatus = allowedPaymentStatuses.includes(paymentStatus) ? paymentStatus : "all";

        const parsedPage = Math.max(1, parseInt(page, 10) || 1);

        const result = await getAdminOrders({
            search,
            status: normalizedStatus,
            paymentMethod: normalizedPaymentMethod,
            paymentStatus: normalizedPaymentStatus,
            sort: normalizedSort,
            page: parsedPage,
            limit: 10,
        });

        res.render("admin/orders", {
            orders: result.orders || [],
            totalOrders: result.totalOrders || 0,
            totalPages: result.totalPages || 1,
            currentPage: result.currentPage || 1,
            countsMap: result.countsMap || result.statusCounts || { all: 0, ALL: 0, PENDING: 0, SHIPPED: 0, DELIVERED: 0, CANCELLED: 0 },
            search,
            status: normalizedStatus,
            paymentMethod: normalizedPaymentMethod,
            paymentStatus: normalizedPaymentStatus,
            sort: normalizedSort,
            validStatuses: VALID_ORDER_STATUSES,
        });
    } catch (error) {
        console.error("Admin Load Orders Error:", error);
        res.status(500).send("Something went wrong");
    }
};

 //  Detailed view of an individual order
 
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

// Update individual item status in order
 
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

 // Admin approves return for an item
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
// Admin rejects return for an item
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
// Admin clicks Add Back to Stock for an approved return item
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
// Update payment statu
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
