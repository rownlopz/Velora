/**
 * scripts/verifyRazorpayTestModeLive.js
 * Verifies live Razorpay Test Mode gateway connectivity without mocks.
 * Does not use real money (creates a test order in Razorpay Test Mode).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const razorpayConfig = require("../config/razorpay");

async function verifyLiveTestMode() {
    console.log("=============================================================");
    console.log("VERIFYING LIVE RAZORPAY TEST MODE CONNECTIVITY (NO MOCKS)");
    console.log("=============================================================\n");

    const isConfigured = razorpayConfig.isRazorpayConfigured();
    console.log(`1. isRazorpayConfigured(): ${isConfigured}`);

    if (!isConfigured) {
        console.error("Razorpay Test Mode credentials are missing from environment.");
        process.exit(1);
    }

    const rzp = razorpayConfig.getRazorpayInstance();
    if (!rzp) {
        console.error("Failed to obtain Razorpay instance.");
        process.exit(1);
    }

    try {
        const testOrderParams = {
            amount: 50000, // ₹500 in integer paise
            currency: "INR",
            receipt: `rcpt_live_test_${Date.now()}`,
            notes: { test_source: "Velora Week 16 Verification Suite" },
        };

        console.log(`2. Calling Razorpay live API: orders.create (${testOrderParams.amount} paise)...`);
        const liveOrder = await rzp.orders.create(testOrderParams);

        console.log("  ✓ Razorpay API response received successfully!");
        console.log(`  - Gateway Order ID: ${liveOrder.id}`);
        console.log(`  - Gateway Status: ${liveOrder.status}`);
        console.log(`  - Gateway Currency: ${liveOrder.currency}`);
        console.log(`  - Gateway Amount: ${liveOrder.amount} paise (₹${liveOrder.amount / 100})`);

        if (liveOrder.id && liveOrder.status === "created" && liveOrder.currency === "INR" && liveOrder.amount === 50000) {
            console.log("\n=============================================================");
            console.log("LIVE RAZORPAY TEST MODE CONNECTIVITY: VERIFIED (PASS)");
            console.log("=============================================================\n");
        } else {
            console.error("Live order returned unexpected response fields:", liveOrder);
            process.exit(1);
        }
    } catch (err) {
        console.error("Razorpay Live Test Mode call failed:", err.message || err);
        process.exit(1);
    }
}

verifyLiveTestMode();
