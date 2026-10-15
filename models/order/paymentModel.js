const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
    {
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order",
            required: true,
            index: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        amount: {
            type: Number,
            required: true,
            min: 0,
        },
        paymentMethod: {
            type: String,
            enum: ["COD", "ONLINE", "WALLET"],
            default: "COD",
        },
        status: {
            type: String,
            enum: ["PENDING", "COMPLETED", "FAILED", "REFUNDED", "CANCELLED"],
            default: "PENDING",
        },
        transactionId: {
            type: String,
            default: null,
        },
        paidAt: {
            type: Date,
            default: null,
        },
        refundedAt: {
            type: Date,
            default: null,
        },
        refundAmount: {
            type: Number,
            default: 0,
            min: 0,
        },
    },
    {
        timestamps: true,
    }
);

const Payment = mongoose.model("Payment", paymentSchema);

module.exports = Payment;
