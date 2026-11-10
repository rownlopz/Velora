const crypto = require("crypto");
const mongoose = require("mongoose");
const Order = require("../../models/order/orderModel");
const Payment = require("../../models/order/paymentModel");
const Cart = require("../../models/order/cartModel");
const { getRazorpayInstance, isRazorpayConfigured } = require("../../config/razorpay");

const verifyRazorpayPayment = async (userId, paymentData) => {
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = paymentData || {};
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return { success: false, message: "Missing Razorpay payment verification details." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    if (order.paymentStatus === "COMPLETED") {
        return { success: true, message: "Payment already verified.", order, isExisting: true };
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
        return { success: false, message: "Payment gateway key secret is not configured." };
    }

    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
        .createHmac("sha256", secret.trim())
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
                        razorpayOrderId,
                        razorpayPaymentId,
                        amount: order.pricing?.currentPayable || order.pricing?.totalAmount || 0,
                        status: "FAILED",
                        errorReason: "Signature verification failed",
                        createdAt: new Date(),
                    },
                },
            }
        );
        return { success: false, message: "Payment verification failed: Invalid signature." };
    }

    const rzp = getRazorpayInstance();
    if (rzp && rzp.payments && isRazorpayConfigured()) {
        try {
            const payEntity = await rzp.payments.fetch(razorpayPaymentId);
            if (payEntity && payEntity.status !== "captured") {
                return { success: false, message: `Payment not captured (status: ${payEntity.status}).` };
            }
        } catch (fetchErr) {
            console.warn("Razorpay payment fetch warning:", fetchErr.message);
        }
    }

    const finalAmount = order.pricing?.currentPayable || order.pricing?.totalAmount || 0;
    order.paymentStatus = "COMPLETED";
    order.orderStatus = "PLACED";
    order.razorpayOrderId = razorpayOrderId;
    order.razorpayPaymentId = razorpayPaymentId;
    order.paidAt = new Date();
    order.paymentAttempts = order.paymentAttempts || [];
    order.paymentAttempts.push({
        gateway: "RAZORPAY",
        attemptId: `att_${Date.now()}`,
        razorpayOrderId,
        razorpayPaymentId,
        amount: finalAmount,
        status: "SUCCESS",
        createdAt: new Date(),
    });
    await order.save();

    await Payment.findOneAndUpdate(
        { orderId: order._id },
        {
            orderId: order._id,
            userId,
            amount: finalAmount,
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            razorpayOrderId,
            razorpayPaymentId,
            paidAt: new Date(),
        },
        { upsert: true, new: true }
    );

    try {
        const variantIds = (order.items || []).map((i) => i.variantId);
        await Cart.updateOne(
            { userId },
            { $pull: { items: { variantId: { $in: variantIds } } } }
        );
    } catch (cartErr) {
        console.warn("Cart cleanup warning:", cartErr.message);
    }

    return { success: true, message: "Payment verified successfully.", order };
};

const retryOrderPayment = async (userId, orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    if (order.paymentStatus === "COMPLETED") {
        return { success: true, isAlreadyPaid: true, message: "This order has already been paid successfully.", order };
    }

    if (order.orderStatus === "CANCELLED") {
        return { success: false, message: "This order has been cancelled and cannot be paid." };
    }

    const payableAmount = order.pricing?.currentPayable != null ? order.pricing.currentPayable : order.pricing.totalAmount;
    if (payableAmount <= 0) {
        return { success: false, message: "No payable balance remaining for this order." };
    }

    const razorpayInstance = getRazorpayInstance();
    if (!razorpayInstance || !isRazorpayConfigured()) {
        return { success: false, message: "Payment gateway is not properly configured." };
    }

    try {
        const amountInPaise = Math.round(payableAmount * 100);
        const rzpOrder = await razorpayInstance.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: `${order.orderNumber}_R${Date.now().toString(36).slice(-4)}`,
            notes: {
                orderId: order._id.toString(),
                userId: userId.toString(),
            },
        });

        order.razorpayOrderId = rzpOrder.id;
        order.paymentAttempts = order.paymentAttempts || [];
        order.paymentAttempts.push({
            gateway: "RAZORPAY",
            attemptId: `att_${Date.now()}`,
            razorpayOrderId: rzpOrder.id,
            amount: payableAmount,
            status: "INITIATED",
            createdAt: new Date(),
        });
        await order.save();

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
                    name: `${order.shippingAddress?.firstName || ""} ${order.shippingAddress?.lastName || ""}`.trim(),
                    contact: order.shippingAddress?.phone || "",
                },
            },
            message: "Payment retry initiated.",
        };
    } catch (err) {
        console.error("Razorpay retry order creation error:", err);
        return { success: false, message: "Failed to initiate payment retry with gateway." };
    }
};

const getPaymentStatus = async (userId, orderId) => {
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
        return { success: false, message: "Invalid order ID." };
    }

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
        return { success: false, message: "Order not found." };
    }

    return {
        success: true,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        order,
    };
};

const inspectOrderGatewayPaymentState = async () => {
    return { status: "UNKNOWN", capturedPayment: null, capturedGatewayOrderId: null };
};

const handleRazorpayWebhook = async () => {
    return { success: false, message: "Razorpay webhooks are disabled for this environment." };
};

module.exports = {
    verifyRazorpayPayment,
    retryOrderPayment,
    getPaymentStatus,
    inspectOrderGatewayPaymentState,
    handleRazorpayWebhook,
};
