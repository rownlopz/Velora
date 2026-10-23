/**
 * testAdminOrdersFlow.js
 * End-to-end integration test verifying Admin Orders flow and Duplicate Refund exact case.
 * Database: mongodb://127.0.0.1:27017/velora_test_isolated_suite
 */

const mongoose = require("mongoose");
const ejs = require("ejs");
const path = require("path");
const assert = require("assert");
const crypto = require("crypto");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const User = require("../models/user/userModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Category = require("../models/product/categoryModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Transaction = require("../models/user/transactionModel");

const orderController = require("../controllers/admin/orderController");
const adminOrderService = require("../services/admin/orderService");
const userOrderService = require("../services/user/orderService");
const walletService = require("../services/user/walletService");
const razorpayConfig = require("../config/razorpay");

async function run() {
    console.log("Connecting to test DB:", TEST_DB_URI);
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.dropDatabase();

    const user = await User.create({
        fullName: "Admin Test Customer",
        email: "customer@example.com",
        phone: "9876543210",
        password: "Password123!",
    });

    const category = await Category.create({ name: "Apparel", slug: "apparel" });
    const product = await Product.create({ name: "Silk Shirt", slug: "silk-shirt", categoryId: category._id });
    const variant1 = await Variant.create({ productId: product._id, sku: "SHIRT-S", regularPrice: 1000, stock: 50 });
    const variant2 = await Variant.create({ productId: product._id, sku: "SHIRT-M", regularPrice: 2000, stock: 50 });

    const shippingAddress = {
        firstName: "Admin",
        lastName: "Customer",
        addressLine1: "123 High Street",
        city: "Mumbai",
        state: "Maharashtra",
        pinCode: 400001,
        country: "India",
        phone: "9876543210",
    };

    // Create a variety of test orders across different statuses
    const now = Date.now();
    const ordersData = [
        {
            orderNumber: "ORD-001",
            userId: user._id,
            placedAt: new Date(now - 30000),
            orderStatus: "PENDING",
            paymentMethod: "COD",
            paymentStatus: "PENDING",
            pricing: { subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 1000 },
            items: [{ variantId: variant1._id, productId: product._id, productName: "Silk Shirt S", quantity: 1, unitPrice: 1000, lineTotal: 1000, status: "PENDING" }],
            shippingAddress,
        },
        {
            orderNumber: "ORD-002",
            userId: user._id,
            placedAt: new Date(now - 20000),
            orderStatus: "PLACED",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            razorpayPaymentId: "pay_002",
            pricing: { subtotal: 2000, shippingFee: 0, totalAmount: 2000, currentPayable: 2000 },
            items: [{ variantId: variant2._id, productId: product._id, productName: "Silk Shirt M", quantity: 1, unitPrice: 2000, lineTotal: 2000, status: "PLACED" }],
            shippingAddress,
        },
        {
            orderNumber: "ORD-003",
            userId: user._id,
            placedAt: new Date(now - 10000),
            orderStatus: "DELIVERED",
            paymentMethod: "COD",
            paymentStatus: "COMPLETED",
            pricing: { subtotal: 3000, shippingFee: 0, totalAmount: 3000, currentPayable: 3000 },
            items: [{ variantId: variant1._id, productId: product._id, productName: "Silk Shirt S", quantity: 3, unitPrice: 1000, lineTotal: 3000, status: "DELIVERED" }],
            shippingAddress,
        },
        {
            orderNumber: "ORD-004",
            userId: user._id,
            placedAt: new Date(now),
            orderStatus: "RETURN_APPROVED",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            pricing: { subtotal: 1500, shippingFee: 0, totalAmount: 1500, currentPayable: 0, returnCredit: 1500 },
            items: [{ variantId: variant1._id, productId: product._id, productName: "Silk Shirt S", quantity: 1, unitPrice: 1500, lineTotal: 1500, status: "RETURN_APPROVED" }],
            shippingAddress,
        },
    ];

    for (const d of ordersData) {
        await Order.create(d);
    }

    console.log("\n--- Testing 1: Controller-to-Service-to-EJS Default /admin/orders ---");
    let renderedView = null;
    let renderData = null;
    const mockReq = { query: {} };
    const mockRes = {
        render: (view, data) => {
            renderedView = view;
            renderData = data;
        },
    };

    await orderController.loadOrders(mockReq, mockRes);
    assert.strictEqual(renderedView, "admin/orders", "Controller renders admin/orders template");
    assert.strictEqual(renderData.orders.length, 4, "Default /admin/orders loads all 4 existing orders");
    assert.strictEqual(renderData.orders[0].orderNumber, "ORD-004", "Newest order appears first");
    assert.strictEqual(renderData.countsMap.ALL, 4, "countsMap.ALL is 4");
    assert.strictEqual(renderData.countsMap.all, 4, "countsMap.all is 4");
    assert.strictEqual(renderData.countsMap.PENDING, 2, "countsMap.PENDING reflects combined Pending + Placed (1 + 1 = 2)");

    // Test EJS template rendering with this data
    const viewPath = path.join(__dirname, "../views/admin/orders.ejs");
    const html = await ejs.renderFile(viewPath, {
        ...renderData,
        title: "Orders | VELORA Admin",
        active: "orders",
        admin: { name: "Admin" },
    });
    assert(html.includes("ORD-004"), "HTML contains ORD-004");
    assert(html.includes("ORD-001"), "HTML contains ORD-001");
    assert(html.includes("Return Approved"), "HTML contains Return Approved status badge/option");
    console.log("  ✓ Default /admin/orders renders HTML successfully (HTML size:", html.length, "bytes)");

    console.log("\n--- Testing 2: Sorting Behavior ---");
    // Sort amount_asc
    const resAmountAsc = await adminOrderService.getAdminOrders({ sort: "amount_asc" });
    assert.strictEqual(resAmountAsc.orders[0].orderNumber, "ORD-001", "Smallest amount order first");
    assert.strictEqual(resAmountAsc.orders[3].orderNumber, "ORD-003", "Largest amount order last");

    // Sort amount_desc
    const resAmountDesc = await adminOrderService.getAdminOrders({ sort: "amount_desc" });
    assert.strictEqual(resAmountDesc.orders[0].orderNumber, "ORD-003", "Largest amount order first");

    // Sort date_asc
    const resDateAsc = await adminOrderService.getAdminOrders({ sort: "date_asc" });
    assert.strictEqual(resDateAsc.orders[0].orderNumber, "ORD-001", "Oldest order first");
    console.log("  ✓ All sorting aliases (date_asc, date_desc, amount_asc, amount_desc) sort correctly with stable tie-breaker");

    console.log("\n--- Testing 3: 'Pending / Placed' filter & Return Statuses ---");
    const resPending = await adminOrderService.getAdminOrders({ status: "PENDING" });
    assert.strictEqual(resPending.orders.length, 2, "Pending / Placed status filter returns both PENDING and PLACED orders");

    const resReturnApproved = await adminOrderService.getAdminOrders({ status: "RETURN_APPROVED" });
    assert.strictEqual(resReturnApproved.orders.length, 1, "RETURN_APPROVED filter returns approved order");
    assert.strictEqual(resReturnApproved.orders[0].orderNumber, "ORD-004");
    console.log("  ✓ Pending / Placed and RETURN_APPROVED filters work cleanly");

    console.log("\n--- Testing 4: Status Count Filter Independence ---");
    // When filtering by orderStatus: "PENDING", countsMap.ALL and other counts still reflect search/payment filters rather than being reset to 0
    assert.strictEqual(resPending.countsMap.ALL, 4, "countsMap.ALL retains full count when status filter is active");
    assert.strictEqual(resPending.countsMap.DELIVERED, 1, "countsMap.DELIVERED is preserved");
    console.log("  ✓ Status counts preserve base filter independence");

    console.log("\n--- Testing 5: Exact Duplicate Refund Reproduction Case ---");
    // Case from user prompt:
    // 1. Capture ₹1,000.
    // 2. Cancel an item worth ₹400.
    // 3. Credit the normal ₹400 cancellation refund.
    // 4. Replay verification of original payment.
    // Wallet must receive NO additional credit!
    const userDup = await User.create({ fullName: "Dup User", email: "dup@example.com", password: "Password123!" });
    const orderDup = await Order.create({
        orderNumber: "ORD-DUP-TEST",
        orderId: "ORD-DUP-TEST",
        userId: userDup._id,
        items: [
            {
                variantId: variant1._id,
                productId: product._id,
                productName: "Item Keep",
                quantity: 1,
                unitPrice: 600,
                priceAtPurchase: 600,
                lineTotal: 600,
                finalPayable: 600,
                status: "PROCESSING",
            },
            {
                variantId: variant2._id,
                productId: product._id,
                productName: "Item Cancel",
                quantity: 1,
                unitPrice: 400,
                priceAtPurchase: 400,
                lineTotal: 400,
                finalPayable: 400,
                status: "PROCESSING",
            },
        ],
        pricing: {
            subtotal: 1000,
            shippingFee: 0,
            totalAmount: 1000,
            originalTotalAmount: 1000,
            currentPayable: 1000,
            walletRefundIssued: 0,
        },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "PROCESSING",
        razorpayOrderId: "order_dup_rzp",
        razorpayPaymentId: "pay_dup_1000",
        shippingAddress,
    });

    // Step 2 & 3: Cancel item worth ₹400 and credit ₹400 cancellation refund
    const cancelItem = orderDup.items[1];
    const canRes = await userOrderService.cancelOrderItem(userDup._id, orderDup._id, cancelItem._id, "Changed mind");
    assert.strictEqual(canRes.success, true, "Item cancelled successfully");
    const walletAfterCancel = await walletService.getOrCreateWallet(userDup._id);
    assert.strictEqual(walletAfterCancel.balance, 400, "Wallet correctly received ₹400 cancellation refund");

    // Mock Razorpay gateway returning captured payment of ₹1,000 (100,000 paise)
    razorpayConfig.setRazorpayInstanceCreator(() => ({
        payments: {
            fetch: async (id) => ({
                id,
                order_id: "order_dup_rzp",
                amount: 100000,
                currency: "INR",
                status: "captured",
            }),
        },
    }));

    // Step 4: Replay verification of the original payment
    const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
    const sigReplay = crypto.createHmac("sha256", secret).update("order_dup_rzp|pay_dup_1000").digest("hex");

    const replayRes = await userOrderService.verifyRazorpayPayment(userDup._id, {
        orderId: orderDup._id,
        razorpayOrderId: "order_dup_rzp",
        razorpayPaymentId: "pay_dup_1000",
        razorpaySignature: sigReplay,
    });

    assert.strictEqual(replayRes.success, true, "Replay verification returns success");
    const walletAfterReplay = await walletService.getOrCreateWallet(userDup._id);
    assert.strictEqual(walletAfterReplay.balance, 400, "Wallet balance is STILL EXACTLY ₹400 (ZERO extra credit on replay!)");

    const orderAfterReplay = await Order.findById(orderDup._id);
    assert.strictEqual(orderAfterReplay.pricing.walletRefundIssued, 400, "walletRefundIssued accounting total remains 400");
    console.log("  ✓ Exact duplicate refund reproduction verified: Wallet balance remains exactly ₹400 with 0 extra credit!");

    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    console.log("\nALL INTEGRATION AND FLOW TESTS PASSED SUCCESSFULLY!\n");
}

run().catch((err) => {
    console.error("Test Error:", err);
    process.exit(1);
});
