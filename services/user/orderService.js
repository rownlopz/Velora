const mongoose = require("mongoose");
const crypto = require("crypto");
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
const walletService = require("./walletService");
const { getOrCreateWallet, creditWallet, debitWallet } = walletService;
const Transaction = require("../../models/user/transactionModel");
const Wallet = require("../../models/user/walletModel");
const { getRazorpayInstance } = require("../../config/razorpay");
const { recordCouponUsage, releaseCouponUsage } = require("../admin/couponService");
const restoreCancellationStock = require("../../helpers/restoreCancellationStock");
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
    const wallet = await getOrCreateWallet(userId);

    return {
        success: true,
        items: cartDetails.items,
        rawSubtotal: cartDetails.rawSubtotal,
        subtotal: cartDetails.subtotal,
        totalOfferDiscount: cartDetails.totalOfferDiscount || 0,
        couponDiscount: cartDetails.couponDiscount || 0,
        appliedCoupon: cartDetails.appliedCoupon || null,
        couponError: cartDetails.couponError || null,
        shippingFee: cartDetails.shippingFee,
        shippingThreshold: cartDetails.shippingThreshold,
        totalAmount: cartDetails.totalAmount,
        addresses,
        selectedAddress,
        walletBalance: wallet.balance || 0,
    };
};

/**
 * Places an order supporting COD, WALLET, and ONLINE (Razorpay) payment methods.
 * Features: idempotency token, authoritative pricing & snapshots, atomic stock deduction,
 * wallet debit, coupon usage recording, and rollback recovery for standalone MongoDB.
 */
const placeOrder = async (userId, addressId, paymentMethod = "COD", checkoutToken = "") => {
    const validMethods = ["COD", "ONLINE", "WALLET"];
    const normalizedMethod = (paymentMethod || "COD").trim().toUpperCase();
    if (!validMethods.includes(normalizedMethod)) {
        return { success: false, message: "Invalid payment method selected." };
    }

    if (!addressId || !mongoose.Types.ObjectId.isValid(addressId)) {
        return { success: false, message: "Please select a valid delivery address." };
    }

    const address = await Address.findOne({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Selected delivery address not found." };
    }

    const trimmedToken = (checkoutToken || "").trim();
    if (trimmedToken) {
        const existingOrder = await Order.findOne({ checkoutToken: trimmedToken, userId });
        if (existingOrder) {
            return { success: true, order: existingOrder, isExisting: true };
        }
    }

    const claimNow = new Date();
    const checkoutClaimToken = trimmedToken || `chk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const cart = await Cart.findOneAndUpdate(
        {
            userId,
            "items.0": { $exists: true },
            $or: [
                { checkoutClaimToken: trimmedToken || checkoutClaimToken },
                { checkoutClaimUntil: { $exists: false } },
                { checkoutClaimUntil: null },
                { checkoutClaimUntil: { $lte: claimNow } },
            ],
        },
        {
            $set: {
                checkoutClaimToken,
                checkoutClaimUntil: new Date(Date.now() + 30000), // 30-second lease
            },
        },
        { returnDocument: "after" }
    );
    if (!cart || !cart.items || cart.items.length === 0) {
        return { success: false, message: "Your shopping bag is empty or another checkout attempt is in progress. Please wait a moment." };
    }

    // 2. Authoritative Cart Details & Pricing Calculation
    const cartDetails = await getCartDetails(userId);
    if (!cartDetails.items || cartDetails.items.length === 0) {
        await Cart.updateOne({ userId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
        return { success: false, message: "Your shopping bag is empty." };
    }
    if (cartDetails.hasUnavailableItems) {
        await Cart.updateOne({ userId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
        return { success: false, message: "Some items in your cart are no longer available or exceed stock." };
    }
    if (cartDetails.couponError) {
        await Cart.updateOne({ userId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
        return { success: false, message: `Coupon issue: ${cartDetails.couponError}. Please review your bag before placing the order.` };
    }

    // 3. Wallet Balance Check if paymentMethod is WALLET
    if (normalizedMethod === "WALLET") {
        const wallet = await getOrCreateWallet(userId);
        if (wallet.balance < cartDetails.totalAmount) {
            await Cart.updateOne({ userId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
            return {
                success: false,
                message: `Insufficient wallet balance (₹${wallet.balance.toFixed(2)}). Total payable is ₹${cartDetails.totalAmount.toFixed(2)}.`,
            };
        }
    }

    // 6. Generate unique orderNumber
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

    let couponRecorded = false;
    let appliedCouponId = null;
    let createdOrder = null;
    let walletDebitedSuccessfully = false;
    const decrementedVariants = [];

    try {
        // 4. Reserve Coupon Usage atomically if coupon applied
        if (cartDetails.appliedCoupon && cartDetails.appliedCoupon.couponId) {
            appliedCouponId = cartDetails.appliedCoupon.couponId;
            const couponResult = await recordCouponUsage(appliedCouponId, userId, orderNumber);
            if (!couponResult.success) {
                await Cart.updateOne({ userId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
                return {
                    success: false,
                    message: couponResult.message || "Failed to apply coupon limits.",
                };
            }
            couponRecorded = true;
        }

        // 5. Build immutable purchase item snapshots
        const orderItems = [];

        for (const item of cartDetails.items) {
            const unitPrice = item.effectiveUnitPrice;
            const lineTotal = item.lineTotal;

            let categoryName = item.product.categoryId?.name || "";
            if (!categoryName && item.product.categoryId) {
                const catDoc = await Category.findById(item.product.categoryId?._id || item.product.categoryId).catch(() => null);
                categoryName = catDoc?.name || "";
            }

            orderItems.push({
                variantId: item.variantId,
                productId: item.product._id,
                productName: item.product.name,
                productSlug: item.product.slug,
                brand: item.product.brand || "",
                categoryId: item.product.categoryId?._id || item.product.categoryId || null,
                categoryName,
                thumbnail: item.product.thumbnail || (item.variant.images && item.variant.images[0]) || "",
                color: item.variant.color || "",
                size: item.variant.size || "",
                sku: item.variant.sku || "",
                quantity: item.quantity,
                regularPrice: item.regularPrice,
                salePrice: item.variant.salePrice != null ? item.variant.salePrice : null,
                originalUnitPrice: item.originalUnitPrice || item.regularPrice,
                effectiveUnitPrice: unitPrice,
                unitPrice,
                priceAtPurchase: unitPrice,
                offerId: item.offerId || null,
                offerName: item.offerName || "",
                offerDiscount: item.offerDiscount || 0,
                totalOfferDiscount: (item.offerDiscount || 0) * item.quantity,
                allocatedCouponDiscount: item.allocatedCouponDiscount || 0,
                allocatedDiscount: item.allocatedCouponDiscount || 0,
                finalPayable: item.finalPayable != null ? item.finalPayable : Math.max(0, lineTotal - (item.allocatedCouponDiscount || 0)),
                lineTotal,
                status: "PENDING",
                isStockRestored: false,
            });
        }

        // 7. Atomic Conditional Stock Deduction
        for (const item of orderItems) {
            const result = await Variant.updateOne(
                {
                    _id: item.variantId,
                    isActive: true,
                    stock: { $gte: item.quantity },
                },
                { $inc: { stock: -item.quantity } }
            );

            if (result.modifiedCount === 0) {
                // Roll back already decremented items
                for (const dec of decrementedVariants) {
                    await Variant.updateOne({ _id: dec.variantId }, { $inc: { stock: dec.quantity } }).catch(() => {});
                }
                if (couponRecorded && appliedCouponId) {
                    await releaseCouponUsage(appliedCouponId, userId, orderNumber).catch(() => {});
                }
                return {
                    success: false,
                    message: `Availability or stock for "${item.productName}" changed during checkout. Please adjust your cart.`,
                };
            }

            decrementedVariants.push({ variantId: item.variantId, quantity: item.quantity });
        }

        // 8. Create Order Document
        const initialPaymentStatus = normalizedMethod === "WALLET" ? "COMPLETED" : "PENDING";
        const initialOrderStatus = normalizedMethod === "ONLINE" ? "PENDING" : "PLACED";

        const orderDoc = {
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
                subtotal: cartDetails.subtotal,
                shippingFee: cartDetails.shippingFee,
                discount: (cartDetails.totalOfferDiscount || 0) + (cartDetails.couponDiscount || 0),
                offerDiscount: cartDetails.totalOfferDiscount || 0,
                couponDiscount: cartDetails.couponDiscount || 0,
                couponCode: cartDetails.appliedCoupon ? cartDetails.appliedCoupon.code : null,
                couponId: appliedCouponId,
                totalAmount: cartDetails.totalAmount,
                originalSubtotal: cartDetails.rawSubtotal || cartDetails.subtotal,
                originalShippingFee: cartDetails.shippingFee,
                originalDiscount: (cartDetails.totalOfferDiscount || 0) + (cartDetails.couponDiscount || 0),
                originalTotalAmount: cartDetails.totalAmount,
                cancellationDeduction: 0,
                returnCredit: 0,
                walletRefundIssued: 0,
                currentPayable: cartDetails.totalAmount,
            },
            paymentMethod: normalizedMethod,
            paymentStatus: initialPaymentStatus,
            orderStatus: initialOrderStatus,
            placedAt: new Date(),
            paidAt: normalizedMethod === "WALLET" ? new Date() : null,
            isWalletDebited: false,
        };

        createdOrder = await Order.create(orderDoc);

        // 9. Process Payment Method specifics
        if (normalizedMethod === "WALLET") {
            const debitResult = await debitWallet({
                userId,
                amount: cartDetails.totalAmount,
                reason: "ORDER_PURCHASE",
                description: `Payment for Order #${orderNumber}`,
                orderId: createdOrder._id,
                orderNumber,
                referenceId: `WAL_ORD_${createdOrder._id}`,
            });

            if (!debitResult.success) {
                throw new Error(debitResult.message || "Failed to debit wallet.");
            }

            walletDebitedSuccessfully = true;
            createdOrder.isWalletDebited = true;
            await createdOrder.save();

            await Payment.create({
                orderId: createdOrder._id,
                userId,
                amount: cartDetails.totalAmount,
                paymentMethod: "WALLET",
                status: "COMPLETED",
                paidAt: new Date(),
            });
        } else if (normalizedMethod === "ONLINE") {
            // Razorpay Order Creation
            const razorpayInstance = getRazorpayInstance();
            const amountInPaise = Math.round(cartDetails.totalAmount * 100);
            const rzpOrder = await razorpayInstance.orders.create({
                amount: amountInPaise,
                currency: "INR",
                receipt: orderNumber,
                notes: {
                    orderId: createdOrder._id.toString(),
                    userId: userId.toString(),
                },
            });

            createdOrder.razorpayOrderId = rzpOrder.id;
            createdOrder.paymentAttempts = [
                {
                    gateway: "RAZORPAY",
                    attemptId: `att_${Date.now()}`,
                    razorpayOrderId: rzpOrder.id,
                    amount: cartDetails.totalAmount,
                    status: "INITIATED",
                    createdAt: new Date(),
                },
            ];
            await createdOrder.save();

            await Payment.create({
                orderId: createdOrder._id,
                userId,
                amount: cartDetails.totalAmount,
                paymentMethod: "ONLINE",
                status: "PENDING",
                razorpayOrderId: rzpOrder.id,
            });
        } else {
            // COD
            await Payment.create({
                orderId: createdOrder._id,
                userId,
                amount: cartDetails.totalAmount,
                paymentMethod: "COD",
                status: "PENDING",
            });
        }

        // 10. Clear only purchased variant quantities, preserving concurrent additions
        for (const purchasedItem of orderItems) {
            const updatedCart = await Cart.findOneAndUpdate(
                { userId, "items.variantId": purchasedItem.variantId },
                { $inc: { "items.$.quantity": -purchasedItem.quantity } },
                { returnDocument: "after" }
            );
            if (updatedCart) {
                await Cart.updateOne(
                    { userId },
                    { $pull: { items: { variantId: purchasedItem.variantId, quantity: { $lte: 0 } } } }
                );
            }
        }
        await Cart.updateOne(
            { userId },
            {
                $set: { appliedCoupon: null, checkoutToken: null },
                $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" },
            }
        );

        // Return response
        if (normalizedMethod === "ONLINE") {
            return {
                success: true,
                order: createdOrder,
                isOnline: true,
                razorpay: {
                    keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_placeholderKeyId",
                    orderId: createdOrder.razorpayOrderId,
                    amount: Math.round(cartDetails.totalAmount * 100),
                    currency: "INR",
                    name: "Velora",
                    description: `Order ${createdOrder.orderNumber}`,
                    prefill: {
                        name: `${address.firstName} ${address.lastName}`.trim(),
                        contact: address.phone,
                    },
                },
            };
        }

        return { success: true, order: createdOrder, isOnline: false };
    } catch (err) {
        // Rollback on failure
        await Cart.updateOne(
            { userId },
            { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }
        ).catch(() => {});

        if (createdOrder) {
            for (const item of createdOrder.items) {
                await restoreCancellationStock(createdOrder._id, item).catch(() => {});
            }
            await Order.updateOne(
                { _id: createdOrder._id },
                {
                    $set: {
                        orderStatus: "CANCELLED",
                        paymentStatus: "FAILED",
                        cancellationReason: "System error during checkout; order aborted and stock restored.",
                        cancelledAt: new Date(),
                        cancelledBy: "SYSTEM",
                        "items.$[].status": "CANCELLED",
                        "items.$[].isStockRestored": true,
                    },
                }
            ).catch(() => {});
            await Payment.updateMany(
                { orderId: createdOrder._id },
                { $set: { status: "FAILED" } }
            ).catch(() => {});

            // Roll back wallet debit ONLY IF an actual debit took place
            const Transaction = require("../../models/user/transactionModel");
            const actualDebitTx = await Transaction.findOne({ referenceId: `WAL_ORD_${createdOrder._id}` });
            if (walletDebitedSuccessfully || createdOrder.isWalletDebited || actualDebitTx) {
                await creditWallet({
                    userId,
                    amount: createdOrder.pricing.totalAmount,
                    reason: "ORDER_PURCHASE_ROLLBACK",
                    description: `Rollback for failed checkout Order #${createdOrder.orderNumber}`,
                    orderId: createdOrder._id,
                    orderNumber: createdOrder.orderNumber,
                    referenceId: `ROLLBACK_WAL_${createdOrder._id}`,
                }).catch(() => {});
            }
        } else {
            for (const dec of decrementedVariants) {
                await Variant.updateOne({ _id: dec.variantId }, { $inc: { stock: dec.quantity } }).catch(() => {});
            }
        }
        if (couponRecorded && appliedCouponId) {
            await releaseCouponUsage(appliedCouponId, userId, orderNumber).catch(() => {});
        }
        throw err;
    }
};

/**
 * Places a Cash on Delivery order (convenience wrapper around placeOrder)
 */
const placeCodOrder = async (userId, addressId, checkoutToken = "") => {
    return placeOrder(userId, addressId, "COD", checkoutToken);
};

/**
 * Verifies Razorpay payment signature and activates order fulfillment
 */
const verifyRazorpayPayment = async (userId, paymentData) => {
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = paymentData;
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    // Self-heal Payment document if Order is already COMPLETED
    if (order.paymentStatus === "COMPLETED") {
        // If a different Razorpay payment ID was captured, handle duplicate payment safely
        if (razorpayPaymentId && order.razorpayPaymentId && razorpayPaymentId !== order.razorpayPaymentId) {
            let capturedAmt = order.pricing?.currentPayable != null ? order.pricing.currentPayable : order.pricing.totalAmount;
            try {
                const rzp = getRazorpayInstance();
                if (rzp?.payments) {
                    const pe = await rzp.payments.fetch(razorpayPaymentId).catch(() => null);
                    if (pe?.amount != null) capturedAmt = pe.amount / 100;
                }
            } catch {}
            const dupRef = `REFUND_DUP_${order._id}_${razorpayPaymentId}`;
            const dupCred = await creditWallet({
                userId,
                amount: capturedAmt,
                reason: "ORDER_REFUND",
                description: `Refund for duplicate payment attempt on Order #${order.orderNumber}`,
                orderId: order._id,
                orderNumber: order.orderNumber,
                referenceId: dupRef,
            });
            if (dupCred.success && !dupCred.isDuplicate) {
                await Order.updateOne(
                    { _id: order._id },
                    {
                        $inc: { "pricing.walletRefundIssued": capturedAmt },
                        $push: {
                            paymentAttempts: {
                                gateway: "RAZORPAY",
                                attemptId: `att_dup_${Date.now()}`,
                                razorpayOrderId,
                                razorpayPaymentId,
                                amount: capturedAmt,
                                status: "REFUNDED_DUPLICATE",
                                createdAt: new Date(),
                            },
                        },
                    }
                );
            }
            return {
                success: true,
                message: "Duplicate payment detected and automatically refunded to your wallet.",
                order,
                isDuplicateRefund: true,
            };
        }

        await Payment.updateMany(
            { orderId: order._id, status: { $ne: "COMPLETED" } },
            { $set: { status: "COMPLETED", paidAt: order.paidAt || new Date() } }
        ).catch(() => {});
        return { success: true, message: "Payment already verified.", order, isExisting: true };
    }

    if (order.paymentMethod !== "ONLINE") {
        return { success: false, message: "Order payment method is not eligible for online verification." };
    }

    const matchingAttempt = (order.paymentAttempts || []).find((a) => a.razorpayOrderId === razorpayOrderId);
    if (order.razorpayOrderId && razorpayOrderId && order.razorpayOrderId !== razorpayOrderId && !matchingAttempt) {
        return { success: false, message: "Razorpay order ID mismatch." };
    }

    // Verify HMAC SHA256 Signature
    const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");

    if (expectedSignature !== razorpaySignature) {
        await Order.updateOne(
            { _id: orderId },
            {
                $set: { paymentStatus: "FAILED" },
                $push: {
                    paymentAttempts: {
                        gateway: "RAZORPAY",
                        attemptId: `att_${Date.now()}`,
                        razorpayOrderId,
                        razorpayPaymentId,
                        amount: order.pricing.currentPayable || order.pricing.totalAmount,
                        status: "FAILED",
                        errorReason: "Signature verification failed",
                        createdAt: new Date(),
                    },
                },
            }
        );
        return { success: false, message: "Payment verification failed: Invalid signature." };
    }

    // 1. Verify payment entity with Razorpay gateway if instance is available
    let capturedAmount = order.pricing?.currentPayable != null ? order.pricing.currentPayable : order.pricing.totalAmount;
    let paymentCurrency = "INR";
    try {
        const razorpayInstance = getRazorpayInstance();
        if (razorpayInstance && razorpayInstance.payments && razorpayPaymentId) {
            const payEntity = await razorpayInstance.payments.fetch(razorpayPaymentId).catch(() => null);
            if (payEntity) {
                if (payEntity.currency && payEntity.currency.toUpperCase() !== "INR") {
                    return { success: false, message: `Currency mismatch: expected INR, received ${payEntity.currency}` };
                }
                if (payEntity.amount != null) {
                    capturedAmount = payEntity.amount / 100;
                }
                paymentCurrency = payEntity.currency || "INR";
            }
        }
    } catch {
        // Fall back gracefully to authoritative order amount
    }

    // 2. Handle Late Capture after Cancellation/Refund
    if (order.orderStatus === "CANCELLED" || order.paymentStatus === "REFUNDED") {
        // Prevent replaying a payment callback after normal cancellation from refunding the same payment again!
        const Transaction = require("../../models/user/transactionModel");
        const lateRefId = `REFUND_LATE_${order._id}_${razorpayPaymentId}`;
        const isOriginalPaymentRefunded = (order.razorpayPaymentId && order.razorpayPaymentId === razorpayPaymentId) ||
            (order.pricing?.walletRefundIssued != null && order.pricing.walletRefundIssued >= (order.pricing?.totalAmount || 0));
        const existingTx = await Transaction.findOne({
            referenceId: { $in: [lateRefId, `REFUND_CAN_${order._id}`, `REFUND_ADM_CAN_${order._id}`, `REFUND_DUP_${order._id}_${razorpayPaymentId}`] }
        });

        if (isOriginalPaymentRefunded && existingTx) {
            return {
                success: false,
                message: "Order was already cancelled and this payment has already been refunded.",
                order,
                isAlreadyRefunded: true,
            };
        }

        const orderOriginalTotal = (order.pricing?.originalTotalAmount != null && order.pricing.originalTotalAmount > 0)
            ? order.pricing.originalTotalAmount
            : (order.pricing?.totalAmount || 0);
        const refundAmount = (capturedAmount != null && capturedAmount > 0)
            ? capturedAmount
            : orderOriginalTotal;

        const credResult = await creditWallet({
            userId,
            amount: refundAmount,
            reason: "ORDER_REFUND",
            description: `Refund for late payment on cancelled Order #${order.orderNumber}`,
            orderId: order._id,
            orderNumber: order.orderNumber,
            referenceId: lateRefId,
        });

        if (!credResult.success) {
            return {
                success: false,
                message: credResult.message || "Failed to issue wallet refund for late payment on cancelled order.",
            };
        }

        await Order.updateOne(
            { _id: orderId },
            {
                $set: { paymentStatus: "REFUNDED", razorpayPaymentId, razorpaySignature },
                $push: {
                    paymentAttempts: {
                        gateway: "RAZORPAY",
                        attemptId: `att_${Date.now()}`,
                        razorpayOrderId,
                        razorpayPaymentId,
                        amount: refundAmount,
                        status: "REFUNDED_LATE",
                        createdAt: new Date(),
                    },
                },
            }
        );

        await Payment.updateMany(
            { orderId: order._id },
            { $set: { status: "REFUNDED", refundAmount, razorpayPaymentId, razorpaySignature } }
        );

        return {
            success: false,
            message: "Order was previously cancelled. Captured payment has been credited to your wallet as a refund.",
            order,
            isCancelledLateRefund: true,
        };
    }

    // 3. Conditional success write: atomic check prevents race with concurrent cancellation
    const now = new Date();
    const updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            orderStatus: { $ne: "CANCELLED" },
            paymentStatus: { $ne: "COMPLETED" },
        },
        {
            $set: {
                paymentStatus: "COMPLETED",
                orderStatus: "PROCESSING",
                paidAt: now,
                razorpayPaymentId,
                razorpaySignature,
                "items.$[elem].status": "PROCESSING",
            },
            $push: {
                paymentAttempts: {
                    gateway: "RAZORPAY",
                    attemptId: `att_${Date.now()}`,
                    razorpayOrderId,
                    razorpayPaymentId,
                    amount: capturedAmount,
                    status: "SUCCESS",
                    createdAt: now,
                },
            },
        },
        {
            arrayFilters: [{ "elem.status": { $in: ["PENDING", "PLACED", "ACTIVE"] } }],
            returnDocument: "after",
        }
    );

    if (!updatedOrder) {
        // Race condition: order was cancelled while customer was paying
        const freshOrder = await Order.findById(orderId);
        if (freshOrder && freshOrder.orderStatus === "CANCELLED") {
            const freshOrderOriginalTotal = (freshOrder.pricing?.originalTotalAmount != null && freshOrder.pricing.originalTotalAmount > 0)
                ? freshOrder.pricing.originalTotalAmount
                : (freshOrder.pricing?.totalAmount || 0);
            const refundAmount = (capturedAmount != null && capturedAmount > 0)
                ? capturedAmount
                : freshOrderOriginalTotal;
            const lateRefId = `REFUND_LATE_${freshOrder._id}_${razorpayPaymentId}`;

            const credResult = await creditWallet({
                userId,
                amount: refundAmount,
                reason: "ORDER_REFUND",
                description: `Refund for late payment on cancelled Order #${freshOrder.orderNumber}`,
                orderId: freshOrder._id,
                orderNumber: freshOrder.orderNumber,
                referenceId: lateRefId,
            });

            if (!credResult.success) {
                return { success: false, message: "Failed to issue wallet refund for cancelled order." };
            }

            await Order.updateOne(
                { _id: orderId },
                { $set: { paymentStatus: "REFUNDED", razorpayPaymentId, razorpaySignature } }
            );

            await Payment.updateMany(
                { orderId },
                { $set: { status: "REFUNDED", refundAmount, razorpayPaymentId, razorpaySignature } }
            );

            return {
                success: false,
                message: "Order was cancelled prior to payment completion. Funds have been refunded to your wallet.",
                order: freshOrder,
                isCancelledLateRefund: true,
            };
        }

        const currentOrder = await Order.findById(orderId);
        return { success: true, message: "Payment already processed.", order: currentOrder };
    }

    // 4. Reconcile excess payment if partial cancellation occurred before capture
    const currentPayable = updatedOrder.pricing?.currentPayable != null ? updatedOrder.pricing.currentPayable : updatedOrder.pricing?.totalAmount;
    if (capturedAmount > currentPayable && currentPayable >= 0) {
        const excess = capturedAmount - currentPayable;
        const excessRef = `REFUND_EXCESS_${updatedOrder._id}_${razorpayPaymentId}`;
        const excessCred = await creditWallet({
            userId,
            amount: excess,
            reason: "ORDER_REFUND",
            description: `Refund for excess payment on partially cancelled Order #${updatedOrder.orderNumber}`,
            orderId: updatedOrder._id,
            orderNumber: updatedOrder.orderNumber,
            referenceId: excessRef,
        });

        if (excessCred.success && !excessCred.isDuplicate) {
            await Order.updateOne(
                { _id: updatedOrder._id },
                { $inc: { "pricing.walletRefundIssued": excess } }
            );
            updatedOrder.pricing.walletRefundIssued = (updatedOrder.pricing.walletRefundIssued || 0) + excess;
        }
    }

    await Payment.updateMany(
        { orderId: order._id },
        {
            $set: {
                status: "COMPLETED",
                paidAt: now,
                razorpayPaymentId,
                razorpaySignature,
            },
        }
    );

    const finalOrder = await Order.findById(orderId);
    return { success: true, message: "Payment verified successfully.", order: finalOrder };
};

/**
 * Retries payment for a pending or failed order without duplicate stock deductions
 */
const retryOrderPayment = async (userId, orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    if (order.paymentStatus === "COMPLETED") {
        return { success: false, message: "This order has already been paid successfully." };
    }

    if (order.orderStatus === "CANCELLED") {
        return { success: false, message: "This order has been cancelled and cannot be paid." };
    }

    const payableAmount = order.pricing?.currentPayable != null ? order.pricing.currentPayable : order.pricing.totalAmount;
    if (payableAmount <= 0) {
        return { success: false, message: "No payable balance remaining for this order." };
    }

    // Atomic lease acquisition on Order prevents concurrent retries from generating duplicate gateway orders
    const now = new Date();
    const leaseExpires = new Date(Date.now() + 60000);
    const lockedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            userId,
            orderStatus: { $ne: "CANCELLED" },
            paymentStatus: { $ne: "COMPLETED" },
            $or: [
                { retryLockUntil: null },
                { retryLockUntil: { $lte: now } },
            ],
        },
        {
            $set: { retryLockUntil: leaseExpires },
        },
        { returnDocument: "after" }
    );

    if (!lockedOrder) {
        return { success: false, message: "A payment retry is already in progress. Please wait a moment." };
    }

    // Generate fresh Razorpay order for this retry attempt using authoritative currentPayable
    const razorpayInstance = getRazorpayInstance();
    const attemptCount = (order.paymentAttempts || []).length + 1;
    const amountInPaise = Math.round(payableAmount * 100);

    let rzpOrder;
    try {
        rzpOrder = await razorpayInstance.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: `${order.orderNumber}-R${attemptCount}`,
            notes: {
                orderId: order._id.toString(),
                userId: userId.toString(),
            },
        });
    } catch (err) {
        // Clear lock on failure
        await Order.updateOne({ _id: orderId }, { $set: { retryLockUntil: null } }).catch(() => {});
        throw err;
    }

    const isCodConversion = order.paymentMethod === "COD";

    await Order.updateOne(
        { _id: orderId },
        {
            $set: {
                razorpayOrderId: rzpOrder.id,
                paymentStatus: "PENDING",
                retryLockUntil: null,
                ...(isCodConversion ? { paymentMethod: "ONLINE" } : {}),
            },
            $push: {
                paymentAttempts: {
                    gateway: "RAZORPAY",
                    attemptId: `att_${Date.now()}`,
                    razorpayOrderId: rzpOrder.id,
                    amount: payableAmount,
                    status: "RETRY_INITIATED",
                    createdAt: new Date(),
                },
            },
        }
    );

    if (isCodConversion) {
        await Payment.updateMany(
            { orderId: order._id },
            { $set: { paymentMethod: "ONLINE", razorpayOrderId: rzpOrder.id, amount: payableAmount } }
        );
    }

    return {
        success: true,
        order,
        razorpay: {
            keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_placeholderKeyId",
            orderId: rzpOrder.id,
            amount: amountInPaise,
            currency: "INR",
            name: "Velora",
            description: `Retry Payment for Order #${order.orderNumber}`,
            prefill: {
                name: `${order.shippingAddress.firstName} ${order.shippingAddress.lastName}`.trim(),
                contact: order.shippingAddress.phone,
            },
        },
    };
};

/**
 * Handles incoming Razorpay webhook events idempotently
 */
const handleRazorpayWebhook = async (rawBody, signature) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
    if (!webhookSecret) {
        return { success: false, message: "Webhook secret not configured." };
    }

    const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody));
    const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBuffer)
        .digest("hex");

    const isSigValid = signature && expectedSignature.length === signature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSignature, "utf8"), Buffer.from(signature, "utf8"));

    if (!isSigValid) {
        return { success: false, message: "Invalid webhook signature." };
    }

    let event;
    try {
        event = Buffer.isBuffer(rawBody)
            ? JSON.parse(rawBody.toString("utf8"))
            : (typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody);
    } catch {
        return { success: false, message: "Invalid webhook JSON payload." };
    }

    const eventType = event.event;

    if (eventType === "payment.captured" || eventType === "order.paid") {
        const paymentEntity = event.payload?.payment?.entity;
        const razorpayOrderId = paymentEntity?.order_id || event.payload?.order?.entity?.id;
        const razorpayPaymentId = paymentEntity?.id;
        const capturedAmount = paymentEntity?.amount != null ? paymentEntity.amount / 100 : null;

        if (razorpayOrderId) {
            const order = await Order.findOne({
                $or: [
                    { razorpayOrderId },
                    { "paymentAttempts.razorpayOrderId": razorpayOrderId },
                ],
            });

            if (order) {
                // If payment was already completed on order, ensure Payment records are repaired/in sync
                if (order.paymentStatus === "COMPLETED") {
                    await Payment.updateMany(
                        { orderId: order._id, status: { $ne: "COMPLETED" } },
                        { $set: { status: "COMPLETED", paidAt: order.paidAt || new Date(), razorpayPaymentId, razorpayOrderId } }
                    ).catch(() => {});

                    // Check if this is a second successful payment attempt
                    if (razorpayPaymentId && order.razorpayPaymentId && razorpayPaymentId !== order.razorpayPaymentId) {
                        const dupRefId = `REFUND_DUP_${order._id}_${razorpayPaymentId}`;
                        const dupAmount = (capturedAmount != null && capturedAmount > 0) ? capturedAmount : (order.pricing?.totalAmount || 0);
                        const dupCred = await creditWallet({
                            userId: order.userId,
                            amount: dupAmount,
                            reason: "ORDER_REFUND",
                            description: `Refund for duplicate webhook payment attempt on Order #${order.orderNumber}`,
                            orderId: order._id,
                            orderNumber: order.orderNumber,
                            referenceId: dupRefId,
                        });
                        if (dupCred.success && !dupCred.isDuplicate) {
                            await Order.updateOne(
                                { _id: order._id },
                                {
                                    $inc: { "pricing.walletRefundIssued": dupAmount },
                                    $push: {
                                        paymentAttempts: {
                                            gateway: "RAZORPAY",
                                            attemptId: `att_wh_dup_${Date.now()}`,
                                            razorpayOrderId,
                                            razorpayPaymentId,
                                            amount: dupAmount,
                                            status: "REFUNDED_DUPLICATE",
                                            createdAt: new Date(),
                                        },
                                    },
                                }
                            );
                        }
                    }
                    return { success: true, message: "Order payment was already completed; Payment records repaired." };
                }

                // If order was cancelled or refunded, do not revive it!
                if (order.orderStatus === "CANCELLED" || order.paymentStatus === "REFUNDED") {
                    const Transaction = require("../../models/user/transactionModel");
                    const lateRefId = `REFUND_LATE_${order._id}_${razorpayPaymentId}`;
                    const isOriginalPaymentRefunded = (order.razorpayPaymentId && order.razorpayPaymentId === razorpayPaymentId) ||
                        (order.pricing?.walletRefundIssued != null && order.pricing.walletRefundIssued >= (order.pricing?.totalAmount || 0));
                    const existingTx = await Transaction.findOne({
                        referenceId: { $in: [lateRefId, `REFUND_CAN_${order._id}`, `REFUND_ADM_CAN_${order._id}`, `REFUND_DUP_${order._id}_${razorpayPaymentId}`] }
                    });

                    if (isOriginalPaymentRefunded && existingTx) {
                        return { success: true, message: "Order was cancelled and payment was already refunded." };
                    }

                    const orderOriginalTotal = (order.pricing?.originalTotalAmount != null && order.pricing.originalTotalAmount > 0)
                        ? order.pricing.originalTotalAmount
                        : (order.pricing?.totalAmount || 0);
                    const refundAmount = (capturedAmount != null && capturedAmount > 0)
                        ? capturedAmount
                        : orderOriginalTotal;

                    if (refundAmount > 0) {
                        const credResult = await creditWallet({
                            userId: order.userId,
                            amount: refundAmount,
                            reason: "ORDER_REFUND",
                            description: `Refund for late webhook payment on cancelled Order #${order.orderNumber}`,
                            orderId: order._id,
                            orderNumber: order.orderNumber,
                            referenceId: lateRefId,
                        });
                        if (!credResult.success) {
                            return { success: false, message: "Failed to credit late payment refund." };
                        }
                    }

                    await Order.updateOne(
                        { _id: order._id },
                        {
                            $set: { paymentStatus: "REFUNDED" },
                            $push: {
                                paymentAttempts: {
                                    gateway: "RAZORPAY",
                                    attemptId: `att_webhook_${Date.now()}`,
                                    razorpayOrderId,
                                    razorpayPaymentId,
                                    amount: refundAmount,
                                    status: "REFUNDED_LATE",
                                    createdAt: new Date(),
                                },
                            },
                        }
                    );
                    await Payment.updateMany(
                        { orderId: order._id },
                        { $set: { status: "REFUNDED", refundAmount, razorpayPaymentId } }
                    );
                } else if (order.paymentStatus !== "COMPLETED") {
                    const now = new Date();
                    const finalAmount = capturedAmount != null ? capturedAmount : (order.pricing.currentPayable != null ? order.pricing.currentPayable : order.pricing.totalAmount);

                    const updatedOrder = await Order.findOneAndUpdate(
                        {
                            _id: order._id,
                            orderStatus: { $ne: "CANCELLED" },
                            paymentStatus: { $ne: "COMPLETED" },
                        },
                        {
                            $set: {
                                paymentStatus: "COMPLETED",
                                orderStatus: "PROCESSING",
                                paidAt: now,
                                razorpayPaymentId: razorpayPaymentId || order.razorpayPaymentId,
                                "items.$[elem].status": "PROCESSING",
                            },
                            $push: {
                                paymentAttempts: {
                                    gateway: "RAZORPAY",
                                    attemptId: `att_webhook_${Date.now()}`,
                                    razorpayOrderId,
                                    razorpayPaymentId,
                                    amount: finalAmount,
                                    status: "SUCCESS_WEBHOOK",
                                    createdAt: now,
                                },
                            },
                        },
                        {
                            arrayFilters: [{ "elem.status": { $in: ["PENDING", "PLACED", "ACTIVE"] } }],
                            returnDocument: "after",
                        }
                    );

                    if (!updatedOrder) {
                        const fresh = await Order.findById(order._id);
                        if (fresh && fresh.orderStatus === "CANCELLED") {
                            const lateRefId = `REFUND_LATE_${fresh._id}_${razorpayPaymentId}`;
                            await creditWallet({
                                userId: fresh.userId,
                                amount: finalAmount,
                                reason: "ORDER_REFUND",
                                description: `Refund for late payment on cancelled Order #${fresh.orderNumber}`,
                                orderId: fresh._id,
                                orderNumber: fresh.orderNumber,
                                referenceId: lateRefId,
                            });
                        }
                    } else {
                        // Reconcile excess if partial cancellation happened before capture
                        const currentPayable = updatedOrder.pricing?.currentPayable != null ? updatedOrder.pricing.currentPayable : updatedOrder.pricing?.totalAmount;
                        if (finalAmount > currentPayable && currentPayable >= 0) {
                            const excessPaise = finalAmount - currentPayable;
                            const excessRef = `REFUND_EXCESS_${updatedOrder._id}_${razorpayPaymentId}`;
                            const excessCred = await creditWallet({
                                userId: updatedOrder.userId,
                                amount: excessPaise,
                                reason: "ORDER_REFUND",
                                description: `Refund for excess payment on partially cancelled Order #${updatedOrder.orderNumber}`,
                                orderId: updatedOrder._id,
                                orderNumber: updatedOrder.orderNumber,
                                referenceId: excessRef,
                            });
                            if (excessCred.success && !excessCred.isDuplicate) {
                                await Order.updateOne(
                                    { _id: updatedOrder._id },
                                    { $inc: { "pricing.walletRefundIssued": excessPaise } }
                                );
                            }
                        }
                    }

                    await Payment.updateMany(
                        { orderId: order._id },
                        {
                            $set: {
                                status: "COMPLETED",
                                paidAt: now,
                                razorpayPaymentId: razorpayPaymentId || order.razorpayPaymentId,
                            },
                        }
                    );
                }
            }
        }
    }

    return { success: true };
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

    if (typeof search === "string" && search.trim()) {
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
    const cancelledSuccessfully = [];

    // Atomically claim each item's cancellation to prevent race conditions
    for (const item of cancellableItems) {
        const updated = await Order.findOneAndUpdate(
            {
                _id: orderId,
                userId,
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
                    "items.$.cancellationReason": cleanReason,
                    "items.$.cancelledAt": now,
                    "items.$.cancelledBy": actor,
                },
            },
            { returnDocument: "after" }
        );

        if (updated) {
            await restoreCancellationStock(orderId, item);
            cancelledSuccessfully.push(item);
        }
    }

    if (cancelledSuccessfully.length === 0) {
        return {
            success: false,
            message: "No items could be cancelled (items were already cancelled or shipped concurrently).",
        };
    }

    const latestOrder = await Order.findOne({ _id: orderId, userId });
    const remainingActive = latestOrder.items.filter((i) => !["CANCELLED", "RETURNED", "RETURN_APPROVED"].includes(i.status));

    const totalCancelledDeduction = latestOrder.items
        .filter((i) => i.status === "CANCELLED")
        .reduce((sum, i) => sum + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

    const totalReturnCredit = latestOrder.items
        .filter((i) => ["RETURNED", "RETURN_APPROVED"].includes(i.status))
        .reduce((sum, i) => sum + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

    latestOrder.pricing.cancellationDeduction = totalCancelledDeduction;
    latestOrder.pricing.returnCredit = totalReturnCredit;

    const isAllCancelled = latestOrder.items.every((i) => i.status === "CANCELLED");
    const newOrderStatus = calculateOrderStatusFromItems(latestOrder.items);
    const currentPayable = isAllCancelled
        ? 0
        : Math.max(
            0,
            (latestOrder.pricing.originalTotalAmount || latestOrder.pricing.totalAmount) - totalCancelledDeduction - totalReturnCredit
        );

    // Process wallet refund if order was paid (ONLINE or WALLET)
    let totalRefundCredited = 0;
    if (latestOrder.paymentStatus === "COMPLETED" || latestOrder.paymentStatus === "REFUNDED") {
        for (const item of cancelledSuccessfully) {
            const refundAmount = item.finalPayable != null ? item.finalPayable : item.lineTotal;
            const refundRef = `REFUND_CAN_${latestOrder._id}_${item._id}`;
            const existingTx = await Transaction.findOne({ referenceId: refundRef });
            if (refundAmount > 0 && !item.refundIssued && !existingTx) {
                const credRes = await walletService.creditWallet({
                    userId,
                    amount: refundAmount,
                    reason: "ORDER_CANCELLATION",
                    description: `Refund for cancelled item "${item.productName}" in Order #${latestOrder.orderNumber}`,
                    orderId: latestOrder._id,
                    orderNumber: latestOrder.orderNumber,
                    referenceId: refundRef,
                });
                if (credRes.success && !credRes.isDuplicate) {
                    totalRefundCredited += refundAmount;
                }
                await Order.updateOne(
                    { _id: orderId, "items._id": item._id },
                    { $set: { "items.$.refundIssued": true, "items.$.refundAmount": refundAmount } }
                ).catch(() => {});
            }
        }

        // If all items in order are cancelled, refund shipping fee
        if (isAllCancelled && latestOrder.pricing.shippingFee > 0) {
            const shipRef = `REFUND_CAN_${latestOrder._id}_SHIPPING`;
            const existingShipTx = await Transaction.findOne({ referenceId: shipRef });
            if (!existingShipTx) {
                const shipRes = await walletService.creditWallet({
                    userId,
                    amount: latestOrder.pricing.shippingFee,
                    reason: "ORDER_CANCELLATION",
                    description: `Refund for delivery shipping fee in Order #${latestOrder.orderNumber}`,
                    orderId: latestOrder._id,
                    orderNumber: latestOrder.orderNumber,
                    referenceId: shipRef,
                });
                if (shipRes.success && !shipRes.isDuplicate) {
                    totalRefundCredited += latestOrder.pricing.shippingFee;
                }
            }
        }

        if (totalRefundCredited > 0) {
            await Payment.updateMany(
                { orderId: latestOrder._id },
                {
                    $set: { ...(isAllCancelled ? { status: "REFUNDED" } : {}) },
                    $inc: { refundAmount: totalRefundCredited },
                }
            );
        }
    }

    const setFields = {
        orderStatus: newOrderStatus,
        "pricing.cancellationDeduction": totalCancelledDeduction,
        "pricing.returnCredit": totalReturnCredit,
        "pricing.currentPayable": currentPayable,
        ...(isAllCancelled
            ? {
                cancellationReason: cleanReason,
                cancelledAt: now,
                cancelledBy: actor,
                ...(latestOrder.paymentMethod === "COD" ? { paymentStatus: "CANCELLED" } : { paymentStatus: "REFUNDED" }),
            }
            : {}),
    };

    const updateOps = { $set: setFields };
    if (totalRefundCredited > 0) {
        updateOps.$inc = { "pricing.walletRefundIssued": totalRefundCredited };
    }

    if (isAllCancelled) {
        if (latestOrder.paymentMethod === "COD") {
            await Payment.updateMany({ orderId: latestOrder._id }, { $set: { status: "CANCELLED" } });
        }
    } else if (latestOrder.paymentMethod === "COD") {
        await Payment.updateMany({ orderId: latestOrder._id, status: "PENDING" }, { $set: { amount: currentPayable } });
    }

    await Order.updateOne({ _id: orderId }, updateOps);
    const finalOrder = await Order.findOne({ _id: orderId, userId });

    const partialMsg = remainingActive.length > 0
        ? `Eligible items (${cancelledSuccessfully.length}) have been cancelled. Shipped/delivered items remain active.${totalRefundCredited > 0 ? ` ₹${totalRefundCredited.toFixed(2)} refunded to your wallet.` : ""}`
        : `Order has been cancelled successfully.${totalRefundCredited > 0 ? ` ₹${totalRefundCredited.toFixed(2)} refunded to your wallet.` : ""}`;

    return { success: true, message: partialMsg, order: finalOrder };
};

/**
 * Cancels an individual item within an order with atomic stock restoration.
 */
const cancelOrderItem = async (userId, orderId, itemId, reason = "", actor = "USER") => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId) || !itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
        return { success: false, message: "Invalid order or item ID." };
    }

    const now = new Date();
    const cleanReason = (reason || "").trim() || "Cancelled by customer";

    // Atomically claim the cancellation transition
    const updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            userId,
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
                "items.$.cancellationReason": cleanReason,
                "items.$.cancelledAt": now,
                "items.$.cancelledBy": actor,
            },
        },
        { returnDocument: "after" }
    );

    if (!updatedOrder) {
        const order = await Order.findOne({ _id: orderId, userId });
        if (!order) return { success: false, message: "Order not found." };
        const item = order.items.id(itemId);
        if (!item) return { success: false, message: "Item not found in order." };
        if (item.status === "CANCELLED") {
            return { success: false, message: `"${item.productName}" is already cancelled.` };
        }
        return {
            success: false,
            message: `"${item.productName}" cannot be cancelled because its current status is "${item.status.replace(/_/g, " ")}". Products in shipping or delivered cannot be cancelled.`,
        };
    }

    const cancelledItem = updatedOrder.items.id(itemId);
    await restoreCancellationStock(orderId, cancelledItem);
    await Order.updateOne(
        { _id: orderId, "items._id": itemId },
        { $set: { "items.$.isStockRestored": true, "items.$.restockedQuantity": cancelledItem.quantity } }
    ).catch(() => {});

    // Reload fresh order state so concurrent item cancellations don't overwrite each other's calculations
    const freshOrder = await Order.findById(orderId);
    if (!freshOrder) return { success: false, message: "Order not found." };

    const remainingActive = freshOrder.items.filter((i) => !["CANCELLED", "RETURNED", "RETURN_APPROVED"].includes(i.status));

    const totalCancelledDeduction = freshOrder.items
        .filter((i) => i.status === "CANCELLED")
        .reduce((sum, i) => sum + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

    const totalReturnCredit = freshOrder.items
        .filter((i) => ["RETURNED", "RETURN_APPROVED"].includes(i.status))
        .reduce((sum, i) => sum + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0);

    const isAllCancelledItem = freshOrder.items.every((i) => i.status === "CANCELLED");
    const newOrderStatusItem = calculateOrderStatusFromItems(freshOrder.items);
    const currentPayableItem = isAllCancelledItem
        ? 0
        : Math.max(
            0,
            (freshOrder.pricing.originalTotalAmount || freshOrder.pricing.totalAmount) - totalCancelledDeduction - totalReturnCredit
        );

    // Process wallet refund if order was paid
    let refundCredited = 0;
    if (freshOrder.paymentStatus === "COMPLETED" || freshOrder.paymentStatus === "REFUNDED") {
        const itemRefund = cancelledItem.finalPayable != null ? cancelledItem.finalPayable : cancelledItem.lineTotal;
        const refundRef = `REFUND_CAN_${freshOrder._id}_${cancelledItem._id}`;
        const existingTx = await Transaction.findOne({
            referenceId: { $in: [refundRef, `REFUND_ADM_CAN_${freshOrder._id}_${cancelledItem._id}`] }
        });
        if (itemRefund > 0 && !cancelledItem.refundIssued && !existingTx) {
            const credRes = await walletService.creditWallet({
                userId,
                amount: itemRefund,
                reason: "ORDER_CANCELLATION",
                description: `Refund for cancelled product "${cancelledItem.productName}" in Order #${freshOrder.orderNumber}`,
                orderId: freshOrder._id,
                orderNumber: freshOrder.orderNumber,
                referenceId: refundRef,
            });
            if (credRes.success && !credRes.isDuplicate) {
                refundCredited += itemRefund;
            }
            await Order.updateOne(
                { _id: orderId, "items._id": itemId },
                { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund } }
            ).catch(() => {});
        }

        // If all items in the order are cancelled, refund shipping fee
        if (isAllCancelledItem && freshOrder.pricing.shippingFee > 0) {
            const shipRef = `REFUND_CAN_${freshOrder._id}_SHIPPING`;
            const existingShipTx = await Transaction.findOne({
                referenceId: { $in: [shipRef, `REFUND_ADM_CAN_${freshOrder._id}_SHIPPING`] }
            });
            if (!existingShipTx) {
                const shipRes = await walletService.creditWallet({
                    userId,
                    amount: freshOrder.pricing.shippingFee,
                    reason: "ORDER_CANCELLATION",
                    description: `Refund for delivery shipping fee in Order #${freshOrder.orderNumber}`,
                    orderId: freshOrder._id,
                    orderNumber: freshOrder.orderNumber,
                    referenceId: shipRef,
                });
                if (shipRes.success && !shipRes.isDuplicate) {
                    refundCredited += freshOrder.pricing.shippingFee;
                }
            }
        }

        if (refundCredited > 0) {
            await Payment.updateMany(
                { orderId: freshOrder._id },
                {
                    $set: { ...(isAllCancelledItem ? { status: "REFUNDED" } : {}) },
                    $inc: { refundAmount: refundCredited },
                }
            );
        }
    }

    const setFieldsItem = {
        orderStatus: newOrderStatusItem,
        "pricing.cancellationDeduction": totalCancelledDeduction,
        "pricing.returnCredit": totalReturnCredit,
        "pricing.currentPayable": currentPayableItem,
        ...(isAllCancelledItem
            ? {
                cancellationReason: cleanReason,
                cancelledAt: now,
                cancelledBy: actor,
                ...(updatedOrder.paymentMethod === "COD" ? { paymentStatus: "CANCELLED" } : { paymentStatus: "REFUNDED" }),
            }
            : {}),
    };

    const updateOpsItem = { $set: setFieldsItem };
    if (refundCredited > 0) {
        updateOpsItem.$inc = { "pricing.walletRefundIssued": refundCredited };
    }

    if (isAllCancelledItem) {
        if (updatedOrder.paymentMethod === "COD") {
            await Payment.updateMany({ orderId: updatedOrder._id }, { $set: { status: "CANCELLED" } });
        }
    } else if (updatedOrder.paymentMethod === "COD") {
        await Payment.updateMany({ orderId: updatedOrder._id, status: "PENDING" }, { $set: { amount: currentPayableItem } });
    }

    await Order.updateOne({ _id: orderId }, updateOpsItem);
    const finalOrder = await Order.findOne({ _id: orderId, userId });

    return {
        success: true,
        message: `"${cancelledItem.productName}" has been cancelled successfully.${refundCredited > 0 ? ` ₹${refundCredited.toFixed(2)} refunded to your wallet.` : ""}`,
        order: finalOrder,
    };
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

/**
 * Releases stock and coupon usage for abandoned online payments older than expirationWindowMinutes (default 30 mins).
 * Idempotently marks expired orders as CANCELLED, restores inventory, and releases coupon limits.
 */
const releaseExpiredReservations = async (expirationWindowMinutes = 30) => {
    const cutoffTime = new Date(Date.now() - expirationWindowMinutes * 60 * 1000);
    const expiredOrders = await Order.find({
        $or: [
            {
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                orderStatus: { $in: ["PENDING", "PLACED"] },
                placedAt: { $lte: cutoffTime },
            },
            {
                paymentMethod: "ONLINE",
                cancellationReason: /Payment reservation expired/,
                orderStatus: { $ne: "PROCESSING" },
                "items.isStockRestored": { $ne: true },
            },
        ],
    });

    let releasedCount = 0;
    for (const order of expiredOrders) {
        const now = new Date();
        const claimed = await Order.findOneAndUpdate(
            {
                _id: order._id,
                paymentStatus: "PENDING",
                orderStatus: { $in: ["PENDING", "PLACED"] },
                $or: [
                    { expirationClaimAt: null },
                    { expirationClaimAt: { $lte: new Date(Date.now() - 60000) } },
                ],
            },
            {
                $set: {
                    expirationClaimAt: now,
                    cancellationReason: `Payment reservation expired after ${expirationWindowMinutes} minutes without completion.`,
                },
            },
            { returnDocument: "after" }
        );

        const targetOrder = claimed || (order.cancellationReason && /Payment reservation expired/.test(order.cancellationReason) ? order : null);
        if (targetOrder) {
            for (const item of targetOrder.items) {
                if (!item.isStockRestored) {
                    await restoreCancellationStock(targetOrder._id, item).catch(() => {});
                    await Order.updateOne(
                        { _id: targetOrder._id, "items._id": item._id },
                        { $set: { "items.$.isStockRestored": true, "items.$.restockedQuantity": item.quantity } }
                    ).catch(() => {});
                    item.isStockRestored = true;
                }
            }
            if (targetOrder.pricing?.couponId) {
                await releaseCouponUsage(targetOrder.pricing.couponId, targetOrder.userId, targetOrder.orderNumber).catch(() => {});
            }
            await Order.updateOne(
                { _id: targetOrder._id, orderStatus: { $ne: "PROCESSING" } },
                {
                    $set: {
                        orderStatus: "CANCELLED",
                        paymentStatus: "FAILED",
                        cancelledAt: new Date(),
                        cancelledBy: "SYSTEM",
                        "items.$[elem].status": "CANCELLED",
                        "items.$[elem].cancellationReason": "Payment reservation expired.",
                    },
                },
                { arrayFilters: [{ "elem.status": { $in: ["PENDING", "PLACED"] } }] }
            ).catch(() => {});
            await Payment.updateMany(
                { orderId: targetOrder._id, status: "PENDING" },
                { $set: { status: "FAILED" } }
            ).catch(() => {});
            releasedCount++;
        }
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
    getCheckoutDetails,
    placeOrder,
    placeCodOrder,
    verifyRazorpayPayment,
    retryOrderPayment,
    handleRazorpayWebhook,
    releaseExpiredReservations,
    startReservationExpiryCron,
    stopReservationExpiryCron,
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

