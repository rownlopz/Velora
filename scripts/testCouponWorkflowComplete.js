/**
 * scripts/testCouponWorkflowComplete.js
 * Comprehensive automated verification of the entire coupon workflow
 * on the isolated test database (velora_test_isolated_suite).
 */

const mongoose = require("mongoose");
const assert = require("assert");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const Coupon = require("../models/order/couponModel");
const User = require("../models/user/userModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Category = require("../models/product/categoryModel");
const Cart = require("../models/order/cartModel");
const Order = require("../models/order/orderModel");
const Address = require("../models/user/addressModel");

const couponService = require("../services/admin/couponService");
const cartService = require("../services/user/cartService");
const pricingService = require("../services/common/pricingService");
const orderService = require("../services/user/orderService");

async function runTests() {
    console.log("Connecting to isolated test database...");
    await mongoose.connect(TEST_DB_URI);

    let testUser = await User.findOne({ email: "shopper@velora.test" });
    if (!testUser) {
        testUser = await User.create({
            fullName: "Test Customer",
            email: "shopper@velora.test",
            password: "Password123!",
            phone: "9876543210",
        });
    }

    let testUser2 = await User.findOne({ email: "shopper2@velora.test" });
    if (!testUser2) {
        testUser2 = await User.create({
            fullName: "Second Customer",
            email: "shopper2@velora.test",
            password: "Password123!",
            phone: "9876543211",
        });
    }

    console.log("\n=======================================================");
    console.log("STEP 1 & 2: ADMIN COUPON CREATION & VALIDATION TESTS");
    console.log("=======================================================");

    // Clean up test coupons
    await Coupon.deleteMany({});

    // Test 1: Reject percentage > 100%
    console.log("\nTest 1: Reject percentage discount > 100%");
    const res1 = await couponService.createCoupon({
        code: "INVALID101",
        discountType: "PERCENTAGE",
        discountValue: 101,
        minPurchase: 500,
        startDate: "2026-10-01",
        endDate: "2026-11-30",
    });
    assert.strictEqual(res1.success, false, "Must reject percentage > 100%");
    console.log("  PASS: Rejected percentage > 100% with message:", res1.message);

    // Test 2: Reject negative minPurchase
    console.log("\nTest 2: Reject negative minPurchase");
    const res2 = await couponService.createCoupon({
        code: "INVALIDMIN",
        discountType: "PERCENTAGE",
        discountValue: 20,
        minPurchase: -10,
        startDate: "2026-10-01",
        endDate: "2026-11-30",
    });
    assert.strictEqual(res2.success, false, "Must reject negative minPurchase");
    console.log("  PASS: Rejected negative minPurchase with message:", res2.message);

    // Test 3: Reject startDate after endDate
    console.log("\nTest 3: Reject startDate after endDate");
    const res3 = await couponService.createCoupon({
        code: "INVALDATE",
        discountType: "FLAT",
        discountValue: 50,
        minPurchase: 200,
        startDate: "2026-12-01",
        endDate: "2026-11-01",
    });
    assert.strictEqual(res3.success, false, "Must reject inverted dates");
    console.log("  PASS: Rejected inverted dates with message:", res3.message);

    // Test 4: Successfully create valid percentage coupon with uppercase normalization
    console.log("\nTest 4: Successfully create valid percentage coupon with code normalization");
    const res4 = await couponService.createCoupon({
        code: "  testperc20  ",
        description: "Test 20 percentage discount coupon",
        discountType: "PERCENTAGE",
        discountValue: 20,
        minPurchase: 500,
        maxDiscount: 150,
        usageLimit: 10,
        perUserLimit: 1,
        startDate: "2026-10-01",
        endDate: "2026-11-30",
    });
    assert.strictEqual(res4.success, true, "Must successfully create valid coupon");
    const cpn1 = await Coupon.findOne({ code: "TESTPERC20" });
    assert.ok(cpn1, "Coupon must exist in DB normalized to uppercase");
    assert.strictEqual(cpn1.discountValue, 20);
    assert.strictEqual(cpn1.maxDiscount, 150);
    assert.strictEqual(cpn1.usageLimit, 10);
    assert.strictEqual(cpn1.perUserLimit, 1);
    console.log("  PASS: Created TESTPERC20 with normalized code and fields.");

    // Test 5: Reject duplicate code (case and whitespace variations)
    console.log("\nTest 5: Reject duplicate coupon code (case and whitespace variations)");
    const res5 = await couponService.createCoupon({
        code: "testperc20",
        discountType: "PERCENTAGE",
        discountValue: 15,
        startDate: "2026-10-01",
        endDate: "2026-11-30",
    });
    assert.strictEqual(res5.success, false, "Must reject duplicate code");
    console.log("  PASS: Duplicate rejection message:", res5.message);

    // Test 6: Successfully create flat coupon with blank maxDiscount and blank usageLimit
    console.log("\nTest 6: Create flat coupon with blank optional fields");
    const res6 = await couponService.createCoupon({
        code: "FLAT100",
        description: "Flat 100 off on 500+",
        discountType: "FLAT",
        discountValue: 100,
        minPurchase: 500,
        maxDiscount: "",
        usageLimit: "",
        perUserLimit: 2,
        startDate: "2026-10-01",
        endDate: "2026-11-30",
    });
    assert.strictEqual(res6.success, true);
    const cpn2 = await Coupon.findOne({ code: "FLAT100" });
    assert.ok(cpn2);
    assert.strictEqual(cpn2.maxDiscount, null, "Blank maxDiscount must resolve to null");
    assert.strictEqual(cpn2.usageLimit, null, "Blank usageLimit must resolve to null (unlimited)");
    console.log("  PASS: Created FLAT100 with null maxDiscount and unlimited usage.");

    // Test 7: Verify Asia/Kolkata date policy on end date
    console.log("\nTest 7: Verify Asia/Kolkata date policy (end date covers whole day)");
    // End date is 2026-11-30. In UTC, 23:59:59.999+05:30 is 18:29:59.999Z on 2026-11-30
    assert.ok(cpn2.endDate.toISOString().includes("2026-11-30T18:29:59"), "End date must capture end-of-day in Asia/Kolkata");
    console.log("  PASS: Asia/Kolkata end date boundary stored:", cpn2.endDate.toISOString());

    console.log("\n=======================================================");
    console.log("STEP 3: ADMIN LISTING, FILTERING & STATUS TESTS");
    console.log("=======================================================");

    // Test 8: Listing, search and status filter
    console.log("\nTest 8: Admin coupon listing, search, and status filtering");
    const listAll = await couponService.getCoupons({ search: "", status: "ALL", page: 1, limit: 10 });
    assert.strictEqual(listAll.totalCoupons, 2, "Should have 2 active coupons");

    const searchCode = await couponService.getCoupons({ search: "FLAT", status: "ALL", page: 1, limit: 10 });
    assert.strictEqual(searchCode.totalCoupons, 1);
    assert.strictEqual(searchCode.coupons[0].code, "FLAT100");

    const searchDesc = await couponService.getCoupons({ search: "percentage", status: "ALL", page: 1, limit: 10 });
    assert.strictEqual(searchDesc.totalCoupons, 1);
    assert.strictEqual(searchDesc.coupons[0].code, "TESTPERC20");
    console.log("  PASS: Admin listing and search by code and description works.");

    // Test 9: Toggle status
    console.log("\nTest 9: Toggle coupon status");
    const toggleRes = await couponService.toggleCouponStatus(cpn2._id);
    assert.strictEqual(toggleRes.success, true);
    assert.strictEqual(toggleRes.isActive, false);

    const checkInactive = await couponService.getCoupons({ search: "", status: "INACTIVE", page: 1, limit: 10 });
    assert.strictEqual(checkInactive.totalCoupons, 1);
    assert.strictEqual(checkInactive.coupons[0].code, "FLAT100");

    // Toggle back to active
    await couponService.toggleCouponStatus(cpn2._id);
    console.log("  PASS: Coupon status toggled between ACTIVE and INACTIVE.");

    console.log("\n=======================================================");
    console.log("STEP 4: CART & CHECKOUT COUPON WORKFLOW TESTS");
    console.log("=======================================================");

    // Find products and setup cart
    const prod1 = await Product.findOne({ slug: "classic-crew-tshirt" });
    const variant1 = await Variant.findOne({ productId: prod1._id });

    // Set up cart with 1 variant: 699 price
    await Cart.findOneAndUpdate(
        { userId: testUser._id },
        {
            $set: {
                items: [{ variantId: variant1._id, quantity: 1, priceSnapshot: 699 }],
                appliedCoupon: null,
            },
        },
        { upsert: true }
    );

    // Test 10: Apply valid percentage coupon
    console.log("\nTest 10: Apply valid percentage coupon (TESTPERC20: 20% capped at 150, min purchase 500)");
    // 20% of 699 = 139.80. 139.80 <= 150 cap.
    const applyRes1 = await cartService.applyCoupon(testUser._id, "testperc20");
    assert.strictEqual(applyRes1.success, true);
    assert.strictEqual(applyRes1.details.couponDiscount, 139.8);
    assert.strictEqual(applyRes1.details.subtotal, 699);
    assert.strictEqual(applyRes1.details.taxableAmount, 559.2); // 699 - 139.8 = 559.20
    assert.strictEqual(applyRes1.details.taxAmount, 27.96); // 5% of 559.20 = 27.96
    assert.strictEqual(applyRes1.details.shippingFee, 100); // 699 < 1000
    assert.strictEqual(applyRes1.details.totalAmount, 687.16); // 559.20 + 27.96 + 100 = 687.16
    console.log("  PASS: Applied TESTPERC20. Subtotal: 699, Discount: 139.8, Taxable: 559.2, Tax: 27.96, Shipping: 100, Total: 687.16");

    // Test 11: Applying same coupon twice does not stack
    console.log("\nTest 11: Applying same coupon twice does not stack");
    const applyTwice = await cartService.applyCoupon(testUser._id, "TESTPERC20");
    assert.strictEqual(applyTwice.success, true);
    assert.strictEqual(applyTwice.details.couponDiscount, 139.8, "Discount must not double");
    assert.strictEqual(applyTwice.details.totalAmount, 687.16, "Total must remain 687.16");
    console.log("  PASS: Discount did not stack on re-application.");

    // Test 12: Applying a different coupon replaces the old one without stacking
    console.log("\nTest 12: Applying a different coupon replaces the old one without stacking");
    const applyFlat = await cartService.applyCoupon(testUser._id, "FLAT100");
    assert.strictEqual(applyFlat.success, true);
    assert.strictEqual(applyFlat.details.couponDiscount, 100, "Must be flat 100, not 139.8 + 100");
    assert.strictEqual(applyFlat.details.appliedCoupon.code, "FLAT100");
    assert.strictEqual(applyFlat.details.subtotal, 699);
    assert.strictEqual(applyFlat.details.taxableAmount, 599); // 699 - 100 = 599
    assert.strictEqual(applyFlat.details.taxAmount, 29.95); // 5% of 599 = 29.95
    assert.strictEqual(applyFlat.details.shippingFee, 100);
    assert.strictEqual(applyFlat.details.totalAmount, 728.95); // 599 + 29.95 + 100 = 728.95
    console.log("  PASS: FLAT100 replaced TESTPERC20 cleanly. Discount: 100, Total: 728.95.");

    // Test 13: Remove applied coupon
    console.log("\nTest 13: Remove applied coupon");
    const removeRes = await cartService.removeCoupon(testUser._id);
    assert.strictEqual(removeRes.success, true);
    assert.strictEqual(removeRes.details.couponDiscount, 0);
    assert.strictEqual(removeRes.details.appliedCoupon, null);
    assert.strictEqual(removeRes.details.subtotal, 699);
    assert.strictEqual(removeRes.details.taxAmount, 34.95); // 5% of 699 = 34.95
    assert.strictEqual(removeRes.details.shippingFee, 100);
    assert.strictEqual(removeRes.details.totalAmount, 833.95); // 699 + 34.95 + 100 = 833.95
    console.log("  PASS: Coupon removed. Total reverted to 833.95.");

    // Test 14: Reject expired coupon
    console.log("\nTest 14: Reject expired coupon");
    const expiredCoupon = await Coupon.create({
        code: "EXPIRED99",
        discountType: "FLAT",
        discountValue: 50,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-02-01"),
        isActive: true,
    });
    const applyExp = await cartService.applyCoupon(testUser._id, "EXPIRED99");
    assert.strictEqual(applyExp.success, false);
    assert.ok(applyExp.message.toLowerCase().includes("expired"), "Message should mention expired");
    console.log("  PASS: Expired coupon rejected with message:", applyExp.message);

    // Test 15: Reject future / upcoming coupon
    console.log("\nTest 15: Reject future coupon");
    const futureCoupon = await Coupon.create({
        code: "FUTURE50",
        discountType: "FLAT",
        discountValue: 50,
        startDate: new Date("2026-12-01"),
        endDate: new Date("2026-12-31"),
        isActive: true,
    });
    const applyFuture = await cartService.applyCoupon(testUser._id, "FUTURE50");
    assert.strictEqual(applyFuture.success, false);
    assert.ok(applyFuture.message.toLowerCase().includes("not active yet") || applyFuture.message.toLowerCase().includes("valid from"), "Message should mention upcoming");
    console.log("  PASS: Future coupon rejected with message:", applyFuture.message);

    // Test 16: Reject inactive coupon
    console.log("\nTest 16: Reject inactive coupon");
    await Coupon.updateOne({ code: "FLAT100" }, { $set: { isActive: false } });
    const applyInactive = await cartService.applyCoupon(testUser._id, "FLAT100");
    assert.strictEqual(applyInactive.success, false);
    assert.ok(applyInactive.message.toLowerCase().includes("inactive"), "Message should mention inactive");
    console.log("  PASS: Inactive coupon rejected with message:", applyInactive.message);
    await Coupon.updateOne({ code: "FLAT100" }, { $set: { isActive: true } });

    // Test 17: Minimum spend requires eligible available items only (Bug #11 preservation)
    console.log("\nTest 17: Minimum spend evaluated on eligible available items only");
    // Create an unavailable variant (stock: 0)
    const vOutOfStock = await Variant.create({
        productId: prod1._id,
        sku: "CCT-OOS",
        size: "S",
        color: "White",
        regularPrice: 799,
        salePrice: 699,
        stock: 0,
        isActive: true,
    });
    // Add both available (699) and unavailable (699) to cart. Total gross: 1398.
    // Create coupon with min spend 1000. Available items only sum to 699 (< 1000).
    const highMinCoupon = await Coupon.create({
        code: "MIN1000",
        discountType: "FLAT",
        discountValue: 100,
        minPurchase: 1000,
        startDate: "2026-10-01",
        endDate: "2026-11-30",
        isActive: true,
    });
    await Cart.updateOne(
        { userId: testUser._id },
        {
            $set: {
                items: [
                    { variantId: variant1._id, quantity: 1, priceSnapshot: 699 },
                    { variantId: vOutOfStock._id, quantity: 1, priceSnapshot: 699 },
                ],
                appliedCoupon: null,
            },
        }
    );
    const applyMinRes = await cartService.applyCoupon(testUser._id, "MIN1000");
    assert.strictEqual(applyMinRes.success, false, "Must reject coupon because available subtotal (699) < min spend (1000)");
    console.log("  PASS: Minimum spend correctly rejected unavailable items:", applyMinRes.message);

    // Clean up cart back to 1 available item
    await Cart.updateOne(
        { userId: testUser._id },
        {
            $set: {
                items: [{ variantId: variant1._id, quantity: 1, priceSnapshot: 699 }],
                appliedCoupon: null,
            },
        }
    );

    // Test 18: Per-user usage limit enforcement
    console.log("\nTest 18: Server-side per-user usage limit enforcement");
    // Coupon TESTPERC20 has perUserLimit: 1
    // Apply coupon to cart
    await cartService.applyCoupon(testUser._id, "TESTPERC20");
    const cartAfterApply = await cartService.getCartDetails(testUser._id);
    assert.strictEqual(cartAfterApply.appliedCoupon.code, "TESTPERC20");

    // Address
    const addr = await Address.findOne({ userId: testUser._id });

    // Place order using orderService.placeOrder()
    const orderRes = await orderService.placeOrder(
        testUser._id.toString(),
        addr._id.toString(),
        "COD"
    );
    assert.strictEqual(orderRes.success, true, "Order placement must succeed");
    const placedOrder = orderRes.order;
    assert.ok(placedOrder, "Order object must be returned");
    assert.strictEqual(placedOrder.pricing.couponCode, "TESTPERC20");
    assert.strictEqual(placedOrder.pricing.couponDiscount, 139.8);
    assert.strictEqual(placedOrder.pricing.totalAmount, 687.16);

    // Verify coupon usage was recorded in DB
    const cpnCheck = await Coupon.findOne({ code: "TESTPERC20" });
    assert.strictEqual(cpnCheck.usedCount, 1, "Coupon usedCount must increment to 1");
    const userUsage = cpnCheck.usersUsed.find(u => u.userId.toString() === testUser._id.toString());
    assert.ok(userUsage, "User usage record must exist");
    assert.strictEqual(userUsage.usageCount, 1, "User usageCount must be 1");
    console.log("  PASS: Order placed with coupon. usedCount: 1, userUsage: 1.");

    // Now testUser tries to apply TESTPERC20 again in a new cart
    await Cart.updateOne(
        { userId: testUser._id },
        {
            $set: {
                items: [{ variantId: variant1._id, quantity: 1, priceSnapshot: 699 }],
                appliedCoupon: null,
            },
        }
    );
    const reapplyRes = await cartService.applyCoupon(testUser._id, "TESTPERC20");
    assert.strictEqual(reapplyRes.success, false, "Must reject because per-user limit (1) was reached");
    assert.ok(reapplyRes.message.toLowerCase().includes("maximum allowed number of times"), "Should mention limit reached");
    console.log("  PASS: Per-user limit enforced on subsequent cart:", reapplyRes.message);

    // Another user (testUser2) CAN still use TESTPERC20 because usageLimit is 10
    await Cart.updateOne(
        { userId: testUser2._id },
        {
            $set: {
                items: [{ variantId: variant1._id, quantity: 1, priceSnapshot: 699 }],
                appliedCoupon: null,
            },
        },
        { upsert: true }
    );
    const user2Apply = await cartService.applyCoupon(testUser2._id, "TESTPERC20");
    assert.strictEqual(user2Apply.success, true, "User 2 must be allowed to use TESTPERC20");
    console.log("  PASS: Second user successfully applied coupon.");

    // Test 19: Releasing coupon usage on order cancellation
    console.log("\nTest 19: Release coupon usage on cancellation");
    const cancelRes = await orderService.cancelEntireOrder(testUser._id.toString(), placedOrder._id.toString(), "Changed mind");
    assert.strictEqual(cancelRes.success, true, "Cancellation must succeed");
    const cpnAfterCancel = await Coupon.findOne({ code: "TESTPERC20" });
    assert.strictEqual(cpnAfterCancel.usedCount, 0, "usedCount must decrement to 0 after cancellation release");
    const userUsageAfterCancel = cpnAfterCancel.usersUsed.find(u => u.userId.toString() === testUser._id.toString());
    assert.strictEqual(userUsageAfterCancel.usageCount, 0, "User usageCount must decrement to 0");
    console.log("  PASS: Coupon usage released upon order cancellation.");

    // Test 20: Deleting or deactivating coupon does not break historical order snapshot
    console.log("\nTest 20: Historical order snapshot remains intact after coupon deactivation/deletion");
    await couponService.deleteCoupon(cpnAfterCancel._id);
    const histOrder = await Order.findById(placedOrder._id);
    assert.strictEqual(histOrder.pricing.couponCode, "TESTPERC20");
    assert.strictEqual(histOrder.pricing.couponDiscount, 139.8);
    assert.strictEqual(histOrder.pricing.totalAmount, 687.16);
    console.log("  PASS: Historical order snapshot intact after coupon deleted.");

    // Test 21: Concurrent submissions cannot exceed usage limits
    console.log("\nTest 21: Concurrent submissions cannot exceed usage limits");
    const limitedCoupon = await Coupon.create({
        code: "LIMIT3",
        discountType: "FLAT",
        discountValue: 50,
        usageLimit: 3,
        perUserLimit: 1,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        isActive: true,
    });
    // 10 concurrent requests from 10 distinct users
    const userIds = Array.from({ length: 10 }, () => new mongoose.Types.ObjectId());
    const results = await Promise.all(
        userIds.map((uid, idx) => couponService.recordCouponUsage(limitedCoupon._id, uid, `ORD_CONCUR_${idx}`))
    );
    const successfulAttempts = results.filter(r => r.success);
    const rejectedAttempts = results.filter(r => !r.success);
    assert.strictEqual(successfulAttempts.length, 3, "Exactly 3 concurrent reservations must succeed");
    assert.strictEqual(rejectedAttempts.length, 7, "Remaining 7 concurrent reservations must be rejected");

    const refreshedLimited = await Coupon.findById(limitedCoupon._id);
    assert.strictEqual(refreshedLimited.usedCount, 3, "usedCount in DB must be exactly 3");
    console.log("  PASS: Concurrency test passed: 3 succeeded, 7 rejected, DB usedCount = 3.");

    console.log("\n=======================================================");
    console.log("ALL 21 BACKEND COUPON WORKFLOW TESTS PASSED PERFECTLY!");
    console.log("=======================================================\n");

    await mongoose.disconnect();
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test Suite Failed:", err);
    process.exit(1);
});
