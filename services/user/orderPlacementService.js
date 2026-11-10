const mongoose = require("mongoose");
const Order = require("../../models/order/orderModel");
const Payment = require("../../models/order/paymentModel");
const Cart = require("../../models/order/cartModel");
const Address = require("../../models/user/addressModel");
const Variant = require("../../models/product/variantModel");
const Category = require("../../models/product/categoryModel");
const Coupon = require("../../models/order/couponModel");
const { getCartDetails } = require("./cartService");
const { getAddresses } = require("./addressService");
const { getOrCreateWallet, debitWallet } = require("./walletService");
const { getRazorpayInstance, isRazorpayConfigured } = require("../../config/razorpay");
const { recordCouponUsage, releaseCouponUsage } = require("../admin/couponService");
const restoreCancellationStock = require("../../helpers/restoreCancellationStock");

const SHIPPING_THRESHOLD = 10000;
const SHIPPING_FLAT_FEE = 100;

const calculateShippingFee = (subtotal) => {
    if (!subtotal || subtotal <= 0) return 0;
    return subtotal >= SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT_FEE;
};

const getCheckoutDetails = async (userId) => {
    const cartDetails = await getCartDetails(userId);

    if (!cartDetails.items || cartDetails.items.length === 0) {
        return { success: false, reason: "EMPTY_CART", message: "Your shopping bag is empty." };
    }

    if (cartDetails.hasUnavailableItems) {
        return { success: false, reason: "UNAVAILABLE_ITEMS", message: "Some items in your bag are unavailable or exceed stock." };
    }

    const { addresses } = await getAddresses(userId);
    const selectedAddress = addresses.find((a) => a.isDefault) || addresses[0] || null;
    const wallet = await getOrCreateWallet(userId);

    const now = new Date();
    const activeCoupons = await Coupon.find({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
    }).sort({ discountValue: -1 }).lean();

    const availableCoupons = activeCoupons.filter((c) => {
        if (c.usageLimit != null && c.usedCount >= c.usageLimit) {
            return false;
        }
        if (userId && Array.isArray(c.usersUsed)) {
            const userUsage = c.usersUsed.find((u) => String(u.userId) === String(userId));
            if (userUsage && userUsage.usageCount >= (c.perUserLimit || 1)) {
                return false;
            }
        }
        return true;
    });

    return {
        success: true,
        items: cartDetails.items,
        rawSubtotal: cartDetails.rawSubtotal,
        subtotal: cartDetails.subtotal,
        totalOfferDiscount: cartDetails.totalOfferDiscount || 0,
        totalSaleDiscount: cartDetails.totalSaleDiscount || 0,
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
        availableCoupons,
    };
};

const generateOrderNumber = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `VEL-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
        const exists = await Order.exists({ $or: [{ orderNumber: candidate }, { orderId: candidate }] });
        if (!exists) return candidate;
    }
    return `VEL-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
};

const placeOrder = async (userId, addressId, paymentMethod = "COD", checkoutToken = "") => {
    const validMethods = ["COD", "ONLINE", "WALLET"];
    const normalizedMethod = (paymentMethod || "COD").trim().toUpperCase();
    if (!validMethods.includes(normalizedMethod)) {
        return { success: false, message: "Invalid payment method selected." };
    }

    if (normalizedMethod === "ONLINE" && !isRazorpayConfigured()) {
        return { success: false, message: "Online payment gateway is not configured. Please choose COD or Wallet." };
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
                return { success: false, message: "Previous checkout attempt failed.", order: existingOrder, isFailed: true };
            }
            return { success: true, order: existingOrder, isExisting: true };
        }
    }

    const cartDetails = await getCartDetails(userId);
    if (!cartDetails.items || cartDetails.items.length === 0) {
        return { success: false, message: "Your shopping bag is empty." };
    }
    if (cartDetails.hasUnavailableItems) {
        return { success: false, message: "Some items in your cart are no longer available or exceed stock." };
    }
    if (cartDetails.couponError) {
        return { success: false, message: `Coupon issue: ${cartDetails.couponError}.` };
    }

    if (normalizedMethod === "WALLET") {
        const wallet = await getOrCreateWallet(userId);
        if (wallet.balance < cartDetails.totalAmount) {
            return {
                success: false,
                message: `Insufficient wallet balance (₹${wallet.balance.toFixed(2)}). Total payable is ₹${cartDetails.totalAmount.toFixed(2)}.`,
            };
        }
    }

    const orderNumber = await generateOrderNumber();
    let appliedCouponId = cartDetails.appliedCoupon?.couponId || null;
    let couponRecorded = false;
    const decrementedVariants = [];
    let createdOrder = null;

    try {

        if (appliedCouponId) {
            const couponResult = await recordCouponUsage(appliedCouponId, userId, orderNumber);
            if (!couponResult.success) {
                return { success: false, message: couponResult.message || "Failed to apply coupon." };
            }
            couponRecorded = true;
        }

        const orderItems = [];
        for (const item of cartDetails.items) {
            let categoryName = item.product.categoryId?.name || "";
            if (!categoryName && item.product.categoryId) {
                const catDoc = await Category.findById(item.product.categoryId?._id || item.product.categoryId).lean().catch(() => null);
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
                effectiveUnitPrice: item.effectiveUnitPrice,
                unitPrice: item.effectiveUnitPrice,
                priceAtPurchase: item.effectiveUnitPrice,
                offerId: item.offerId || null,
                offerName: item.offerName || "",
                offerDiscount: item.offerDiscount || 0,
                totalOfferDiscount: (item.offerDiscount || 0) * item.quantity,
                saleDiscount: item.saleDiscount || 0,
                totalSaleDiscount: (item.saleDiscount || 0) * item.quantity,
                allocatedCouponDiscount: item.allocatedCouponDiscount || 0,
                allocatedDiscount: item.allocatedCouponDiscount || 0,
                allocatedTax: item.allocatedTax || 0,
                finalPayable: item.finalPayable != null ? item.finalPayable : Math.max(0, item.lineTotal - (item.allocatedCouponDiscount || 0)),
                lineTotal: item.lineTotal,
                status: "PENDING",
                isStockRestored: false,
            });
        }

        for (const item of orderItems) {
            const result = await Variant.updateOne(
                { _id: item.variantId, isActive: true, stock: { $gte: item.quantity } },
                { $inc: { stock: -item.quantity } }
            );

            if (result.modifiedCount === 0) {

                for (const dec of decrementedVariants) {
                    await Variant.updateOne({ _id: dec.variantId }, { $inc: { stock: dec.quantity } }).catch(() => {});
                }
                if (couponRecorded && appliedCouponId) {
                    await releaseCouponUsage(appliedCouponId, userId, orderNumber).catch(() => {});
                }
                return { success: false, message: `Stock for "${item.productName}" changed. Please adjust your cart.` };
            }
            decrementedVariants.push({ variantId: item.variantId, quantity: item.quantity });
        }

        const initialPaymentStatus = normalizedMethod === "WALLET" ? "COMPLETED" : "PENDING";
        const initialOrderStatus = normalizedMethod === "ONLINE" ? "PENDING" : "PLACED";

        createdOrder = await Order.create({
            orderNumber,
            orderId: orderNumber,
            checkoutToken: trimmedToken || `chk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`,
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
                saleDiscount: cartDetails.totalSaleDiscount || 0,
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
            paidAt: normalizedMethod === "WALLET" ? new Date() : null,
            isWalletDebited: normalizedMethod === "WALLET",
        });

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

            await Payment.create({
                orderId: createdOrder._id,
                userId,
                amount: cartDetails.totalAmount,
                paymentMethod: "WALLET",
                status: "COMPLETED",
                paidAt: new Date(),
            });
        } else if (normalizedMethod === "ONLINE") {
            const razorpayInstance = getRazorpayInstance();
            const amountInPaise = Math.round(cartDetails.totalAmount * 100);
            const rzpOrder = await razorpayInstance.orders.create({
                amount: amountInPaise,
                currency: "INR",
                receipt: orderNumber,
                notes: { orderId: createdOrder._id.toString(), userId: userId.toString() },
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
            await Payment.create({
                orderId: createdOrder._id,
                userId,
                amount: cartDetails.totalAmount,
                paymentMethod: "COD",
                status: "PENDING",
            });
        }

        await Cart.updateOne(
            { userId },
            { $set: { items: [], appliedCoupon: null, checkoutToken: null } }
        ).catch(() => {});

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

        if (createdOrder) {
            await Order.updateOne(
                { _id: createdOrder._id },
                { $set: { orderStatus: "CANCELLED", paymentStatus: "FAILED" } }
            ).catch(() => {});

            for (const item of createdOrder.items) {
                await restoreCancellationStock(createdOrder._id, item).catch(() => {});
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

const placeCodOrder = async (userId, addressId, checkoutToken = "") => {
    return placeOrder(userId, addressId, "COD", checkoutToken);
};

module.exports = {
    getCheckoutDetails,
    placeOrder,
    placeCodOrder,
    calculateShippingFee,
    SHIPPING_THRESHOLD,
    SHIPPING_FLAT_FEE,
};
