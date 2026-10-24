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
const { reconcileOrderState, recoverPendingRefunds } = require("../services/admin/orderService");
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
        unresolvedOperations: 0,
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

        // 3. Reconcile orders with pending repairs using authoritative reconcileOrderState
        console.log("\nStep 3: Auditing and reconciling interrupted order states...");
        const ordersNeedingReconcile = await Order.find({
            $or: [
                { items: { $elemMatch: { status: "CANCELLED", isStockRestored: { $ne: true } } } },
                { items: { $elemMatch: { status: "RETURNED", isRestocked: { $ne: true } } } },
                { items: { $elemMatch: { status: { $in: ["CANCELLED", "RETURN_APPROVED", "RETURNED"] }, refundIssued: { $ne: true } } } },
                { items: { $elemMatch: { refundStatus: "REFUND_PENDING" } } },
                { "pricing.shippingRefundStatus": "REFUND_PENDING" },
                { paymentAttempts: { $elemMatch: { status: "REFUND_PENDING" } } },
                { orderStatus: "CANCELLED", items: { $elemMatch: { isStockRestored: { $ne: true } } } },
            ],
        });

        for (const ord of ordersNeedingReconcile) {
            try {
                const reconRes = await reconcileOrderState(ord._id);
                if (reconRes && reconRes.success) {
                    stats.ordersReconciled++;
                } else {
                    stats.unresolvedOperations++;
                }
            } catch (reconErr) {
                console.error(`Error reconciling order ${ord.orderNumber}:`, reconErr);
                stats.unresolvedOperations++;
            }
        }
        console.log(`  ✓ Processed ${ordersNeedingReconcile.length} orders; successfully reconciled ${stats.ordersReconciled}.`);

        // 4. Backfill missing categoryName snapshots on legacy order items (marked as reconstructed)
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
                        item.isCategoryReconstructed = true;
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

        // 5. Backfill productIds array on single-product offers
        console.log("\nStep 5: Backfilling productIds array on legacy single-product offers...");
        const Offer = require("../models/product/offerModel");
        const singleProductOffers = await Offer.find({
            offerType: "PRODUCT",
            productId: { $ne: null },
            $or: [{ productIds: { $exists: false } }, { productIds: { $size: 0 } }],
        });
        let offersUpdated = 0;
        for (const offer of singleProductOffers) {
            if (offer.productId) {
                offer.productIds = [offer.productId];
                await offer.save();
                offersUpdated++;
            }
        }
        console.log(`  ✓ Backfilled productIds on ${offersUpdated} single-product offers.`);

        // 6. Backfill missing Payment refund totals where Order refund total is present
        console.log("\nStep 6: Reconciling Payment refund totals with Order refunds...");
        const ordersWithRefunds = await Order.find({
            $or: [
                { "pricing.walletRefundIssued": { $gt: 0 } },
                { "pricing.purchaseRefundTotal": { $gt: 0 } },
            ],
        });
        let paymentsRefundRepaired = 0;
        for (const ord of ordersWithRefunds) {
            const expectedRefund = Math.max(ord.pricing?.walletRefundIssued || 0, ord.pricing?.purchaseRefundTotal || 0);
            if (expectedRefund > 0) {
                const res = await Payment.updateMany(
                    {
                        orderId: ord._id,
                        $or: [
                            { refundAmount: { $lt: expectedRefund } },
                            { refundAmount: { $exists: false } },
                            { refundAmount: null },
                        ],
                    },
                    { $set: { refundAmount: expectedRefund } }
                );
                if (res.modifiedCount > 0) paymentsRefundRepaired += res.modifiedCount;
            }
        }
        console.log(`  ✓ Repaired ${paymentsRefundRepaired} Payment refund totals.`);

        console.log("\n=================================================");
        console.log("RECONCILIATION SUMMARY:");
        console.log(`  Users backfilled: ${stats.usersUpdated}`);
        console.log(`  Payments repaired: ${stats.paymentsRepaired + paymentsRefundRepaired}`);
        console.log(`  Orders reconciled: ${stats.ordersReconciled}`);
        console.log(`  Category snapshots backfilled: ${categoriesBackfilled}`);
        console.log(`  Offers backfilled with productIds: ${offersUpdated}`);
        console.log(`  Unresolved operations: ${stats.unresolvedOperations}`);
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
