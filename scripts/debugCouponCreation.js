const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const Coupon = require("../models/order/couponModel");
const couponService = require("../services/admin/couponService");

const ISOLATED_TEST_DB = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const run = async () => {
    console.log("Connecting to isolated test database...");
    await mongoose.connect(ISOLATED_TEST_DB);

    // Clean test coupons
    await Coupon.deleteMany({ code: /^TEST/ });

    console.log("\n--- Testing couponService.createCoupon directly with form-like payload ---");
    const payload1 = {
        code: "TESTCODE1",
        description: "Test Coupon Description",
        discountType: "PERCENTAGE",
        discountValue: "20",
        minPurchase: "0",
        maxDiscount: "",
        usageLimit: "",
        perUserLimit: "1",
        startDate: "2026-10-24",
        endDate: "2026-10-31"
    };

    console.log("Payload:", payload1);
    try {
        const result1 = await couponService.createCoupon(payload1);
        console.log("Result 1:", result1);
    } catch (err) {
        console.error("Error 1 thrown:", err);
    }

    // Now test with 100% percentage discount
    console.log("\n--- Testing 100% discount ---");
    const payload100 = {
        code: "TEST100PCT",
        discountType: "PERCENTAGE",
        discountValue: "100",
        startDate: "2026-10-24",
        endDate: "2026-10-31"
    };
    try {
        const result100 = await couponService.createCoupon(payload100);
        console.log("Result 100%:", result100);
    } catch (err) {
        console.error("Error 100% thrown:", err);
    }

    // Now test with duplicate code
    console.log("\n--- Testing duplicate code ---");
    try {
        const resultDup = await couponService.createCoupon(payload1);
        console.log("Result Duplicate:", resultDup);
    } catch (err) {
        console.error("Error Duplicate thrown:", err);
    }

    // Check indexes on Coupon model
    console.log("\n--- Coupon Model Indexes ---");
    const indexes = await Coupon.collection.getIndexes();
    console.log(JSON.stringify(indexes, null, 2));

    await mongoose.disconnect();
};

run().catch(console.error);
