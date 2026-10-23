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
const { getRazorpayInstance, isRazorpayConfigured } = require("../../config/razorpay");
const { recordCouponUsage, releaseCouponUsage } = require("../admin/couponService");
const {
    isCancellationRefundEligible,
    syncOrderRefundAccounting,
} = require("../admin/orderService");
const restoreCancellationStock = require("../../helpers/restoreCancellationStock");
const {
    validateStatusTransition,
    isItemCancellableByUser,
    isItemReturnableByUser,
    calculateOrderStatusFromItems,
    PREDEFINED_CANCELLATION_REASONS,
} = require("../../helpers/orderStatusHelper");

// Standard transparent shipping rule: Free delivery above ₹1,0000, else ₹100
const SHIPPING_THRESHOLD = 10000;
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
        taxRate: cartDetails.taxRate || 0.05,
        taxableAmount: cartDetails.taxableAmount != null ? cartDetails.taxableAmount : (cartDetails.subtotal - (cartDetails.couponDiscount || 0)),
        taxAmount: cartDetails.taxAmount || 0,
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

    if (normalizedMethod === "ONLINE" && !isRazorpayConfigured()) {
        return {
            success: false,
            message: "Online payment gateway is not properly configured. Please select COD or Wallet payment.",
        };
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
            if (existingOrder.orderStatus === "CANCELLED" || existingOrder.paymentStatus === "FAILED") {
                return {
                    success: false,
                    message: "Previous checkout attempt for this session failed or was cancelled.",
                    order: existingOrder,
                    isFailed: true,
                };
            }
            return { success: true, order: existingOrder, isExisting: true };
        }
    }

    const claimNow = new Date();
    const requestLeaseId = `chk_lease_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const cart = await Cart.findOneAndUpdate(
        {
            userId,
            "items.0": { $exists: true },
            $or: [
                { checkoutClaimUntil: { $exists: false } },
                { checkoutClaimUntil: null },
                { checkoutClaimUntil: { $lte: claimNow } },
            ],
        },
        {
            $set: {
                checkoutClaimToken: requestLeaseId,
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
        await Cart.updateOne({ userId, checkoutClaimToken: requestLeaseId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
        return { success: false, message: "Your shopping bag is empty." };
    }
    if (cartDetails.hasUnavailableItems) {
        await Cart.updateOne({ userId, checkoutClaimToken: requestLeaseId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
        return { success: false, message: "Some items in your cart are no longer available or exceed stock." };
    }
    if (cartDetails.couponError) {
        await Cart.updateOne({ userId, checkoutClaimToken: requestLeaseId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
        return { success: false, message: `Coupon issue: ${cartDetails.couponError}. Please review your bag before placing the order.` };
    }

    // 3. Wallet Balance Check if paymentMethod is WALLET
    if (normalizedMethod === "WALLET") {
        const wallet = await getOrCreateWallet(userId);
        if (wallet.balance < cartDetails.totalAmount) {
            await Cart.updateOne({ userId, checkoutClaimToken: requestLeaseId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
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
                await Cart.updateOne({ userId, checkoutClaimToken: requestLeaseId }, { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }).catch(() => {});
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
                allocatedTax: item.allocatedTax || 0,
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
        const initialPaymentStatus = "PENDING";
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
                taxRate: cartDetails.taxRate || 0.05,
                taxableAmount: cartDetails.taxableAmount != null ? cartDetails.taxableAmount : Math.max(0, cartDetails.subtotal - (cartDetails.couponDiscount || 0)),
                taxAmount: cartDetails.taxAmount || 0,
                originalTaxAmount: cartDetails.taxAmount || 0,
                totalAmount: cartDetails.totalAmount,
                originalSubtotal: cartDetails.rawSubtotal || cartDetails.subtotal,
                originalShippingFee: cartDetails.shippingFee,
                originalDiscount: (cartDetails.totalOfferDiscount || 0) + (cartDetails.couponDiscount || 0),
                originalTotalAmount: cartDetails.totalAmount,
                cancellationDeduction: 0,
                returnCredit: 0,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                refundAmount: 0,
                isCouponReleased: false,
                currentPayable: cartDetails.totalAmount,
            },
            paymentMethod: normalizedMethod,
            paymentStatus: initialPaymentStatus,
            orderStatus: initialOrderStatus,
            placedAt: new Date(),
            paidAt: null,
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
            createdOrder.paymentStatus = "COMPLETED";
            createdOrder.orderStatus = "PLACED";
            createdOrder.paidAt = new Date();
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
            { userId, checkoutClaimToken: requestLeaseId },
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
                    keyId: process.env.RAZORPAY_KEY_ID || "",
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
            { userId, checkoutClaimToken: requestLeaseId },
            { $unset: { checkoutClaimToken: "", checkoutClaimUntil: "" } }
        ).catch(() => {});

        if (createdOrder) {
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
                    },
                }
            ).catch(() => {});
            await Payment.updateMany(
                { orderId: createdOrder._id },
                { $set: { status: "FAILED" } }
            ).catch(() => {});

            for (const item of createdOrder.items) {
                try {
                    await restoreCancellationStock(createdOrder._id, item);
                    await Order.updateOne(
                        { _id: createdOrder._id, "items._id": item._id },
                        { $set: { "items.$.isStockRestored": true } }
                    );
                } catch (restockErr) {
                    console.error(`Stock restoration failed for item ${item._id} on rollback of order ${createdOrder._id}:`, restockErr);
                    // Do not mark isStockRestored as true. Leave failure discoverable and retryable!
                }
            }

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
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = paymentData || {};
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }
    if (!razorpayOrderId || typeof razorpayOrderId !== "string" || !razorpayOrderId.trim()) {
        return { success: false, message: "Invalid or missing Razorpay order ID." };
    }
    if (!razorpayPaymentId || typeof razorpayPaymentId !== "string" || !razorpayPaymentId.trim()) {
        return { success: false, message: "Invalid or missing Razorpay payment ID." };
    }
    if (!razorpaySignature || typeof razorpaySignature !== "string" || !razorpaySignature.trim()) {
        return { success: false, message: "Invalid or missing Razorpay signature." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    if (order.paymentMethod !== "ONLINE") {
        return { success: false, message: "Order payment method is not eligible for online verification." };
    }

    const matchingAttempt = (order.paymentAttempts || []).find((a) => a.razorpayOrderId === razorpayOrderId);
    if (!order.razorpayOrderId || (order.razorpayOrderId !== razorpayOrderId && !matchingAttempt)) {
        return { success: false, message: "Razorpay order ID mismatch or unrecognized payment attempt." };
    }

    // 1. Verify HMAC SHA256 Signature FIRST before any financial side effect, refund, or order completion
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret || !secret.trim()) {
        return { success: false, message: "Payment gateway credentials are not configured." };
    }
    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
        .createHmac("sha256", secret.trim())
        .update(body)
        .digest("hex");

    if (expectedSignature !== razorpaySignature) {
        const failedAttempt = {
            gateway: "RAZORPAY",
            attemptId: `att_${Date.now()}`,
            razorpayOrderId,
            razorpayPaymentId,
            amount: order.pricing?.currentPayable || order.pricing?.totalAmount || 0,
            status: "FAILED",
            errorReason: "Signature verification failed",
            createdAt: new Date(),
        };
        // Record failed attempt
        await Order.updateOne({ _id: orderId }, { $push: { paymentAttempts: failedAttempt } });
        // PROTECT CONFIRMED PAYMENT STATES IN DATABASE CONDITIONAL QUERY (Case 2.E):
        // Enforce in conditional database update so invalid signature cannot downgrade completed payment
        await Order.updateOne(
            {
                _id: orderId,
                paymentStatus: { $nin: ["COMPLETED", "REFUNDED"] },
            },
            { $set: { paymentStatus: "FAILED" } }
        );
        return { success: false, message: "Payment verification failed: Invalid signature." };
    }

    // 2. Verify actual collection/capture status, currency, and amount using Razorpay gateway
    const rzp = getRazorpayInstance();
    if (!rzp || !rzp.payments) {
        return { success: false, message: "Payment gateway service is currently unavailable." };
    }

    let payEntity = null;
    try {
        payEntity = await rzp.payments.fetch(razorpayPaymentId);
    } catch (fetchErr) {
        // Treat gateway lookup failure as unresolved, never as permission to refund or complete
        return {
            success: false,
            message: `Gateway lookup failed: unable to verify payment status with payment gateway. ${fetchErr?.message || ""}`.trim(),
        };
    }

    if (!payEntity) {
        return { success: false, message: "Unable to verify payment with payment gateway: payment entity not found." };
    }

    // Verify collection/capture status: must be "captured", not "authorized" or "failed"
    if (payEntity.status !== "captured") {
        return {
            success: false,
            message: `Payment has not been captured (current status: "${payEntity.status}"). Payment cannot be accepted.`,
        };
    }

    // Verify gateway order association: payEntity.order_id must match razorpayOrderId
    if (payEntity.order_id && payEntity.order_id !== razorpayOrderId) {
        return {
            success: false,
            message: `Gateway order mismatch: payment belongs to gateway order ${payEntity.order_id}, not ${razorpayOrderId}.`,
        };
    }

    // Verify currency: must be INR
    if (payEntity.currency && payEntity.currency.toUpperCase() !== "INR") {
        return {
            success: false,
            message: `Currency mismatch: expected INR, received ${payEntity.currency}.`,
        };
    }

    const verifiedCapturedAmt = payEntity.amount != null ? payEntity.amount / 100 : null;
    if (verifiedCapturedAmt == null || verifiedCapturedAmt <= 0) {
        return { success: false, message: "Invalid collected payment amount reported by gateway." };
    }

    const expectedPayable = order.pricing?.currentPayable != null ? order.pricing.currentPayable : order.pricing.totalAmount;
    const expectedPaise = Math.round(expectedPayable * 100);

    // 3. Self-heal Payment document if Order is already COMPLETED or handle legitimate duplicate payment
    if (order.paymentStatus === "COMPLETED") {
        if (order.razorpayPaymentId && razorpayPaymentId === order.razorpayPaymentId) {
            // Replay of already-verified original payment (Case 2.B):
            // Check if there is an unrefunded excess payment obligation that failed previously.
            const curPayable = order.pricing?.currentPayable != null ? order.pricing.currentPayable : order.pricing.totalAmount;
            if (verifiedCapturedAmt > curPayable) {
                const totalDifference = verifiedCapturedAmt - curPayable;
                const Transaction = require("../../models/user/transactionModel");
                const excessRef = `REFUND_EXCESS_${order._id}_${razorpayPaymentId}`;
                const excessTx = await Transaction.findOne({ referenceId: excessRef });

                // Check all refunds already issued (cancellations and returns)
                const itemRefundsIssued = (order.items || [])
                    .filter((i) => (i.status === "CANCELLED" || i.status === "RETURNED" || i.status === "RETURN_APPROVED") && i.refundIssued)
                    .reduce((sum, i) => sum + (i.refundAmount != null ? i.refundAmount : (i.finalPayable != null ? i.finalPayable : i.lineTotal)), 0);

                const alreadyRefundedTotal = Math.max(
                    order.pricing?.purchaseRefundTotal || 0,
                    itemRefundsIssued
                );

                const alreadyCreditedDifference = (excessTx ? (excessTx.amount || totalDifference) : 0) + alreadyRefundedTotal;
                const remainingExcess = Math.max(0, totalDifference - alreadyCreditedDifference);

                if (remainingExcess > 0 && !excessTx) {
                    const cred = await creditWallet({
                        userId,
                        amount: remainingExcess,
                        reason: "ORDER_REFUND",
                        description: `Self-healing excess refund for Order #${order.orderNumber}`,
                        orderId: order._id,
                        orderNumber: order.orderNumber,
                        referenceId: excessRef,
                    });
                    if (cred.success && !cred.isDuplicate) {
                        await Order.updateOne(
                            { _id: order._id },
                            {
                                $inc: {
                                    "pricing.walletRefundIssued": remainingExcess,
                                    "pricing.purchaseRefundTotal": remainingExcess,
                                    "pricing.refundAmount": remainingExcess,
                                },
                            }
                        );
                    }
                }
            }

            await Payment.updateMany(
                { orderId: order._id, status: { $ne: "COMPLETED" } },
                { $set: { status: "COMPLETED", paidAt: order.paidAt || new Date() } }
            ).catch(() => {});
            return { success: true, message: "Payment already verified.", order, isExisting: true };
        }

        if (order.razorpayPaymentId && razorpayPaymentId !== order.razorpayPaymentId) {
            // Verified duplicate payment attempt: signature verified, gateway captured, order_id and currency verified!
            const dupRef = `REFUND_DUP_${order._id}_${razorpayPaymentId}`;
            const dupCred = await creditWallet({
                userId,
                amount: verifiedCapturedAmt,
                reason: "ORDER_REFUND",
                description: `Refund for duplicate payment attempt on Order #${order.orderNumber}`,
                orderId: order._id,
                orderNumber: order.orderNumber,
                referenceId: dupRef,
            });

            if (!dupCred.success) {
                // Case 2.D: Wallet credit failed during duplicate refund!
                await Order.updateOne(
                    { _id: order._id },
                    {
                        $push: {
                            paymentAttempts: {
                                gateway: "RAZORPAY",
                                attemptId: `att_dup_${Date.now()}`,
                                razorpayOrderId,
                                razorpayPaymentId,
                                amount: verifiedCapturedAmt,
                                status: "REFUND_PENDING",
                                errorReason: dupCred.message || "Wallet credit failed",
                                createdAt: new Date(),
                            },
                        },
                    }
                );
                return {
                    success: false,
                    message: "Duplicate payment detected, but automatic wallet refund failed. Refund obligation is preserved for recovery.",
                    order,
                    requiresRecovery: true,
                };
            }

            if (!dupCred.isDuplicate) {
                // Case 2.C: Duplicate-payment refunds must NOT consume the purchase's refund allowance!
                await Order.updateOne(
                    { _id: order._id },
                    {
                        $inc: {
                            "pricing.duplicateRefundTotal": verifiedCapturedAmt,
                            "pricing.walletRefundIssued": verifiedCapturedAmt,
                        },
                        $push: {
                            paymentAttempts: {
                                gateway: "RAZORPAY",
                                attemptId: `att_dup_${Date.now()}`,
                                razorpayOrderId,
                                razorpayPaymentId,
                                amount: verifiedCapturedAmt,
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

    // 4. Verify amount is not underpaid for completing the order
    if (payEntity.amount < expectedPaise) {
        return {
            success: false,
            message: `Underpaid payment: expected ₹${expectedPayable}, received ₹${verifiedCapturedAmt}.`,
        };
    }

    // 5. Handle Late Capture after Cancellation/Refund
    if (order.orderStatus === "CANCELLED" || order.orderStatus === "EXPIRED" || order.paymentStatus === "REFUNDED") {
        const Transaction = require("../../models/user/transactionModel");
        const lateRefId = `REFUND_LATE_${order._id}_${razorpayPaymentId}`;

        // Check if original payment was already refunded
        // Real cancellation refunds use per-item references (REFUND_CAN_${order._id}_${item._id})
        const existingTx = await Transaction.findOne({
            $or: [
                { referenceId: lateRefId },
                { referenceId: `REFUND_DUP_${order._id}_${razorpayPaymentId}` },
                { referenceId: { $regex: `^REFUND_(?:CAN|ADM_CAN)_${order._id}` } },
            ],
        });

        const isOriginalPaymentRefunded = (order.razorpayPaymentId && order.razorpayPaymentId === razorpayPaymentId) ||
            (order.pricing?.walletRefundIssued != null && order.pricing.walletRefundIssued >= (order.pricing?.totalAmount || 0)) ||
            (order.items || []).every((i) => i.refundIssued);

        if ((isOriginalPaymentRefunded && existingTx) || (existingTx && order.razorpayPaymentId === razorpayPaymentId)) {
            return {
                success: false,
                message: "Order was already cancelled and this payment has already been refunded.",
                order,
                isAlreadyRefunded: true,
            };
        }

        const refundAmount = verifiedCapturedAmt;
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
            await Order.updateOne(
                { _id: order._id },
                {
                    $push: {
                        paymentAttempts: {
                            gateway: "RAZORPAY",
                            attemptId: `att_late_${Date.now()}`,
                            razorpayOrderId,
                            razorpayPaymentId,
                            amount: refundAmount,
                            status: "REFUND_PENDING",
                            errorReason: credResult.message || "Wallet credit failed for late payment",
                            createdAt: new Date(),
                        },
                    },
                }
            );
            return {
                success: false,
                message: "Late payment detected for cancelled order, but automatic wallet refund failed. Refund obligation is preserved for recovery.",
                order,
                requiresRecovery: true,
            };
        }

        await Order.updateOne(
            { _id: orderId },
            {
                $set: { paymentStatus: "REFUNDED", razorpayPaymentId, razorpaySignature },
                $inc: { "pricing.walletRefundIssued": refundAmount },
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

    // 6. Conditional success write: atomic check prevents race with concurrent cancellation/expiry
    const now = new Date();
    const updatedOrder = await Order.findOneAndUpdate(
        {
            _id: orderId,
            orderStatus: { $in: ["PENDING", "PLACED"] },
            paymentStatus: { $ne: "COMPLETED" },
        },
        {
            $set: {
                paymentStatus: "COMPLETED",
                orderStatus: "PROCESSING",
                paidAt: now,
                razorpayPaymentId,
                razorpaySignature,
                "pricing.collectedAmount": verifiedCapturedAmt,
                "items.$[elem].status": "PROCESSING",
            },
            $push: {
                paymentAttempts: {
                    gateway: "RAZORPAY",
                    attemptId: `att_${Date.now()}`,
                    razorpayOrderId,
                    razorpayPaymentId,
                    amount: verifiedCapturedAmt,
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
        // Race condition: order was cancelled or expired while customer was paying
        const freshOrder = await Order.findById(orderId);
        if (freshOrder && (freshOrder.orderStatus === "CANCELLED" || freshOrder.orderStatus === "EXPIRED")) {
            const refundAmount = verifiedCapturedAmt;
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
                await Order.updateOne(
                    { _id: freshOrder._id },
                    {
                        $push: {
                            paymentAttempts: {
                                gateway: "RAZORPAY",
                                attemptId: `att_late_${Date.now()}`,
                                razorpayOrderId,
                                razorpayPaymentId,
                                amount: refundAmount,
                                status: "REFUND_PENDING",
                                errorReason: credResult.message || "Wallet credit failed for late payment",
                                createdAt: new Date(),
                            },
                        },
                    }
                );
                return {
                    success: false,
                    message: "Order was cancelled prior to payment completion, but automatic wallet refund failed. Refund obligation is preserved for recovery.",
                    order: freshOrder,
                    requiresRecovery: true,
                };
            }

            await Order.updateOne(
                { _id: orderId },
                {
                    $set: { paymentStatus: "REFUNDED", razorpayPaymentId, razorpaySignature },
                    $inc: { "pricing.walletRefundIssued": refundAmount },
                }
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
        if (currentOrder && currentOrder.paymentStatus === "COMPLETED" && currentOrder.razorpayPaymentId !== razorpayPaymentId) {
            // Reconcile concurrent successful collection: another attempt was captured concurrently
            const dupRef = `REFUND_DUP_${currentOrder._id}_${razorpayPaymentId}`;
            const dupCred = await creditWallet({
                userId,
                amount: verifiedCapturedAmt,
                reason: "ORDER_REFUND",
                description: `Refund for concurrent duplicate payment on Order #${currentOrder.orderNumber}`,
                orderId: currentOrder._id,
                orderNumber: currentOrder.orderNumber,
                referenceId: dupRef,
            });

            if (!dupCred.success) {
                // Case 2.D: Wallet credit failed during duplicate refund
                await Order.updateOne(
                    { _id: currentOrder._id },
                    {
                        $push: {
                            paymentAttempts: {
                                gateway: "RAZORPAY",
                                attemptId: `att_dup_${Date.now()}`,
                                razorpayOrderId,
                                razorpayPaymentId,
                                amount: verifiedCapturedAmt,
                                status: "REFUND_PENDING",
                                errorReason: dupCred.message || "Wallet credit failed",
                                createdAt: new Date(),
                            },
                        },
                    }
                );
                return {
                    success: false,
                    message: "Duplicate payment detected, but wallet refund failed. Refund obligation preserved for recovery.",
                    order: currentOrder,
                    requiresRecovery: true,
                };
            }

            if (!dupCred.isDuplicate) {
                // Case 2.C: Increment duplicateRefundTotal, NOT purchaseRefundTotal
                await Order.updateOne(
                    { _id: currentOrder._id },
                    {
                        $inc: {
                            "pricing.duplicateRefundTotal": verifiedCapturedAmt,
                            "pricing.walletRefundIssued": verifiedCapturedAmt,
                        },
                        $push: {
                            paymentAttempts: {
                                gateway: "RAZORPAY",
                                attemptId: `att_dup_${Date.now()}`,
                                razorpayOrderId,
                                razorpayPaymentId,
                                amount: verifiedCapturedAmt,
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
                order: currentOrder,
                isDuplicateRefund: true,
            };
        }
        return { success: true, message: "Payment already processed.", order: currentOrder };
    }

    // 7. Reconcile items cancelled before capture (Case 2.A)
    // Only refund if captured amount exceeds the merchandise payable for active items
    const activeItemsPayable = (updatedOrder.items || [])
        .filter((i) => i.status !== "CANCELLED")
        .reduce((sum, i) => sum + (i.finalPayable != null ? i.finalPayable : i.lineTotal), 0) + (updatedOrder.pricing?.shippingFee || 0);

    let refundablePool = Math.max(0, verifiedCapturedAmt - activeItemsPayable);

    for (const item of updatedOrder.items || []) {
        if (item.status === "CANCELLED" && !item.refundIssued) {
            const itemRefund = item.finalPayable != null ? item.finalPayable : item.lineTotal;
            const refundForThisItem = Math.min(itemRefund, refundablePool);
            if (refundForThisItem > 0) {
                const refundRef = `REFUND_CAN_${updatedOrder._id}_${item._id}`;
                const existingTx = await Transaction.findOne({ referenceId: refundRef });
                if (!existingTx) {
                    const cred = await creditWallet({
                        userId,
                        amount: refundForThisItem,
                        reason: "ORDER_CANCELLATION",
                        description: `Refund for pre-capture cancelled item "${item.productName}" in Order #${updatedOrder.orderNumber}`,
                        orderId: updatedOrder._id,
                        orderNumber: updatedOrder.orderNumber,
                        referenceId: refundRef,
                    });
                    if (cred.success && !cred.isDuplicate) {
                        await Order.updateOne(
                            { _id: updatedOrder._id, "items._id": item._id },
                            {
                                $set: { "items.$.refundIssued": true, "items.$.refundAmount": refundForThisItem },
                                $inc: {
                                    "pricing.walletRefundIssued": refundForThisItem,
                                    "pricing.purchaseRefundTotal": refundForThisItem,
                                    "pricing.refundAmount": refundForThisItem,
                                },
                            }
                        );
                        item.refundIssued = true;
                        refundablePool -= refundForThisItem;
                    }
                } else {
                    await Order.updateOne(
                        { _id: updatedOrder._id, "items._id": item._id },
                        { $set: { "items.$.refundIssued": true, "items.$.refundAmount": refundForThisItem } }
                    );
                    item.refundIssued = true;
                    refundablePool -= refundForThisItem;
                }
            }
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
                amount: verifiedCapturedAmt,
            },
        }
    );

    const finalOrder = await Order.findById(orderId);
    return { success: true, message: "Payment verified successfully.", order: finalOrder };
};

/**
 * Inspects all recorded gateway orders for an Order to determine current gateway status.
 * Reusable helper ensuring consistent payment verification and safety decisions across
 * retryOrderPayment, releaseExpiredReservations, and getPaymentStatus.
 */
const inspectOrderGatewayPaymentState = async (order) => {
    const candidateGatewayOrderIds = [
        order.razorpayOrderId,
        ...(order.paymentAttempts || []).map((a) => a.razorpayOrderId),
    ];
    try {
        const recordedPayments = await Payment.find({ orderId: order._id }).select("razorpayOrderId").lean();
        for (const p of recordedPayments) {
            if (p.razorpayOrderId) candidateGatewayOrderIds.push(p.razorpayOrderId);
        }
    } catch (paymentErr) {
        // non-blocking
    }
    const uniqueGatewayOrderIds = [...new Set(candidateGatewayOrderIds.filter(Boolean))];

    if (uniqueGatewayOrderIds.length === 0) {
        return {
            hasGatewayAttempts: false,
            status: "NO_ATTEMPTS",
            uniqueGatewayOrderIds: [],
        };
    }

    const razorpayInstance = getRazorpayInstance();
    if (!razorpayInstance || !isRazorpayConfigured() || !razorpayInstance.orders || typeof razorpayInstance.orders.fetchPayments !== "function") {
        return {
            hasGatewayAttempts: true,
            status: "UNRESOLVED",
            reason: "GATEWAY_UNAVAILABLE",
            message: "Payment gateway is not configured or unavailable to inspect previous attempts.",
            uniqueGatewayOrderIds,
        };
    }

    let lookupFailed = false;
    let lookupErrorMessage = null;
    let capturedPayment = null;
    let capturedGatewayOrderId = null;
    let inProgressPayment = null;
    let inProgressGatewayOrderId = null;

    for (const gOrderId of uniqueGatewayOrderIds) {
        let paymentsList;
        try {
            paymentsList = await razorpayInstance.orders.fetchPayments(gOrderId);
        } catch (err) {
            console.error(`Razorpay fetchPayments error for order ${gOrderId}:`, err.message);
            lookupFailed = true;
            lookupErrorMessage = err.message;
            continue;
        }

        if (!paymentsList || !Array.isArray(paymentsList.items)) {
            console.warn(`Razorpay fetchPayments returned unusable response for ${gOrderId}`);
            lookupFailed = true;
            lookupErrorMessage = "Unusable response structure from gateway";
            continue;
        }

        const items = paymentsList.items;

        const cap = items.find((p) => p && p.status === "captured");
        if (cap) {
            capturedPayment = cap;
            capturedGatewayOrderId = gOrderId;
            break; // Definitive capture found
        }

        const inProg = items.find(
            (p) => p && (p.status === "authorized" || p.status === "pending" || p.status === "in_progress")
        );
        if (inProg) {
            inProgressPayment = inProg;
            inProgressGatewayOrderId = gOrderId;
        }
    }

    if (capturedPayment) {
        return {
            hasGatewayAttempts: true,
            status: "CAPTURED",
            capturedPayment,
            capturedGatewayOrderId,
            uniqueGatewayOrderIds,
        };
    }

    if (lookupFailed) {
        return {
            hasGatewayAttempts: true,
            status: "UNRESOLVED",
            reason: "LOOKUP_FAILED",
            message: lookupErrorMessage,
            uniqueGatewayOrderIds,
        };
    }

    if (inProgressPayment) {
        return {
            hasGatewayAttempts: true,
            status: "IN_PROGRESS",
            inProgressPayment,
            inProgressGatewayOrderId,
            uniqueGatewayOrderIds,
        };
    }

    return {
        hasGatewayAttempts: true,
        status: "SAFE_UNPAID",
        uniqueGatewayOrderIds,
    };
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
        return { success: false, isAlreadyPaid: true, message: "This order has already been paid successfully." };
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
    const lockToken = crypto.randomBytes(16).toString("hex");
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
            $set: { retryLockUntil: leaseExpires, retryLockToken: lockToken },
        },
        { returnDocument: "after" }
    );

    if (!lockedOrder) {
        return { success: false, message: "A payment retry is already in progress. Please wait a moment." };
    }

    const releaseLock = async () => {
        try {
            await Order.updateOne(
                { _id: orderId, retryLockToken: lockToken },
                { $set: { retryLockUntil: null, retryLockToken: null } }
            );
        } catch (releaseErr) {
            // non-blocking lock release
        }
    };

    // Verify gateway configuration before creating retry order
    const razorpayInstance = getRazorpayInstance();
    if (!razorpayInstance || !isRazorpayConfigured()) {
        await releaseLock();
        return { success: false, message: "Payment gateway is not properly configured. Please contact support or use another payment method." };
    }

    // 1. Inspect previous gateway attempts using consistent helper
    const gatewayState = await inspectOrderGatewayPaymentState(order);

    if (gatewayState.status === "CAPTURED") {
        await releaseLock();
        const secret = process.env.RAZORPAY_KEY_SECRET;
        const signature = secret
            ? crypto.createHmac("sha256", secret.trim()).update(`${gatewayState.capturedGatewayOrderId}|${gatewayState.capturedPayment.id}`).digest("hex")
            : "";

        let verifyResult;
        try {
            verifyResult = await verifyRazorpayPayment(userId, {
                orderId: order._id,
                razorpayOrderId: gatewayState.capturedGatewayOrderId,
                razorpayPaymentId: gatewayState.capturedPayment.id,
                razorpaySignature: signature,
            });
        } catch (verifyErr) {
            console.error("Verification error during retry payment recovery:", verifyErr);
            return {
                success: false,
                message: "We found a captured payment for this order, but encountered an error verifying it. Please wait a moment and try again.",
                order,
            };
        }

        if (verifyResult && verifyResult.success) {
            return {
                success: true,
                isAlreadyPaid: true,
                message: "A previous payment attempt was captured by the gateway. Order payment is now confirmed.",
                order: verifyResult.order,
            };
        } else {
            // If recovery/verification fails after finding a captured payment, do not fall through and create a new payment attempt
            return {
                success: false,
                message: verifyResult?.message || "We found a captured payment for this order, but could not complete verification. Please contact support.",
                order,
            };
        }
    }

    if (gatewayState.status === "UNRESOLVED") {
        await releaseLock();
        return {
            success: false,
            message: "We couldn’t confirm your previous payment. Please wait a moment and try again.",
            retryable: true,
        };
    }

    if (gatewayState.status === "IN_PROGRESS") {
        await releaseLock();
        return {
            success: false,
            message: "A previous payment is currently being processed by the bank. Please wait a moment and try again.",
            retryable: true,
        };
    }

    // 5. Create a new payment attempt only after previous attempts have been checked successfully and their states permit retry
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
        await releaseLock();
        throw err;
    }

    const isCodConversion = order.paymentMethod === "COD";

    const updateRetryResult = await Order.updateOne(
        {
            _id: orderId,
            paymentStatus: { $ne: "COMPLETED" },
            orderStatus: { $nin: ["CANCELLED", "EXPIRED"] },
            retryLockToken: lockToken,
        },
        {
            $set: {
                razorpayOrderId: rzpOrder.id,
                paymentStatus: "PENDING",
                retryLockUntil: null,
                retryLockToken: null,
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

    if (updateRetryResult.modifiedCount === 0) {
        await releaseLock();
        const fresh = await Order.findById(orderId);
        if (fresh && fresh.paymentStatus === "COMPLETED") {
            return { success: false, isAlreadyPaid: true, message: "Payment was already completed by another attempt.", order: fresh };
        }
        return { success: false, message: "Order is no longer eligible for payment retry.", order: fresh };
    }

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
            keyId: process.env.RAZORPAY_KEY_ID || "",
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
 * Authenticated payment status and reconciliation endpoint without webhooks.
 * Checks local status and reconciles with gateway if an attempt is unresolved.
 */
const getPaymentStatus = async (userId, orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    if (order.paymentStatus === "COMPLETED") {
        return {
            success: true,
            paymentStatus: "COMPLETED",
            orderStatus: order.orderStatus,
            order,
        };
    }

    if (order.paymentMethod !== "ONLINE") {
        return {
            success: true,
            paymentStatus: order.paymentStatus,
            orderStatus: order.orderStatus,
            order,
        };
    }

    const rzp = getRazorpayInstance();
    if (rzp && rzp.orders && typeof rzp.orders.fetchPayments === "function" && isRazorpayConfigured()) {
        const candidateGatewayOrderIds = [
            order.razorpayOrderId,
            ...(order.paymentAttempts || []).map((a) => a.razorpayOrderId),
        ].filter(Boolean);
        const uniqueGatewayOrderIds = [...new Set(candidateGatewayOrderIds)];

        for (const gOrderId of uniqueGatewayOrderIds) {
            try {
                const paymentsList = await rzp.orders.fetchPayments(gOrderId);
                const items = paymentsList?.items || [];
                const capturedPayment = items.find((p) => p.status === "captured");
                if (capturedPayment) {
                    const secret = process.env.RAZORPAY_KEY_SECRET;
                    const signature = secret ? crypto.createHmac("sha256", secret.trim()).update(`${gOrderId}|${capturedPayment.id}`).digest("hex") : "";
                    const verifyResult = await verifyRazorpayPayment(userId, {
                        orderId: order._id,
                        razorpayOrderId: gOrderId,
                        razorpayPaymentId: capturedPayment.id,
                        razorpaySignature: signature,
                    });
                    if (verifyResult.success) {
                        return {
                            success: true,
                            paymentStatus: "COMPLETED",
                            orderStatus: verifyResult.order.orderStatus,
                            order: verifyResult.order,
                            reconciled: true,
                        };
                    }
                }
            } catch (err) {
                // If lookup fails, preserve retryable state
            }
        }
    }

    return {
        success: true,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        order,
    };
};

/**
 * Handles incoming Razorpay webhook events idempotently
 */
const handleRazorpayWebhook = async (rawBody, signature) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret || typeof webhookSecret !== "string" || !webhookSecret.trim()) {
        return { success: false, message: "Webhook endpoint is disabled: RAZORPAY_WEBHOOK_SECRET is not configured." };
    }

    const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody));
    const expectedSignature = crypto
        .createHmac("sha256", webhookSecret.trim())
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

        if (paymentEntity && paymentEntity.status && paymentEntity.status !== "captured") {
            return { success: false, message: `Payment is not captured (status: "${paymentEntity.status}").` };
        }
        if (paymentEntity && paymentEntity.currency && paymentEntity.currency.toUpperCase() !== "INR") {
            return { success: false, message: `Currency mismatch: expected INR, received ${paymentEntity.currency}.` };
        }
        if (capturedAmount != null && capturedAmount <= 0) {
            return { success: false, message: "Invalid captured amount." };
        }

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
                            await Order.updateOne(
                                { _id: fresh._id },
                                {
                                    $set: { paymentStatus: "REFUNDED", razorpayPaymentId },
                                    $inc: { "pricing.walletRefundIssued": finalAmount },
                                }
                            );
                            await Payment.updateMany(
                                { orderId: fresh._id },
                                { $set: { status: "REFUNDED", refundAmount: finalAmount, razorpayPaymentId } }
                            );
                        }
                    } else {
                        // Reconcile items cancelled before capture
                        for (const item of updatedOrder.items || []) {
                            if (item.status === "CANCELLED" && !item.refundIssued) {
                                const itemRefund = item.finalPayable != null ? item.finalPayable : item.lineTotal;
                                const refundRef = `REFUND_CAN_${updatedOrder._id}_${item._id}`;
                                const existingTx = await Transaction.findOne({ referenceId: refundRef });
                                if (itemRefund > 0 && !existingTx) {
                                    const cred = await creditWallet({
                                        userId: updatedOrder.userId,
                                        amount: itemRefund,
                                        reason: "ORDER_CANCELLATION",
                                        description: `Refund for pre-capture cancelled item "${item.productName}" in Order #${updatedOrder.orderNumber}`,
                                        orderId: updatedOrder._id,
                                        orderNumber: updatedOrder.orderNumber,
                                        referenceId: refundRef,
                                    });
                                    if (cred.success && !cred.isDuplicate) {
                                        await Order.updateOne(
                                            { _id: updatedOrder._id, "items._id": item._id },
                                            {
                                                $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund },
                                                $inc: { "pricing.walletRefundIssued": itemRefund },
                                            }
                                        );
                                        item.refundIssued = true;
                                        updatedOrder.pricing.walletRefundIssued = (updatedOrder.pricing.walletRefundIssued || 0) + itemRefund;
                                    }
                                } else if (existingTx) {
                                    await Order.updateOne(
                                        { _id: updatedOrder._id, "items._id": item._id },
                                        { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund } }
                                    );
                                    item.refundIssued = true;
                                }
                            }
                        }

                        // Order successfully marked COMPLETED: mark Payment COMPLETED
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
    const isPaidOrder = await isCancellationRefundEligible(order);
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
                    "items.$.cancelledBeforePayment": !isPaidOrder,
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
    let hadRefundFailure = false;
    if (isPaidOrder && (latestOrder.paymentStatus === "COMPLETED" || latestOrder.paymentStatus === "REFUNDED" || Boolean(latestOrder.paidAt))) {
        for (const item of cancelledSuccessfully) {
            const refundAmount = item.finalPayable != null ? item.finalPayable : item.lineTotal;
            const refundRef = `REFUND_CAN_${latestOrder._id}_${item._id}`;
            const existingTx = await Transaction.findOne({
                referenceId: { $in: [refundRef, `REFUND_ADM_CAN_${latestOrder._id}_${item._id}`] },
            });
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
                if (credRes.success) {
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

        // If all items in order are cancelled, refund shipping fee
        if (isAllCancelled && latestOrder.pricing.shippingFee > 0) {
            const shipRef = `REFUND_CAN_${latestOrder._id}_SHIPPING`;
            const existingShipTx = await Transaction.findOne({
                referenceId: { $in: [shipRef, `REFUND_ADM_CAN_${latestOrder._id}_SHIPPING`] },
            });
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
                    await Order.updateOne(
                        { _id: latestOrder._id },
                        { $set: { "pricing.shippingRefundStatus": "COMPLETED" } }
                    ).catch(() => {});
                } else if (!shipRes.success) {
                    hadRefundFailure = true;
                    await Order.updateOne(
                        { _id: latestOrder._id },
                        { $set: { "pricing.shippingRefundStatus": "REFUND_PENDING" } }
                    ).catch(() => {});
                }
            }
        }
    }

    const finalPaymentStatus = isAllCancelled
        ? (totalRefundCredited > 0 && !hadRefundFailure
            ? "REFUNDED"
            : (latestOrder.paymentStatus === "PENDING" || latestOrder.paymentMethod === "COD" ? "CANCELLED" : latestOrder.paymentStatus))
        : latestOrder.paymentStatus;

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
                paymentStatus: finalPaymentStatus,
            }
            : {}),
    };

    const updateOps = { $set: setFields };
    if (totalRefundCredited > 0) {
        updateOps.$inc = {
            "pricing.walletRefundIssued": totalRefundCredited,
            "pricing.purchaseRefundTotal": totalRefundCredited,
            "pricing.refundAmount": totalRefundCredited,
            refundAmount: totalRefundCredited,
        };
    }

    if (isAllCancelled) {
        if (latestOrder.paymentMethod === "COD" || finalPaymentStatus === "CANCELLED") {
            await Payment.updateMany({ orderId: latestOrder._id }, { $set: { status: "CANCELLED" } });
        }
    } else if (latestOrder.paymentMethod === "COD") {
        await Payment.updateMany({ orderId: latestOrder._id, status: "PENDING" }, { $set: { amount: currentPayable } });
    }

    await Order.updateOne({ _id: orderId }, updateOps);
    await syncOrderRefundAccounting(orderId);
    const finalOrder = await Order.findOne({ _id: orderId, userId });

    let refundMsg = "";
    if (totalRefundCredited > 0) {
        refundMsg = ` ₹${totalRefundCredited.toFixed(2)} refunded to your wallet.`;
    }
    if (hadRefundFailure) {
        refundMsg += " Note: One or more wallet refunds could not be processed and remain pending for retry.";
    }

    const partialMsg = remainingActive.length > 0
        ? `Eligible items (${cancelledSuccessfully.length}) have been cancelled. Shipped/delivered items remain active.${refundMsg}`
        : `Order has been cancelled successfully.${refundMsg}`;

    return { success: true, message: partialMsg, order: finalOrder, hadRefundFailure };
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

    const existingOrder = await Order.findOne({ _id: orderId, userId });
    if (!existingOrder) return { success: false, message: "Order not found." };
    const isPaidOrder = await isCancellationRefundEligible(existingOrder);

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
                "items.$.cancelledBeforePayment": !isPaidOrder,
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
    let hadRefundFailure = false;
    if (isPaidOrder && (freshOrder.paymentStatus === "COMPLETED" || freshOrder.paymentStatus === "REFUNDED" || Boolean(freshOrder.paidAt))) {
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
            if (credRes.success) {
                if (!credRes.isDuplicate) {
                    refundCredited += itemRefund;
                }
                await Order.updateOne(
                    { _id: orderId, "items._id": itemId },
                    { $set: { "items.$.refundIssued": true, "items.$.refundAmount": itemRefund, "items.$.refundStatus": "COMPLETED" } }
                ).catch(() => {});
            } else {
                hadRefundFailure = true;
                await Order.updateOne(
                    { _id: orderId, "items._id": itemId },
                    { $set: { "items.$.refundStatus": "REFUND_PENDING", "items.$.refundAmount": itemRefund } }
                ).catch(() => {});
            }
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
                    await Order.updateOne(
                        { _id: freshOrder._id },
                        { $set: { "pricing.shippingRefundStatus": "COMPLETED" } }
                    ).catch(() => {});
                } else if (!shipRes.success) {
                    hadRefundFailure = true;
                    await Order.updateOne(
                        { _id: freshOrder._id },
                        { $set: { "pricing.shippingRefundStatus": "REFUND_PENDING" } }
                    ).catch(() => {});
                }
            }
        }
    }

    const finalPaymentStatusItem = isAllCancelledItem
        ? (refundCredited > 0 && !hadRefundFailure
            ? "REFUNDED"
            : (freshOrder.paymentStatus === "PENDING" || freshOrder.paymentMethod === "COD" ? "CANCELLED" : freshOrder.paymentStatus))
        : freshOrder.paymentStatus;

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
                paymentStatus: finalPaymentStatusItem,
            }
            : {}),
    };

    const updateOpsItem = { $set: setFieldsItem };
    if (refundCredited > 0) {
        updateOpsItem.$inc = {
            "pricing.walletRefundIssued": refundCredited,
            "pricing.purchaseRefundTotal": refundCredited,
            "pricing.refundAmount": refundCredited,
            refundAmount: refundCredited,
        };
    }

    if (isAllCancelledItem) {
        if (freshOrder.paymentMethod === "COD" || finalPaymentStatusItem === "CANCELLED") {
            await Payment.updateMany({ orderId: freshOrder._id }, { $set: { status: "CANCELLED" } });
        }
    } else if (freshOrder.paymentMethod === "COD") {
        await Payment.updateMany({ orderId: freshOrder._id, status: "PENDING" }, { $set: { amount: currentPayableItem } });
    }

    await Order.updateOne({ _id: orderId }, updateOpsItem);
    await syncOrderRefundAccounting(orderId);
    const finalOrder = await Order.findOne({ _id: orderId, userId });

    let itemRefundMsg = "";
    if (refundCredited > 0) {
        itemRefundMsg = ` ₹${refundCredited.toFixed(2)} refunded to your wallet.`;
    }
    if (hadRefundFailure) {
        itemRefundMsg += " Note: Wallet refund could not be processed and remains pending for retry.";
    }

    return {
        success: true,
        message: `"${cancelledItem.productName}" has been cancelled successfully.${itemRefundMsg}`,
        order: finalOrder,
        hadRefundFailure,
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
                paymentStatus: { $in: ["PENDING", "FAILED"] },
                orderStatus: { $in: ["PENDING", "PLACED"] },
                paidAt: null,
                $and: [
                    {
                        $or: [
                            { placedAt: { $lte: cutoffTime } },
                            { placedAt: null, createdAt: { $lte: cutoffTime } },
                        ],
                    },
                    {
                        $or: [
                            { items: { $elemMatch: { isStockRestored: { $ne: true } } } },
                            { "pricing.couponId": { $exists: true, $ne: null }, "pricing.isCouponReleased": { $ne: true } },
                        ],
                    },
                ],
            },
            {
                paymentMethod: "ONLINE",
                paymentStatus: { $nin: ["COMPLETED", "REFUNDED"] },
                paidAt: null,
                cancellationReason: /Payment reservation expired/,
                orderStatus: { $nin: ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] },
                $or: [
                    { items: { $elemMatch: { isStockRestored: { $ne: true } } } },
                    { "pricing.couponId": { $exists: true, $ne: null }, "pricing.isCouponReleased": { $ne: true } },
                ],
            },
        ],
    });

    let releasedCount = 0;
    for (const order of expiredOrders) {
        if (
            order.paymentStatus === "COMPLETED" ||
            order.paidAt != null ||
            ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].includes(order.orderStatus)
        ) {
            continue; // Protect paid orders and active fulfillment from unpaid-reservation cleanup
        }

        if (order.paymentMethod === "ONLINE" || (order.paymentAttempts && order.paymentAttempts.length > 0) || order.razorpayOrderId) {
            const gatewayState = await inspectOrderGatewayPaymentState(order);

            if (gatewayState.status === "CAPTURED") {
                const secret = process.env.RAZORPAY_KEY_SECRET;
                const signature = secret
                    ? crypto.createHmac("sha256", secret.trim()).update(`${gatewayState.capturedGatewayOrderId}|${gatewayState.capturedPayment.id}`).digest("hex")
                    : "";
                try {
                    const verifyResult = await verifyRazorpayPayment(order.userId, {
                        orderId: order._id,
                        razorpayOrderId: gatewayState.capturedGatewayOrderId,
                        razorpayPaymentId: gatewayState.capturedPayment.id,
                        razorpaySignature: signature,
                    });
                    if (verifyResult && verifyResult.success) {
                        console.log(`[Expiry Recovery] Recovered captured payment for order ${order.orderNumber}`);
                    } else {
                        console.warn(`[Expiry Recovery] Recovery verification returned non-success for order ${order.orderNumber}: ${verifyResult?.message || "Verification failed"}`);
                    }
                } catch (recErr) {
                    console.error(`[Expiry Recovery] Exception during verification recovery on order ${order.orderNumber}:`, recErr.message);
                }
                // Under all circumstances when a captured payment exists, skip cancellation and stock release!
                continue;
            }

            if (gatewayState.status === "UNRESOLVED") {
                // Do not assume unpaid when lookup fails or gateway config is missing!
                console.warn(`[Reservation Expiry] Skipping expiry for order ${order.orderNumber}: gateway lookup unresolved (${gatewayState.reason || "lookup error"}).`);
                continue; // Skip expiry for this order during this run; continue processing other orders
            }

            if (gatewayState.status === "IN_PROGRESS") {
                // Do not cancel or restock while payment is being processed/authorized by the bank!
                console.log(`[Reservation Expiry] Skipping expiry for order ${order.orderNumber}: previous payment is in progress (${gatewayState.inProgressPayment?.status}).`);
                continue; // Skip expiry
            }
        }

        const now = new Date();
        // Atomically claim and mark cancelled/expired BEFORE releasing stock to prevent race with payment capture
        const claimed = await Order.findOneAndUpdate(
            {
                _id: order._id,
                paymentStatus: { $in: ["PENDING", "FAILED"] },
                orderStatus: { $in: ["PENDING", "PLACED"] },
                paidAt: null,
                $and: [
                    {
                        $or: [
                            { expirationClaimAt: null },
                            { expirationClaimAt: { $lte: new Date(Date.now() - 60000) } },
                        ],
                    },
                    {
                        $or: [
                            { retryLockUntil: null },
                            { retryLockUntil: { $lte: now } },
                        ],
                    },
                ],
            },
            {
                $set: {
                    orderStatus: "CANCELLED",
                    paymentStatus: "FAILED",
                    cancelledAt: now,
                    cancelledBy: "SYSTEM",
                    expirationClaimAt: now,
                    cancellationReason: `Payment reservation expired after ${expirationWindowMinutes} minutes without completion.`,
                    "items.$[elem].status": "CANCELLED",
                    "items.$[elem].cancellationReason": "Payment reservation expired.",
                },
            },
            {
                arrayFilters: [{ "elem.status": { $in: ["PENDING", "PLACED"] } }],
                returnDocument: "after",
            }
        );

        const targetOrder = claimed || (
            order.cancellationReason &&
            /Payment reservation expired/.test(order.cancellationReason) &&
            !["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].includes(order.orderStatus) &&
            order.paymentStatus !== "COMPLETED" &&
            order.paidAt == null
                ? order
                : null
        );
        if (targetOrder) {
            let stockFailed = false;
            for (const item of targetOrder.items) {
                if (!item.isStockRestored) {
                    try {
                        await restoreCancellationStock(targetOrder._id, item);
                        await Order.updateOne(
                            { _id: targetOrder._id, "items._id": item._id },
                            { $set: { "items.$.isStockRestored": true, "items.$.restockedQuantity": item.quantity } }
                        );
                        item.isStockRestored = true;
                    } catch (stockErr) {
                        console.error(`Stock restoration failed for expired order item ${item._id}:`, stockErr);
                        stockFailed = true;
                    }
                }
            }
            if (targetOrder.pricing?.couponId && !targetOrder.pricing?.isCouponReleased) {
                try {
                    await releaseCouponUsage(targetOrder.pricing.couponId, targetOrder.userId, targetOrder.orderNumber);
                    await Order.updateOne({ _id: targetOrder._id }, { $set: { "pricing.isCouponReleased": true } });
                } catch (couponErr) {
                    console.error(`Failed to release coupon on expired order ${targetOrder.orderNumber}:`, couponErr);
                }
            }
            await Payment.updateMany(
                { orderId: targetOrder._id, status: "PENDING" },
                { $set: { status: "FAILED" } }
            ).catch(() => {});

            if (!stockFailed) {
                releasedCount++;
            }
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
            try {
                const { recoverPendingRefunds } = require("../admin/orderService");
                await recoverPendingRefunds();
            } catch (refundErr) {
                console.error("Pending refund recovery background task error:", refundErr);
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
    getPaymentStatus,
    handleRazorpayWebhook,
    releaseExpiredReservations,
    startReservationExpiryCron,
    stopReservationExpiryCron,
    recoverPendingRefunds: (...args) => {
        const { recoverPendingRefunds } = require("../admin/orderService");
        return recoverPendingRefunds(...args);
    },
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
    inspectOrderGatewayPaymentState,
    isCancellationRefundEligible,
    syncOrderRefundAccounting,
};

