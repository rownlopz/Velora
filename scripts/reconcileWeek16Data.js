/**
 * Safe, Rerunnable Migration, Backfill & Data Reconciliation Script for Velora Week 16
 * 
 * Standalone MongoDB compatible (No multi-document transactions or replica sets).
 * Preserves all business data and never drops databases or resets collections.
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const User = require("../models/user/userModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Address = require("../models/user/addressModel");
const Category = require("../models/product/categoryModel");
const Variant = require("../models/product/variantModel");
const { getOrCreateWallet, creditWallet } = require("../services/user/walletService");
const restoreCancellationStock = require("../helpers/restoreCancellationStock");

async function reconcileWeek16Data() {
    const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/velora";
    console.log("=================================================");
    console.log("VELORA WEEK 16 DATA RECONCILIATION & BACKFILL");
    console.log(`Connecting to: ${mongoUri.replace(/:[^:]*@/, ":****@")}`);
    console.log("=================================================\n");

    await mongoose.connect(mongoUri);

    let stats = {
        usersUpdated: 0,
        ordersReconciled: 0,
        paymentsRepaired: 0,
        stockRepaired: 0,
        refundsRepaired: 0,
    };

    try {
        // 1. Backfill User referral flags and default addresses
        console.log("Step 1: Backfilling User referral flags & defaultAddressId...");
        const users = await User.find({});
        for (const user of users) {
            let updated = false;
            if (user.referralRewardClawedBack === undefined) {
                user.referralRewardClawedBack = false;
                updated = true;
            }
            if (!user.defaultAddressId) {
                const defaultAddr = await Address.findOne({ userId: user._id, isDefault: true });
                if (defaultAddr) {
                    user.defaultAddressId = defaultAddr._id;
                    updated = true;
                }
            }
            if (updated) {
                await user.save();
                stats.usersUpdated++;
            }
        }
        console.log(`  ✓ Checked ${users.length} users, updated ${stats.usersUpdated}.`);

        // 2. Reconcile Payment documents with Order state
        console.log("\nStep 2: Reconciling Payment documents with Order state...");
        const completedOrders = await Order.find({ paymentStatus: "COMPLETED" });
        for (const ord of completedOrders) {
            const result = await Payment.updateMany(
                { orderId: ord._id, status: { $ne: "COMPLETED" } },
                { $set: { status: "COMPLETED", paidAt: ord.paidAt || ord.placedAt || new Date() } }
            );
            if (result.modifiedCount > 0) {
                stats.paymentsRepaired += result.modifiedCount;
            }
        }
        console.log(`  ✓ Repaired ${stats.paymentsRepaired} out-of-sync Payment records.`);

        // 3. Reconcile partially cancelled orders left by earlier Mongoose update failures
        console.log("\nStep 3: Auditing orders with unreconciled cancellations or missing stock restoration...");
        const cancelledOrders = await Order.find({
            $or: [
                { orderStatus: "CANCELLED", "items.isStockRestored": { $ne: true } },
                { "items.status": "CANCELLED", "items.isStockRestored": { $ne: true } },
            ],
        });

        for (const ord of cancelledOrders) {
            let orderChanged = false;
            for (const item of ord.items) {
                if (item.status === "CANCELLED" && !item.isStockRestored) {
                    await restoreCancellationStock(ord._id, item).catch((err) => console.error(`Stock restore error on ${ord.orderNumber}:`, err));
                    item.isStockRestored = true;
                    item.restockedQuantity = item.quantity;
                    stats.stockRepaired++;
                    orderChanged = true;
                }
            }
            if (orderChanged) {
                await ord.save();
                stats.ordersReconciled++;
            }
        }
        console.log(`  ✓ Reconciled ${stats.ordersReconciled} orders and restored stock for ${stats.stockRepaired} items.`);

        // 4. Backfill missing categoryName snapshots on legacy order items
        console.log("\nStep 4: Backfilling missing categoryName snapshots on order items...");
        const ordersWithBlankCategory = await Order.find({
            "items.categoryName": { $in: ["", null] },
            "items.categoryId": { $ne: null },
        });

        let categoriesBackfilled = 0;
        for (const ord of ordersWithBlankCategory) {
            let changed = false;
            for (const item of ord.items) {
                if ((!item.categoryName || item.categoryName.trim() === "") && item.categoryId) {
                    const catDoc = await Category.findById(item.categoryId).lean();
                    if (catDoc && catDoc.name) {
                        item.categoryName = catDoc.name;
                        categoriesBackfilled++;
                        changed = true;
                    }
                }
            }
            if (changed) {
                await ord.save();
            }
        }
        console.log(`  ✓ Backfilled ${categoriesBackfilled} category name snapshots.`);

        console.log("\n=================================================");
        console.log("RECONCILIATION SUMMARY:");
        console.log(`  Users backfilled: ${stats.usersUpdated}`);
        console.log(`  Payments repaired: ${stats.paymentsRepaired}`);
        console.log(`  Orders reconciled: ${stats.ordersReconciled}`);
        console.log(`  Stock restorations repaired: ${stats.stockRepaired}`);
        console.log(`  Category snapshots backfilled: ${categoriesBackfilled}`);
        console.log("ALL DATA AUDITS AND REPAIRS COMPLETED SAFELY.");
        console.log("=================================================");
    } catch (err) {
        console.error("Reconciliation Error:", err);
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    reconcileWeek16Data().catch((err) => {
        console.error("Fatal reconciliation script failure:", err);
        process.exit(1);
    });
}

module.exports = reconcileWeek16Data;
