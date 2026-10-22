const mongoose = require("mongoose");
const Wallet = require("../../models/user/walletModel");
const Transaction = require("../../models/user/transactionModel");

/**
 * Gets or creates the user's wallet document.
 */
const getOrCreateWallet = async (userId) => {
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
        try {
            wallet = await Wallet.create({ userId, balance: 0, appliedOperations: [] });
        } catch (err) {
            // In case of concurrent creation race
            if (err.code === 11000) {
                wallet = await Wallet.findOne({ userId });
            } else {
                throw err;
            }
        }
    }
    return wallet;
};

/**
 * Loads wallet details and paginated transaction history.
 * Ensures currentPage is clamped before calculating skip offset (Finding 40).
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
 * Atomically credits amount to user wallet with unique idempotency reference.
 * Guards duplicate operations atomically directly on the wallet document (Findings 29 & 30).
 */
const creditWallet = async ({
    userId,
    amount,
    reason,
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

    // Check existing transaction if opKey is provided
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

    const updateQuery = {
        _id: wallet._id,
        ...(opKey ? { appliedOperations: { $ne: opKey } } : {}),
    };
    const updateOps = {
        $inc: { balance: numAmount },
        ...(opKey ? { $push: { appliedOperations: opKey } } : {}),
    };

    const updatedWallet = await Wallet.findOneAndUpdate(updateQuery, updateOps, { returnDocument: "after" });

    if (!updatedWallet) {
        // Document matched 0 because opKey was already applied concurrently or previously
        if (opKey) {
            const currentWallet = await Wallet.findById(wallet._id);
            let existingTx = await Transaction.findOne({ referenceId: opKey });
            if (!existingTx && currentWallet) {
                // Reconstruct missing ledger entry from operationsLog
                const loggedOp = (currentWallet.operationsLog || []).find((o) => o.opKey === opKey);
                try {
                    existingTx = await Transaction.create({
                        walletId: currentWallet._id,
                        userId,
                        type: loggedOp?.type || "CREDIT",
                        amount: loggedOp?.amount || numAmount,
                        balanceAfter: loggedOp?.balanceAfter || currentWallet.balance,
                        reason: loggedOp?.reason || reason,
                        description: loggedOp?.description || description,
                        orderId: loggedOp?.orderId || orderId,
                        orderNumber: loggedOp?.orderNumber || orderNumber,
                        referenceId: opKey,
                    });
                } catch (e) {
                    if (e.code === 11000) {
                        existingTx = await Transaction.findOne({ referenceId: opKey });
                    }
                }
            }
            return {
                success: true,
                message: "Transaction already processed.",
                isExisting: true,
                isDuplicate: true,
                balance: currentWallet ? currentWallet.balance : wallet.balance,
                transaction: existingTx,
            };
        }
        return { success: false, message: "Failed to update wallet balance." };
    }

    const finalRefId = opKey || `CR_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const opDetail = {
        opKey: finalRefId,
        type: "CREDIT",
        amount: numAmount,
        balanceAfter: updatedWallet.balance,
        reason,
        description,
        orderId,
        orderNumber,
        createdAt: new Date(),
    };

    await Wallet.updateOne(
        { _id: updatedWallet._id },
        { $push: { operationsLog: opDetail } }
    ).catch(() => {});

    let transaction = null;
    try {
        transaction = await Transaction.create({
            walletId: updatedWallet._id,
            userId,
            type: "CREDIT",
            amount: numAmount,
            balanceAfter: updatedWallet.balance,
            reason,
            description,
            orderId,
            orderNumber,
            referenceId: finalRefId,
        });
    } catch (err) {
        if (err.code === 11000 && opKey) {
            transaction = await Transaction.findOne({ referenceId: opKey });
        } else {
            console.error("Ledger write warning in creditWallet:", err);
            try {
                transaction = await Transaction.create({
                    walletId: updatedWallet._id,
                    userId,
                    type: "CREDIT",
                    amount: numAmount,
                    balanceAfter: updatedWallet.balance,
                    reason,
                    description,
                    orderId,
                    orderNumber,
                    referenceId: finalRefId,
                });
            } catch (recoverErr) {
                if (recoverErr.code === 11000 && opKey) {
                    transaction = await Transaction.findOne({ referenceId: opKey });
                } else {
                    console.error("Secondary ledger creation error:", recoverErr);
                }
            }
        }
    }

    return {
        success: true,
        message: "Wallet credited successfully.",
        balance: updatedWallet.balance,
        transaction,
    };
};

/**
 * Atomically debits amount from user wallet with balance verification ($gte: amount).
 * Guards duplicate operations atomically directly on the wallet document (Findings 29 & 30).
 */
const debitWallet = async ({
    userId,
    amount,
    reason,
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

    // Conditional atomic deduction: only update if balance >= numAmount AND opKey not previously applied
    const updateQuery = {
        _id: wallet._id,
        balance: { $gte: numAmount },
        ...(opKey ? { appliedOperations: { $ne: opKey } } : {}),
    };
    const updateOps = {
        $inc: { balance: -numAmount },
        ...(opKey ? { $push: { appliedOperations: opKey } } : {}),
    };

    const updatedWallet = await Wallet.findOneAndUpdate(updateQuery, updateOps, { returnDocument: "after" });

    if (!updatedWallet) {
        // Check why update failed: was it duplicate opKey or insufficient balance?
        const currentWallet = await Wallet.findById(wallet._id);
        if (opKey && currentWallet && currentWallet.appliedOperations && currentWallet.appliedOperations.includes(opKey)) {
            let existingTx = await Transaction.findOne({ referenceId: opKey });
            if (!existingTx) {
                // Reconstruct missing ledger entry from operationsLog
                const loggedOp = (currentWallet.operationsLog || []).find((o) => o.opKey === opKey);
                try {
                    existingTx = await Transaction.create({
                        walletId: currentWallet._id,
                        userId,
                        type: loggedOp?.type || "DEBIT",
                        amount: loggedOp?.amount || numAmount,
                        balanceAfter: loggedOp?.balanceAfter || currentWallet.balance,
                        reason: loggedOp?.reason || reason,
                        description: loggedOp?.description || description,
                        orderId: loggedOp?.orderId || orderId,
                        orderNumber: loggedOp?.orderNumber || orderNumber,
                        referenceId: opKey,
                    });
                } catch (e) {
                    if (e.code === 11000) {
                        existingTx = await Transaction.findOne({ referenceId: opKey });
                    }
                }
            }
            return {
                success: true,
                message: "Transaction already processed.",
                isExisting: true,
                isDuplicate: true,
                balance: currentWallet.balance,
                transaction: existingTx,
            };
        }

        const bal = currentWallet ? currentWallet.balance : wallet.balance;
        return {
            success: false,
            message: `Insufficient wallet balance. Current balance is ₹${bal.toLocaleString("en-IN")}, but ₹${numAmount.toLocaleString("en-IN")} is required.`,
            currentBalance: bal,
            requiredAmount: numAmount,
        };
    }

    const finalRefId = opKey || `DB_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const opDetail = {
        opKey: finalRefId,
        type: "DEBIT",
        amount: numAmount,
        balanceAfter: updatedWallet.balance,
        reason,
        description,
        orderId,
        orderNumber,
        createdAt: new Date(),
    };

    await Wallet.updateOne(
        { _id: updatedWallet._id },
        { $push: { operationsLog: opDetail } }
    ).catch(() => {});

    let transaction = null;
    try {
        transaction = await Transaction.create({
            walletId: updatedWallet._id,
            userId,
            type: "DEBIT",
            amount: numAmount,
            balanceAfter: updatedWallet.balance,
            reason,
            description,
            orderId,
            orderNumber,
            referenceId: finalRefId,
        });
    } catch (err) {
        if (err.code === 11000 && opKey) {
            transaction = await Transaction.findOne({ referenceId: opKey });
        } else {
            console.error("Ledger write warning in debitWallet:", err);
            try {
                transaction = await Transaction.create({
                    walletId: updatedWallet._id,
                    userId,
                    type: "DEBIT",
                    amount: numAmount,
                    balanceAfter: updatedWallet.balance,
                    reason,
                    description,
                    orderId,
                    orderNumber,
                    referenceId: finalRefId,
                });
            } catch (recoverErr) {
                if (recoverErr.code === 11000 && opKey) {
                    transaction = await Transaction.findOne({ referenceId: opKey });
                } else {
                    console.error("Secondary debit ledger creation error:", recoverErr);
                }
            }
        }
    }

    return {
        success: true,
        message: "Wallet debited successfully.",
        balance: updatedWallet.balance,
        transaction,
    };
};

module.exports = {
    getOrCreateWallet,
    getWalletDetails,
    creditWallet,
    debitWallet,
};
