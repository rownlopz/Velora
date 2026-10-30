const mongoose = require("mongoose");
const Wallet = require("../../models/user/walletModel");
const Transaction = require("../../models/user/transactionModel");

/**
 * 1. Get or create wallet for user
 */
const getOrCreateWallet = async (userId) => {
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
        wallet = await Wallet.create({ userId, balance: 0 });
    }
    return wallet;
};

/**
 * 2. Get wallet details with paginated transactions
 */
const getWalletDetails = async (userId, options = {}) => {
    const { page = 1, limit = 10 } = options;
    const wallet = await getOrCreateWallet(userId);

    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedLimit = Math.max(1, Math.min(50, Number(limit) || 10));

    const totalTransactions = await Transaction.countDocuments({ userId });
    const totalPages = Math.ceil(totalTransactions / parsedLimit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const skip = (currentPage - 1) * parsedLimit;

    const transactions = await Transaction.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean();

    return {
        success: true,
        balance: wallet.balance,
        currency: wallet.currency || "INR",
        transactions,
        totalTransactions,
        totalPages,
        currentPage,
    };
};

/**
 * 3. Credit wallet atomically
 */
const creditWallet = async ({
    userId,
    amount,
    reason = "ORDER_REFUND",
    description = "",
    orderId = null,
    orderNumber = null,
    referenceId = null,
}) => {
    const numAmount = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
        return { success: false, message: "Invalid credit amount." };
    }

    const opKey = referenceId ? String(referenceId).trim() : null;

    // Check for duplicate operation if referenceId provided
    if (opKey) {
        const existingTx = await Transaction.findOne({ referenceId: opKey });
        if (existingTx) {
            const currentWallet = await getOrCreateWallet(userId);
            return {
                success: true,
                message: "Transaction already processed.",
                isExisting: true,
                isDuplicate: true,
                balance: currentWallet.balance,
                transaction: existingTx,
            };
        }
    }

    const wallet = await getOrCreateWallet(userId);

    const updatedWallet = await Wallet.findByIdAndUpdate(
        wallet._id,
        {
            $inc: { balance: numAmount },
            ...(opKey ? { $addToSet: { appliedOperations: opKey } } : {}),
        },
        { returnDocument: "after" }
    );

    const tx = await Transaction.create({
        walletId: updatedWallet._id,
        userId,
        type: "CREDIT",
        amount: numAmount,
        balanceAfter: updatedWallet.balance,
        reason,
        description: description || "Wallet credited",
        orderId,
        orderNumber,
        referenceId: opKey || `TXN_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    });

    return {
        success: true,
        balance: updatedWallet.balance,
        transaction: tx,
    };
};

/**
 * 4. Debit wallet atomically
 */
const debitWallet = async ({
    userId,
    amount,
    reason = "ORDER_PURCHASE",
    description = "",
    orderId = null,
    orderNumber = null,
    referenceId = null,
}) => {
    const numAmount = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
        return { success: false, message: "Invalid debit amount." };
    }

    const opKey = referenceId ? String(referenceId).trim() : null;

    // Check for duplicate operation if referenceId provided
    if (opKey) {
        const existingTx = await Transaction.findOne({ referenceId: opKey });
        if (existingTx) {
            const currentWallet = await getOrCreateWallet(userId);
            return {
                success: true,
                message: "Transaction already processed.",
                isExisting: true,
                isDuplicate: true,
                balance: currentWallet.balance,
                transaction: existingTx,
            };
        }
    }

    const wallet = await getOrCreateWallet(userId);

    const updatedWallet = await Wallet.findOneAndUpdate(
        { _id: wallet._id, balance: { $gte: numAmount } },
        {
            $inc: { balance: -numAmount },
            ...(opKey ? { $addToSet: { appliedOperations: opKey } } : {}),
        },
        { returnDocument: "after" }
    );

    if (!updatedWallet) {
        return {
            success: false,
            message: `Insufficient wallet balance (₹${wallet.balance.toFixed(2)}). Required: ₹${numAmount.toFixed(2)}.`,
        };
    }

    const tx = await Transaction.create({
        walletId: updatedWallet._id,
        userId,
        type: "DEBIT",
        amount: numAmount,
        balanceAfter: updatedWallet.balance,
        reason,
        description: description || "Wallet debited",
        orderId,
        orderNumber,
        referenceId: opKey || `TXN_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    });

    return {
        success: true,
        balance: updatedWallet.balance,
        transaction: tx,
    };
};

module.exports = {
    getOrCreateWallet,
    getWalletDetails,
    creditWallet,
    debitWallet,
};
