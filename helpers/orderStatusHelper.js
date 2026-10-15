/**
 * Order Status Helper Module
 * Centralizes status definitions, strict allowlist progression rules, and summary utilities.
 */

const ORDER_STATUS_HIERARCHY = {
    PENDING: 0,
    PLACED: 0,
    ACTIVE: 0,
    PROCESSING: 1,
    SHIPPED: 2,
    OUT_FOR_DELIVERY: 3,
    DELIVERED: 4,
};

const MAIN_FLOW_STATUSES = ["PENDING", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

const ALL_VALID_ORDER_STATUSES = [
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

const PREDEFINED_CANCELLATION_REASONS = [
    "Ordered by mistake",
    "Found a better price elsewhere",
    "Need to change shipping address or contact info",
    "Estimated delivery date is too late",
    "Payment / Billing issue",
    "Changed my mind",
    "Other (Please specify)",
];

// Strict transition allowlist per item status
const ALLOWED_ITEM_TRANSITIONS = {
    PENDING: ["PROCESSING", "CANCELLED"],
    PLACED: ["PROCESSING", "CANCELLED"],
    ACTIVE: ["PROCESSING", "CANCELLED"],
    PROCESSING: ["SHIPPED", "CANCELLED"],
    SHIPPED: ["OUT_FOR_DELIVERY", "DELIVERED"],
    OUT_FOR_DELIVERY: ["DELIVERED"],
    DELIVERED: ["RETURN_REQUESTED"],
    RETURN_REQUESTED: ["RETURN_APPROVED", "RETURN_REJECTED"],
    RETURN_APPROVED: ["RETURNED"],
    RETURN_REJECTED: [], // Rejection preserves delivered status
    RETURNED: [],        // Terminal
    CANCELLED: [],       // Terminal
};

/**
 * Validates whether transitioning an item from currentStatus to newStatus is allowed.
 * Strictly enforces forward progression and rejects reviving terminal states.
 */
function validateStatusTransition(currentStatus, newStatus) {
    const cur = (currentStatus || "").trim().toUpperCase();
    const next = (newStatus || "").trim().toUpperCase();

    if (!ALL_VALID_ORDER_STATUSES.includes(next)) {
        return {
            allowed: false,
            message: `Invalid destination status "${newStatus}". Must be one of: ${ALL_VALID_ORDER_STATUSES.join(", ")}`,
        };
    }

    if (!ALL_VALID_ORDER_STATUSES.includes(cur) && cur !== "ACTIVE") {
        return {
            allowed: false,
            message: `Invalid current status "${currentStatus}".`,
        };
    }

    if (cur === next) {
        return { allowed: true, message: "Status is already current." };
    }

    // Terminal states cannot be changed
    if (["CANCELLED", "RETURNED"].includes(cur)) {
        return {
            allowed: false,
            message: `Cannot change status because item is already "${cur}". Terminal states cannot be modified.`,
        };
    }

    const permitted = ALLOWED_ITEM_TRANSITIONS[cur] || [];
    if (!permitted.includes(next)) {
        return {
            allowed: false,
            message: `Transition from "${cur}" to "${next}" is not permitted. Permitted transitions: ${permitted.length ? permitted.join(", ") : "None (terminal state)"}.`,
        };
    }

    return { allowed: true };
}

/**
 * Checks if a customer is allowed to cancel an item with the given status.
 */
function isItemCancellableByUser(status) {
    const s = (status || "").trim().toUpperCase();
    return ["PENDING", "PLACED", "ACTIVE", "PROCESSING"].includes(s);
}

/**
 * Checks if a customer is allowed to return an item with the given status.
 */
function isItemReturnableByUser(status) {
    const s = (status || "").trim().toUpperCase();
    return s === "DELIVERED";
}

/**
 * Returns permissible next statuses for Admin dropdown based on current status.
 */
function getPermissibleNextStatuses(currentStatus) {
    const cur = (currentStatus || "").trim().toUpperCase();
    const allowed = ALLOWED_ITEM_TRANSITIONS[cur] || [];
    return [cur, ...allowed];
}

/**
 * Derives overall orderStatus consistently from the array of item statuses.
 * Accurately handles mixed orders, partial returns, and out-for-delivery states.
 */
function calculateOrderStatusFromItems(items = []) {
    if (!items || items.length === 0) return "PENDING";

    const statuses = items.map((i) => (i.status || "PENDING").toUpperCase());

    // 1. If all items are cancelled
    if (statuses.every((s) => s === "CANCELLED")) {
        return "CANCELLED";
    }

    // 2. Filter out cancelled items
    const nonCancelled = statuses.filter((s) => s !== "CANCELLED");
    if (nonCancelled.length === 0) {
        return "CANCELLED";
    }

    // 3. If every non-cancelled item is returned
    if (nonCancelled.every((s) => s === "RETURNED")) {
        return "RETURNED";
    }

    // 4. Return request states when all active pipeline has delivered
    const isPostDeliveryState = (s) =>
        ["DELIVERED", "RETURNED", "RETURN_REJECTED", "RETURN_REQUESTED", "RETURN_APPROVED"].includes(s);

    if (nonCancelled.every(isPostDeliveryState)) {
        if (nonCancelled.some((s) => s === "RETURN_REQUESTED")) {
            return "RETURN_REQUESTED";
        }
        if (nonCancelled.some((s) => s === "RETURN_APPROVED")) {
            return "RETURN_APPROVED";
        }
        // If all remaining items are delivered / returned / return-rejected, the overall order is fulfilled
        return "DELIVERED";
    }

    // 5. Active delivery pipeline:
    if (nonCancelled.some((s) => ["PENDING", "PLACED", "ACTIVE"].includes(s))) {
        if (nonCancelled.some((s) => ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].includes(s))) {
            return "PROCESSING";
        }
        return "PENDING";
    }

    if (nonCancelled.some((s) => s === "PROCESSING")) {
        return "PROCESSING";
    }

    if (nonCancelled.some((s) => s === "SHIPPED")) {
        return "SHIPPED";
    }

    if (nonCancelled.some((s) => s === "OUT_FOR_DELIVERY")) {
        return "OUT_FOR_DELIVERY";
    }

    return "DELIVERED";
}

module.exports = {
    ORDER_STATUS_HIERARCHY,
    MAIN_FLOW_STATUSES,
    ALL_VALID_ORDER_STATUSES,
    PREDEFINED_CANCELLATION_REASONS,
    validateStatusTransition,
    isItemCancellableByUser,
    isItemReturnableByUser,
    getPermissibleNextStatuses,
    calculateOrderStatusFromItems,
};
