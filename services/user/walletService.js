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
            wallet = await Wallet.create({ userId, balance: 0, appliedOperations: [], operationsLog: [] });
        } catch (err) {
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
 * Financial effect, duplicate guard, and recovery details are written atomically in one update.
 * Validates duplicate operations against original persisted facts and rejects conflicting reuse.
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
            // Validate against conflicting reuse of operation ID
            if (existingTx.type !== "CREDIT" || Math.abs(existingTx.amount - numAmount) > 0.001 || existingTx.userId.toString() !== userId.toString()) {
                return {
                    success: false,
                    message: `Conflicting reuse of operation ID "${opKey}". Original transaction: ${existingTx.type} ₹${existingTx.amount} for user ${existingTx.userId}.`,
                };
            }
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

    // If opKey was already recorded on the wallet document
    if (opKey && wallet.appliedOperations && wallet.appliedOperations.includes(opKey)) {
        const loggedOp = (wallet.operationsLog || []).find((o) => o.opKey === opKey);
        if (loggedOp) {
            // Validate conflicting reuse against original facts
            if (loggedOp.type !== "CREDIT" || Math.abs(loggedOp.amount - numAmount) > 0.001) {
                return {
                    success: false,
                    message: `Conflicting reuse of operation ID "${opKey}". Original log: ${loggedOp.type} ₹${loggedOp.amount}.`,
                };
            }
        }

        // Reconstruct missing ledger entry from original immutable facts, never retry input
        let existingTx = await Transaction.findOne({ referenceId: opKey });
        if (!existingTx) {
            const reconstructedBalanceAfter = loggedOp?.balanceAfter != null ? loggedOp.balanceAfter : wallet.balance;
            const reconstructedAmount = loggedOp?.amount != null ? loggedOp.amount : numAmount;
            try {
                existingTx = await Transaction.create({
                    walletId: wallet._id,
                    userId,
                    type: loggedOp?.type || "CREDIT",
                    amount: reconstructedAmount,
                    balanceAfter: reconstructedBalanceAfter,
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
            balance: wallet.balance,
            transaction: existingTx,
        };
    }

    const finalRefId = opKey || `CR_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = new Date();

    // Atomic pipeline update: records financial effect, duplicate guard, and recovery details in one single write
    const updatePipeline = [
        {
            $set: {
                balance: { $round: [{ $add: ["$balance", numAmount] }, 2] },
                appliedOperations: opKey
                    ? { $concatArrays: [{ $ifNull: ["$appliedOperations", []] }, [opKey]] }
                    : { $ifNull: ["$appliedOperations", []] },
                operationsLog: {
                    $concatArrays: [
                        { $ifNull: ["$operationsLog", []] },
                        [
                            {
                                opKey: finalRefId,
                                type: "CREDIT",
                                amount: numAmount,
                                balanceAfter: { $round: [{ $add: ["$balance", numAmount] }, 2] },
                                reason: reason || "CREDIT",
                                description: description || "",
                                orderId: orderId || null,
                                orderNumber: orderNumber || null,
                                createdAt: now,
                            },
                        ],
                    ],
                },
            },
        },
    ];

    const updateQuery = {
        _id: wallet._id,
        ...(opKey ? { appliedOperations: { $ne: opKey } } : {}),
    };

    const updatedWallet = await Wallet.findOneAndUpdate(updateQuery, updatePipeline, {
        returnDocument: "after",
        updatePipeline: true,
    });

    if (!updatedWallet) {
        // Matched 0 because opKey was applied concurrently
        if (opKey) {
            const currentWallet = await Wallet.findById(wallet._id);
            const loggedOp = (currentWallet?.operationsLog || []).find((o) => o.opKey === opKey);
            if (loggedOp) {
                if (loggedOp.type !== "CREDIT" || Math.abs(loggedOp.amount - numAmount) > 0.001) {
                    return {
                        success: false,
                        message: `Conflicting reuse of operation ID "${opKey}". Original: ${loggedOp.type} ₹${loggedOp.amount}.`,
                    };
                }
            }
            let existingTx = await Transaction.findOne({ referenceId: opKey });
            if (!existingTx && currentWallet) {
                const reconstructedBalanceAfter = loggedOp?.balanceAfter != null ? loggedOp.balanceAfter : currentWallet.balance;
                const reconstructedAmount = loggedOp?.amount != null ? loggedOp.amount : numAmount;
                try {
                    existingTx = await Transaction.create({
                        walletId: currentWallet._id,
                        userId,
                        type: loggedOp?.type || "CREDIT",
                        amount: reconstructedAmount,
                        balanceAfter: reconstructedBalanceAfter,
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
 * Financial effect, duplicate guard, and recovery details are written atomically in one update.
 * Validates duplicate operations against original persisted facts and rejects conflicting reuse.
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
            if (existingTx.type !== "DEBIT" || Math.abs(existingTx.amount - numAmount) > 0.001 || existingTx.userId.toString() !== userId.toString()) {
                return {
                    success: false,
                    message: `Conflicting reuse of operation ID "${opKey}". Original transaction: ${existingTx.type} ₹${existingTx.amount} for user ${existingTx.userId}.`,
                };
            }
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

    if (opKey && wallet.appliedOperations && wallet.appliedOperations.includes(opKey)) {
        const loggedOp = (wallet.operationsLog || []).find((o) => o.opKey === opKey);
        if (loggedOp) {
            if (loggedOp.type !== "DEBIT" || Math.abs(loggedOp.amount - numAmount) > 0.001) {
                return {
                    success: false,
                    message: `Conflicting reuse of operation ID "${opKey}". Original log: ${loggedOp.type} ₹${loggedOp.amount}.`,
                };
            }
        }

        let existingTx = await Transaction.findOne({ referenceId: opKey });
        if (!existingTx) {
            const reconstructedBalanceAfter = loggedOp?.balanceAfter != null ? loggedOp.balanceAfter : wallet.balance;
            const reconstructedAmount = loggedOp?.amount != null ? loggedOp.amount : numAmount;
            try {
                existingTx = await Transaction.create({
                    walletId: wallet._id,
                    userId,
                    type: loggedOp?.type || "DEBIT",
                    amount: reconstructedAmount,
                    balanceAfter: reconstructedBalanceAfter,
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
            balance: wallet.balance,
            transaction: existingTx,
        };
    }

    // Check balance before attempting update
    if (wallet.balance < numAmount) {
        return {
            success: false,
            message: `Insufficient wallet balance. Current balance is ₹${wallet.balance.toLocaleString("en-IN")}, but ₹${numAmount.toLocaleString("en-IN")} is required.`,
            currentBalance: wallet.balance,
            requiredAmount: numAmount,
        };
    }

    const finalRefId = opKey || `DB_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = new Date();

    const updatePipeline = [
        {
            $set: {
                balance: { $round: [{ $subtract: ["$balance", numAmount] }, 2] },
                appliedOperations: opKey
                    ? { $concatArrays: [{ $ifNull: ["$appliedOperations", []] }, [opKey]] }
                    : { $ifNull: ["$appliedOperations", []] },
                operationsLog: {
                    $concatArrays: [
                        { $ifNull: ["$operationsLog", []] },
                        [
                            {
                                opKey: finalRefId,
                                type: "DEBIT",
                                amount: numAmount,
                                balanceAfter: { $round: [{ $subtract: ["$balance", numAmount] }, 2] },
                                reason: reason || "DEBIT",
                                description: description || "",
                                orderId: orderId || null,
                                orderNumber: orderNumber || null,
                                createdAt: now,
                            },
                        ],
                    ],
                },
            },
        },
    ];

    const updateQuery = {
        _id: wallet._id,
        balance: { $gte: numAmount },
        ...(opKey ? { appliedOperations: { $ne: opKey } } : {}),
    };

    const updatedWallet = await Wallet.findOneAndUpdate(updateQuery, updatePipeline, {
        returnDocument: "after",
        updatePipeline: true,
    });

    if (!updatedWallet) {
        const currentWallet = await Wallet.findById(wallet._id);
        if (opKey && currentWallet && currentWallet.appliedOperations && currentWallet.appliedOperations.includes(opKey)) {
            const loggedOp = (currentWallet.operationsLog || []).find((o) => o.opKey === opKey);
            if (loggedOp) {
                if (loggedOp.type !== "DEBIT" || Math.abs(loggedOp.amount - numAmount) > 0.001) {
                    return {
                        success: false,
                        message: `Conflicting reuse of operation ID "${opKey}". Original: ${loggedOp.type} ₹${loggedOp.amount}.`,
                    };
                }
            }
            let existingTx = await Transaction.findOne({ referenceId: opKey });
            if (!existingTx) {
                const reconstructedBalanceAfter = loggedOp?.balanceAfter != null ? loggedOp.balanceAfter : currentWallet.balance;
                const reconstructedAmount = loggedOp?.amount != null ? loggedOp.amount : numAmount;
                try {
                    existingTx = await Transaction.create({
                        walletId: currentWallet._id,
                        userId,
                        type: loggedOp?.type || "DEBIT",
                        amount: reconstructedAmount,
                        balanceAfter: reconstructedBalanceAfter,
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
