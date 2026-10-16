const mongoose = require("mongoose");
const { generateInvoicePdf } = require("../../utils/invoiceGenerator");
const Order = require("../../models/order/orderModel");
const Payment = require("../../models/order/paymentModel");
const Cart = require("../../models/order/cartModel");
const Address = require("../../models/user/addressModel");
const Variant = require("../../models/product/variantModel");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");
const { getCartDetails } = require("./cartService");
const { getAddresses } = require("./addressService");
const {
    validateStatusTransition,
    isItemCancellableByUser,
    isItemReturnableByUser,
    calculateOrderStatusFromItems,
    PREDEFINED_CANCELLATION_REASONS,
} = require("../../helpers/orderStatusHelper");

// Standard transparent shipping rule: Free delivery above ₹1,000, else ₹100
const SHIPPING_THRESHOLD = 1000;
const SHIPPING_FLAT_FEE = 100;

const calculateShippingFee = (subtotal) => {
    return subtotal >= SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT_FEE;
};

/**
 * Loads and verifies cart and addresses for checkout entry
 */
const getCheckoutDetails = async (userId) => {
    const cartDetails = await getCartDetails(userId);

    if (!cartDetails.items || cartDetails.items.length === 0) {
        return {
            success: false,
            reason: "EMPTY_CART",
            message: "Your shopping bag is empty.",
        };
    }

    if (cartDetails.hasUnavailableItems) {
        return {
            success: false,
            reason: "UNAVAILABLE_ITEMS",
            message: "Some items in your bag are unavailable or exceed available stock.",
        };
    }

    const { addresses } = await getAddresses(userId);
    const selectedAddress = addresses.find((a) => a.isDefault) || addresses[0] || null;

    const shippingFee = calculateShippingFee(cartDetails.subtotal);
    const totalAmount = cartDetails.subtotal + shippingFee;

    return {
        success: true,
        items: cartDetails.items,
        subtotal: cartDetails.subtotal,
        shippingFee,
        totalAmount,
        addresses,
        selectedAddress,
    };
};

/**
 * Places a Cash on Delivery order with idempotency token, authoritative recalculations,
 * conditional non-negative stock deductions, and selective cart pulling.
 */
const placeCodOrder = async (userId, addressId, checkoutToken = "") => {
    if (!addressId || !mongoose.Types.ObjectId.isValid(addressId)) {
        return { success: false, message: "Please select a valid delivery address." };
    }

    // 1. Idempotency Check: if token provided and already ordered, return existing order
    const trimmedToken = (checkoutToken || "").trim();
    if (trimmedToken) {
        const existingOrder = await Order.findOne({ checkoutToken: trimmedToken, userId });
        if (existingOrder) {
            return { success: true, order: existingOrder, isExisting: true };
        }
    }

    const address = await Address.findOne({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Selected delivery address not found." };
    }

    const cart = await Cart.findOne({ userId });
    if (!cart || !cart.items || cart.items.length === 0) {
        return { success: false, message: "Your shopping bag is empty." };
    }

    // Validate cart integrity: check for duplicate variants in cart
    const seenCartVariants = new Set();
    for (const item of cart.items) {
        const vIdStr = item.variantId.toString();
        if (seenCartVariants.has(vIdStr)) {
            return { success: false, message: "Duplicate items detected in shopping bag. Please refresh your cart." };
        }
        seenCartVariants.add(vIdStr);

        const qty = Number(item.quantity);
        if (!Number.isInteger(qty) || qty <= 0) {
            return { success: false, message: "Invalid item quantity detected." };
        }
        if (qty > 5) {
            return { success: false, message: "Maximum limit is 5 units per item." };
        }
    }

    const orderItems = [];
    const purchasedVariantIds = [];

    for (const item of cart.items) {
        const variant = await Variant.findById(item.variantId);
        if (!variant || !variant.isActive) {
            return {
                success: false,
                message: "An item in your bag is no longer active or available. Please review your cart.",
            };
        }

        const product = await Product.findOne({
            _id: variant.productId,
            isDeleted: false,
            status: "ACTIVE",
        });
        if (!product) {
            return {
                success: false,
                message: "A product in your bag is currently unavailable. Please review your cart.",
            };
        }

        const category = await Category.findOne({
            _id: product.categoryId,
            isDeleted: false,
            isActive: true,
        });
        if (!category) {
            return {
                success: false,
                message: "A category in your bag is currently unavailable. Please review your cart.",
            };
        }

        if (variant.stock < item.quantity) {
            return {
                success: false,
                message: `Only ${variant.stock} left in stock for "${product.name}". Please update your quantity.`,
            };
        }

        // Authoritative unit price using nullish fallback so 0 price is valid
        const unitPrice = variant.salePrice != null ? variant.salePrice : variant.regularPrice;
        const lineTotal = unitPrice * item.quantity;

        orderItems.push({
            variantId: variant._id,
            productId: product._id,
            productName: product.name,
            productSlug: product.slug,
            thumbnail: product.thumbnail || (variant.images && variant.images[0]) || "",
            color: variant.color || "",
            size: variant.size || "",
            sku: variant.sku || "",
            quantity: item.quantity,
            regularPrice: variant.regularPrice,
            unitPrice,
            priceAtPurchase: unitPrice,
            allocatedDiscount: 0,
            lineTotal,
            status: "PENDING",
        });

        purchasedVariantIds.push(variant._id);
    }

    const subtotal = orderItems.reduce((acc, i) => acc + i.lineTotal, 0);
    const shippingFee = calculateShippingFee(subtotal);
    const totalAmount = subtotal + shippingFee;

    // Helper to generate unique order number with collision protection
    const generateOrderNumber = async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
            const timestampPart = Date.now().toString(36).toUpperCase();
            const randomPart = Math.floor(1000 + Math.random() * 9000);
            const candidate = `VEL-${timestampPart}-${randomPart}`;
            const collision = await Order.findOne({
                $or: [{ orderNumber: candidate }, { orderId: candidate }],
            });
            if (!collision) return candidate;
        }
        return `VEL-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    };

    const orderNumber = await generateOrderNumber();

    // Try executing with a MongoDB transaction if replica set / sharded cluster is active;
    // fall back cleanly to conditional atomic deductions with compensation if standalone.
    let session = null;
    let useTransaction = false;
    try {
        const topologyType = mongoose.connection?.client?.topology?.description?.type;
        const isReplicaOrSharded = topologyType === "ReplicaSetWithPrimary" || topologyType === "Sharded";
        if (isReplicaOrSharded) {
            session = await mongoose.startSession();
            session.startTransaction();
            useTransaction = true;
        }
    } catch (e) {
        // Standalone MongoDB server throws transaction error
        session = null;
        useTransaction = false;
    }

    const decrementedVariants = [];

    try {
        // Atomic conditional stock reduction to ensure stock never goes negative
        for (const item of orderItems) {
            const query = { _id: item.variantId, stock: { $gte: item.quantity } };
            const update = { $inc: { stock: -item.quantity } };
            const options = session ? { session } : {};

            const result = await Variant.updateOne(query, update, options);

            if (result.modifiedCount === 0) {
                // Insufficient stock during concurrent checkout
                if (useTransaction) {
                    await session.abortTransaction();
                } else {
                    for (const dec of decrementedVariants) {
                        await Variant.updateOne({ _id: dec.variantId }, { $inc: { stock: dec.quantity } });
                    }
                }
                return {
                    success: false,
                    message: `Stock for "${item.productName}" changed during checkout. Please adjust your cart.`,
                };
            }

            decrementedVariants.push({ variantId: item.variantId, quantity: item.quantity });
        }

        const createOpts = session ? { session } : {};

        const [order] = await Order.create(
            [
                {
                    orderNumber,
                    orderId: orderNumber,
                    checkoutToken: trimmedToken || `chk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`,
                    userId,
                    items: orderItems,
                    shippingAddress: {
                        firstName: address.firstName,
                        lastName: address.lastName,
                        addressLine1: address.addressLine1,
                        addressLine2: address.addressLine2 || "",
                        phone: address.phone,
                        city: address.city,
                        state: address.state,
                        pinCode: address.pinCode,
                        country: address.country,
                    },
                    pricing: {
                        subtotal,
                        shippingFee,
                        discount: 0,
                        totalAmount,
                        originalSubtotal: subtotal,
                        originalShippingFee: shippingFee,
                        originalDiscount: 0,
                        originalTotalAmount: totalAmount,
                        cancellationDeduction: 0,
                        returnCredit: 0,
                        currentPayable: totalAmount,
                    },
                    paymentMethod: "COD",
                    paymentStatus: "PENDING",
                    orderStatus: "PENDING",
                    placedAt: new Date(),
                },
            ],
            createOpts
        );

        await Payment.create(
            [
                {
                    orderId: order._id,
                    userId,
                    amount: totalAmount,
                    paymentMethod: "COD",
                    status: "PENDING",
                },
            ],
            createOpts
        );

        // Selective cart clearing: remove only the purchased variants
        await Cart.updateOne(
            { userId },
            { $pull: { items: { variantId: { $in: purchasedVariantIds } } } },
            createOpts
        );

        if (useTransaction) {
            await session.commitTransaction();
        }

        return { success: true, order };
    } catch (err) {
        if (useTransaction) {
            try {
                await session.abortTransaction();
            } catch (_) {}
        } else {
            // Roll back inventory deductions
            for (const dec of decrementedVariants) {
                try {
                    await Variant.updateOne({ _id: dec.variantId }, { $inc: { stock: dec.quantity } });
                } catch (_) {}
            }
        }

        // Handle duplicate token race gracefully
        if (err.code === 11000 && trimmedToken) {
            const existingOrder = await Order.findOne({ checkoutToken: trimmedToken, userId });
            if (existingOrder) {
                return { success: true, order: existingOrder, isExisting: true };
            }
        }

        throw err;
    } finally {
        if (session) {
            session.endSession();
        }
    }
};

/**
 * Lists user orders with search, status filtering, and pagination
 */
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

    if (search && search.trim()) {
        const term = search.trim();
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [
            { orderNumber: { $regex: escapedTerm, $options: "i" } },
            { orderId: { $regex: escapedTerm, $options: "i" } },
            { "items.productName": { $regex: escapedTerm, $options: "i" } },
            { "shippingAddress.city": { $regex: escapedTerm, $options: "i" } },
        ];
    }

    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedLimit = Math.max(1, Math.min(100, Number(limit) || 10));

    const totalOrders = await Order.countDocuments(filter);
    const totalPages = Math.ceil(totalOrders / parsedLimit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const skip = (currentPage - 1) * parsedLimit;

    const orders = await Order.find(filter)
        .sort({ placedAt: -1, createdAt: -1, _id: -1 })
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

/**
 * Loads order details ensuring strict user ownership
 */
const getOrderDetails = async (userId, orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId }).lean();
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    return { success: true, order };
};

/**
 * Cancels all currently eligible items in an order with atomic stock restoration.
 * Correctly preserves fulfilled/shipped items and original purchase snapshots in mixed orders.
 */
const cancelEntireOrder = async (userId, orderId, reason = "", actor = "USER") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    // Evaluate eligibility separately for each item
    const cancellableItems = order.items.filter((i) => isItemCancellableByUser(i.status));
    if (cancellableItems.length === 0) {
        return {
            success: false,
            message: `No items in this order are currently eligible for cancellation. Products already shipped or delivered cannot be cancelled.`,
        };
    }

    const now = new Date();
    const cleanReason = (reason || "").trim() || "Cancelled by customer";

    // Atomically restore inventory for each eligible item
    for (const item of cancellableItems) {
        await Variant.updateOne(
            { _id: item.variantId },
            { $inc: { stock: item.quantity } }
        );
        item.status = "CANCELLED";
        item.cancellationReason = cleanReason;
        item.cancelledAt = now;
        item.cancelledBy = actor;
    }

    // Check remaining active items (not cancelled and not returned)
    const remainingActive = order.items.filter((i) => !["CANCELLED", "RETURNED"].includes(i.status));

    // Calculate cancellation deductions from original purchase line totals
    const totalCancelledDeduction = order.items
        .filter((i) => i.status === "CANCELLED")
        .reduce((sum, i) => sum + i.lineTotal, 0);

    const totalReturnCredit = order.items
        .filter((i) => i.status === "RETURNED")
        .reduce((sum, i) => sum + i.lineTotal, 0);

    order.pricing.cancellationDeduction = totalCancelledDeduction;
    order.pricing.returnCredit = totalReturnCredit;

    if (remainingActive.length === 0) {
        // Complete cancellation of the order
        order.orderStatus = "CANCELLED";
        order.cancellationReason = cleanReason;
        order.cancelledAt = now;
        order.cancelledBy = actor;
        order.pricing.currentPayable = 0;

        if (order.paymentMethod === "COD") {
            order.paymentStatus = "CANCELLED";
            await Payment.updateMany(
                { orderId: order._id },
                { $set: { status: "CANCELLED" } }
            );
        }
    } else {
        // Mixed order: fulfilled or active items remain. Never mark whole order CANCELLED.
        order.orderStatus = calculateOrderStatusFromItems(order.items);
        // Preserve original shipping charge and subtract only cancelled line items
        order.pricing.currentPayable = Math.max(
            0,
            (order.pricing.originalTotalAmount || order.pricing.totalAmount) - totalCancelledDeduction - totalReturnCredit
        );

        if (order.paymentMethod === "COD") {
            await Payment.updateMany(
                { orderId: order._id, status: "PENDING" },
                { $set: { amount: order.pricing.currentPayable } }
            );
        }
    }

    await order.save();

    const partialMsg = remainingActive.length > 0
        ? `Eligible items (${cancellableItems.length}) have been cancelled. Shipped/delivered items remain active.`
        : "Order has been cancelled successfully.";

    return { success: true, message: partialMsg, order };
};

/**
 * Cancels an individual item within an order with atomic stock restoration.
 */
const cancelOrderItem = async (userId, orderId, itemId, reason = "", actor = "USER") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const item = order.items.id(itemId);
    if (!item) {
        return { success: false, message: "Item not found in order." };
    }

    if (item.status === "CANCELLED") {
        return { success: false, message: `"${item.productName}" is already cancelled.` };
    }

    if (!isItemCancellableByUser(item.status)) {
        return {
            success: false,
            message: `"${item.productName}" cannot be cancelled because its current status is "${item.status.replace(/_/g, " ")}". Products in shipping or delivered cannot be cancelled.`,
        };
    }

    // Atomically increment inventory back
    await Variant.updateOne(
        { _id: item.variantId },
        { $inc: { stock: item.quantity } }
    );

    const now = new Date();
    item.status = "CANCELLED";
    item.cancellationReason = (reason || "").trim() || "Cancelled by customer";
    item.cancelledAt = now;
    item.cancelledBy = actor;

    const remainingActive = order.items.filter((i) => !["CANCELLED", "RETURNED"].includes(i.status));

    const totalCancelledDeduction = order.items
        .filter((i) => i.status === "CANCELLED")
        .reduce((sum, i) => sum + i.lineTotal, 0);

    const totalReturnCredit = order.items
        .filter((i) => i.status === "RETURNED")
        .reduce((sum, i) => sum + i.lineTotal, 0);

    order.pricing.cancellationDeduction = totalCancelledDeduction;
    order.pricing.returnCredit = totalReturnCredit;

    if (remainingActive.length === 0) {
        order.orderStatus = "CANCELLED";
        order.cancellationReason = item.cancellationReason;
        order.cancelledAt = now;
        order.cancelledBy = actor;
        order.pricing.currentPayable = 0;

        if (order.paymentMethod === "COD") {
            order.paymentStatus = "CANCELLED";
            await Payment.updateMany(
                { orderId: order._id },
                { $set: { status: "CANCELLED" } }
            );
        }
    } else {
        order.orderStatus = calculateOrderStatusFromItems(order.items);
        order.pricing.currentPayable = Math.max(
            0,
            (order.pricing.originalTotalAmount || order.pricing.totalAmount) - totalCancelledDeduction - totalReturnCredit
        );

        if (order.paymentMethod === "COD") {
            await Payment.updateMany(
                { orderId: order._id, status: "PENDING" },
                { $set: { amount: order.pricing.currentPayable } }
            );
        }
    }

    await order.save();

    return { success: true, message: `"${item.productName}" has been cancelled successfully.`, order };
};

/**
 * Returns an entire order (requires nonblank reason, only when delivered)
 */
const returnEntireOrder = async (userId, orderId, reason) => {
    const cleanReason = (reason || "").trim();
    if (!cleanReason) {
        return { success: false, message: "A reason is mandatory for returns. Please provide a reason." };
    }

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const eligibleItems = order.items.filter((i) => isItemReturnableByUser(i.status));
    if (eligibleItems.length === 0) {
        return {
            success: false,
            message: "Only delivered products are eligible for return.",
        };
    }

    const now = new Date();
    for (const item of eligibleItems) {
        item.status = "RETURN_REQUESTED";
        item.returnReason = cleanReason;
        item.returnRequestedAt = now;
    }

    order.orderStatus = calculateOrderStatusFromItems(order.items);
    order.returnReason = cleanReason;
    order.returnRequestedAt = now;

    await order.save();

    return { success: true, message: "Return request submitted successfully.", order };
};

/**
 * Returns a specific product within an order (mandatory nonblank reason, only when delivered)
 */
const returnOrderItem = async (userId, orderId, itemId, reason) => {
    const cleanReason = (reason || "").trim();
    if (!cleanReason) {
        return { success: false, message: "A reason is mandatory for returns. Please provide a reason." };
    }

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    const item = order.items.id(itemId);
    if (!item) {
        return { success: false, message: "Item not found in order." };
    }

    if (!isItemReturnableByUser(item.status)) {
        return {
            success: false,
            message: `Returns are only available once the product is delivered. Current status: "${item.status.replace(/_/g, " ")}".`,
        };
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

module.exports = {
    getCheckoutDetails,
    placeCodOrder,
    getUserOrders,
    getOrderDetails,
    cancelEntireOrder,
    cancelOrderItem,
    returnEntireOrder,
    returnOrderItem,
    generateInvoicePdf,
    calculateShippingFee,
    SHIPPING_THRESHOLD,
    SHIPPING_FLAT_FEE,
    PREDEFINED_CANCELLATION_REASONS,
};
