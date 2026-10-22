const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
    {
        walletId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Wallet",
            required: true,
            index: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        type: {
            type: String,
            enum: ["CREDIT", "DEBIT"],
            required: true,
        },
        amount: {
            type: Number,
            required: true,
            min: [0, "Transaction amount cannot be negative."],
        },
        balanceAfter: {
            type: Number,
            required: true,
            min: [0, "Balance after transaction cannot be negative."],
        },
        reason: {
            type: String,
            enum: [
                "ORDER_PAYMENT",
                "ORDER_PURCHASE",
                "ORDER_PURCHASE_ROLLBACK",
                "CANCELLATION_REFUND",
                "ORDER_CANCELLATION",
                "RETURN_REFUND",
                "ORDER_RETURN",
                "ORDER_REFUND",
                "REFERRAL_REWARD",
                "ADMIN_ADJUSTMENT",
                "REFERRAL_CLAWBACK",
                "BONUS",
            ],
            required: true,
        },
        description: {
            type: String,
            trim: true,
            default: "",
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order",
            default: null,
            index: true,
        },
        orderNumber: {
            type: String,
            default: null,
        },
        referenceId: {
            type: String,
            unique: true,
            sparse: true,
            index: true,
        },
    },
    {
        timestamps: true,
    }
);

transactionSchema.index({ userId: 1, createdAt: -1 });

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;
