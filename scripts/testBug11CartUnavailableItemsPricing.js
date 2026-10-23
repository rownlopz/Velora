const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const Category = require("../models/product/categoryModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Cart = require("../models/order/cartModel");
const Coupon = require("../models/order/couponModel");
const User = require("../models/user/userModel");
const Address = require("../models/user/addressModel");
const Order = require("../models/order/orderModel");

const pricingService = require("../services/common/pricingService");
const cartService = require("../services/user/cartService");
const orderService = require("../services/user/orderService");

const ISOLATED_TEST_DB = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const run = async () => {
    console.log("==========================================================================");
    console.log("RUNNING ISOLATED DATABASE TESTS FOR BUG #11: CART PRICING & ALLOCATION");
    console.log(`Database: ${ISOLATED_TEST_DB}`);
    console.log("==========================================================================\n");

    await mongoose.connect(ISOLATED_TEST_DB);

    let passed = 0;
    let failed = 0;
    const failures = [];

    const assert = (condition, desc, details = "") => {
        if (condition) {
            passed++;
            console.log(`  [PASS] ${desc}`);
        } else {
            failed++;
            console.error(`  [FAIL] ${desc} ${details ? "- " + details : ""}`);
            failures.push(`${desc} ${details}`);
        }
    };

    // Clean test collections before running
    await User.deleteMany({ email: /^bug11_.*@example\.com$/ });
    await Category.deleteMany({ name: /^Bug11_/ });
    await Product.deleteMany({ name: /^Bug11_/ });
    await Variant.deleteMany({ sku: /^BUG11-/ });
    await Cart.deleteMany({});
    await Coupon.deleteMany({ code: /^BUG11/ });
    await Address.deleteMany({});
    await Order.deleteMany({ orderNumber: /^BUG11-/ });

    const now = new Date();
    const testUser = await User.create({
        fullName: "Bug11 Tester",
        email: `bug11_${Date.now()}@example.com`,
        password: "Password123!",
    });

    const testCategory = await Category.create({
        name: `Bug11_Category_${Date.now()}`,
        slug: `bug11-category-${Date.now()}`,
        isActive: true,
        isDeleted: false,
    });

    // Helper to create product + variant
    const createTestProductVariant = async (name, regularPrice, stock, isActive = true) => {
        const prod = await Product.create({
            name: `Bug11_${name}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            slug: `bug11-${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            categoryId: testCategory._id,
            status: "ACTIVE",
            isDeleted: false,
        });

        const variant = await Variant.create({
            productId: prod._id,
            sku: `BUG11-${Math.random().toString(36).substring(7).toUpperCase()}`,
            color: "Standard",
            size: "M",
            regularPrice,
            salePrice: regularPrice,
            stock,
            isActive,
        });

        return { product: prod, variant };
    };

    const makeCartItem = (variant, quantity = 1) => ({
        variantId: variant._id,
        quantity,
        priceSnapshot: variant.regularPrice,
    });

    // Helper to create coupon
    const createTestCoupon = async (code, discountType, discountValue, minPurchase = 0, maxDiscount = null) => {
        return await Coupon.create({
            code: code.toUpperCase(),
            discountType,
            discountValue,
            minPurchase,
            maxDiscount,
            startDate: new Date(Date.now() - 3600000),
            endDate: new Date(Date.now() + 3600000),
            isActive: true,
            usedCount: 0,
        });
    };

    // =========================================================================
    // TEST CASE A: Available ₹1,000 item + unavailable ₹1,000 item + ₹100 flat coupon
    // Reproduction scenario:
    // Expected:
    // - Available item: coupon allocation ₹100, taxable ₹900, tax ₹45, final payable ₹945
    // - Unavailable item: coupon allocation ₹0, tax ₹0, lineTotal ₹0, final payable ₹0
    // - Summary: subtotal ₹1,000, coupon ₹100, taxable ₹900, tax ₹45, shipping ₹0, total ₹945
    // =========================================================================
    console.log("--- Test Case A: Available ₹1,000 + Unavailable ₹1,000 + ₹100 Flat Coupon ---");
    {
        const p1 = await createTestProductVariant("ItemA1", 1000, 10, true);
        const p2 = await createTestProductVariant("ItemA2", 1000, 0, true); // stock = 0 (unavailable)
        const couponA = await createTestCoupon("BUG11FLAT100", "FLAT", 100, 500);

        await Cart.create({
            userId: testUser._id,
            items: [
                makeCartItem(p1.variant, 1),
                makeCartItem(p2.variant, 1),
            ],
            appliedCoupon: {
                couponId: couponA._id,
                code: couponA.code,
                discountType: couponA.discountType,
                discountValue: couponA.discountValue,
                discountAmount: 100,
            },
        });

        const cartDetails = await cartService.getCartDetails(testUser._id);

        assert(cartDetails.items.length === 2, "Case A: Returns 2 items in cart");
        const availItem = cartDetails.items.find((i) => i.variantId.toString() === p1.variant._id.toString());
        const unavailItem = cartDetails.items.find((i) => i.variantId.toString() === p2.variant._id.toString());

        assert(availItem && availItem.isAvailable === true, "Case A: Item 1 is marked available");
        assert(unavailItem && unavailItem.isAvailable === false, "Case A: Item 2 is marked unavailable");

        // Available item financial contributions
        assert(availItem.lineTotal === 1000, `Case A: Available item lineTotal is ₹1,000 (Actual: ₹${availItem.lineTotal})`);
        assert(availItem.allocatedCouponDiscount === 100, `Case A: Available item gets full ₹100 coupon allocation (Actual: ₹${availItem.allocatedCouponDiscount})`);
        assert(availItem.allocatedTax === 45, `Case A: Available item tax is ₹45 (Actual: ₹${availItem.allocatedTax})`);
        assert(availItem.finalPayable === 945, `Case A: Available item finalPayable is ₹945 (Actual: ₹${availItem.finalPayable})`);

        // Unavailable item financial contributions (must be strictly 0)
        assert(unavailItem.lineTotal === 0, `Case A: Unavailable item lineTotal is ₹0 (Actual: ₹${unavailItem.lineTotal})`);
        assert(unavailItem.allocatedCouponDiscount === 0, `Case A: Unavailable item coupon allocation is ₹0 (Actual: ₹${unavailItem.allocatedCouponDiscount})`);
        assert(unavailItem.allocatedTax === 0, `Case A: Unavailable item tax is ₹0 (Actual: ₹${unavailItem.allocatedTax})`);
        assert(unavailItem.finalPayable === 0, `Case A: Unavailable item finalPayable is ₹0 (Actual: ₹${unavailItem.finalPayable})`);
        assert(unavailItem.effectiveUnitPrice === 1000, `Case A: Unavailable item preserves catalogue unitPrice ₹1,000 (Actual: ₹${unavailItem.effectiveUnitPrice})`);

        // Summary figures
        assert(cartDetails.subtotal === 1000, `Case A: Cart subtotal is ₹1,000 (Actual: ₹${cartDetails.subtotal})`);
        assert(cartDetails.couponDiscount === 100, `Case A: Coupon discount is ₹100 (Actual: ₹${cartDetails.couponDiscount})`);
        assert(cartDetails.taxableAmount === 900, `Case A: Taxable amount is ₹900 (Actual: ₹${cartDetails.taxableAmount})`);
        assert(cartDetails.taxAmount === 45, `Case A: Tax amount is ₹45 (Actual: ₹${cartDetails.taxAmount})`);
        assert(cartDetails.shippingFee === 0, `Case A: Shipping fee is ₹0 under threshold rule (Actual: ₹${cartDetails.shippingFee})`);
        assert(cartDetails.totalAmount === 945, `Case A: Summary totalAmount is ₹945 (Actual: ₹${cartDetails.totalAmount})`);

        // Exact Integer-Paise Allocation Sums
        const sumItemCoupon = cartDetails.items.reduce((s, i) => s + i.allocatedCouponDiscount, 0);
        const sumItemTax = cartDetails.items.reduce((s, i) => s + i.allocatedTax, 0);
        const sumItemPayable = cartDetails.items.reduce((s, i) => s + i.finalPayable, 0);

        assert(sumItemCoupon === cartDetails.couponDiscount, `Case A: Sum of item coupon shares (${sumItemCoupon}) === summary couponDiscount (${cartDetails.couponDiscount})`);
        assert(sumItemTax === cartDetails.taxAmount, `Case A: Sum of item taxes (${sumItemTax}) === summary taxAmount (${cartDetails.taxAmount})`);
        assert(sumItemPayable + cartDetails.shippingFee === cartDetails.totalAmount, `Case A: Sum of item payables (${sumItemPayable}) + shipping (${cartDetails.shippingFee}) === totalAmount (${cartDetails.totalAmount})`);
    }

    // =========================================================================
    // TEST CASE B: All items available (existing correct totals remain unchanged)
    // =========================================================================
    console.log("\n--- Test Case B: All items available ---");
    {
        const p1 = await createTestProductVariant("ItemB1", 1000, 10, true);
        const p2 = await createTestProductVariant("ItemB2", 1000, 10, true);
        const couponB = await createTestCoupon("BUG11ALLAVAIL", "FLAT", 100, 500);

        await Cart.updateOne(
            { userId: testUser._id },
            {
                $set: {
                    items: [
                        makeCartItem(p1.variant, 1),
                        makeCartItem(p2.variant, 1),
                    ],
                    appliedCoupon: {
                        couponId: couponB._id,
                        code: couponB.code,
                        discountType: couponB.discountType,
                        discountValue: couponB.discountValue,
                        discountAmount: 100,
                    },
                },
            }
        );

        const cartDetails = await cartService.getCartDetails(testUser._id);

        assert(cartDetails.hasUnavailableItems === false, "Case B: hasUnavailableItems is false");
        assert(cartDetails.subtotal === 2000, `Case B: Subtotal is ₹2,000 (Actual: ₹${cartDetails.subtotal})`);
        assert(cartDetails.couponDiscount === 100, `Case B: Coupon discount is ₹100 (Actual: ₹${cartDetails.couponDiscount})`);
        assert(cartDetails.taxableAmount === 1900, `Case B: Taxable amount is ₹1,900 (Actual: ₹${cartDetails.taxableAmount})`);
        assert(cartDetails.taxAmount === 95, `Case B: Tax amount is ₹95 (Actual: ₹${cartDetails.taxAmount})`);
        assert(cartDetails.shippingFee === 0, `Case B: Shipping fee is ₹0 (Actual: ₹${cartDetails.shippingFee})`);
        assert(cartDetails.totalAmount === 1995, `Case B: Total amount is ₹1,995 (Actual: ₹${cartDetails.totalAmount})`);

        // Check each available item received proportional coupon & tax
        for (const item of cartDetails.items) {
            assert(item.allocatedCouponDiscount === 50, `Case B: Item gets ₹50 coupon (Actual: ₹${item.allocatedCouponDiscount})`);
            assert(item.allocatedTax === 47.5, `Case B: Item gets ₹47.50 tax (Actual: ₹${item.allocatedTax})`);
            assert(item.finalPayable === 997.5, `Case B: Item finalPayable is ₹997.50 (Actual: ₹${item.finalPayable})`);
        }

        const sumItemPayable = cartDetails.items.reduce((s, i) => s + i.finalPayable, 0);
        assert(sumItemPayable === cartDetails.totalAmount, `Case B: Sum of final payables (${sumItemPayable}) === totalAmount (${cartDetails.totalAmount})`);
    }

    // =========================================================================
    // TEST CASE C: All items unavailable (payable contributions zero, checkout blocked)
    // =========================================================================
    console.log("\n--- Test Case C: All items unavailable ---");
    {
        const p1 = await createTestProductVariant("ItemC1", 800, 0, true); // out of stock
        const p2 = await createTestProductVariant("ItemC2", 1200, 5, false); // variant inactive

        await Cart.updateOne(
            { userId: testUser._id },
            {
                $set: {
                    items: [
                        makeCartItem(p1.variant, 1),
                        makeCartItem(p2.variant, 1),
                    ],
                    appliedCoupon: null,
                },
            }
        );

        const cartDetails = await cartService.getCartDetails(testUser._id);

        assert(cartDetails.hasUnavailableItems === true, "Case C: hasUnavailableItems is true");
        assert(cartDetails.subtotal === 0, `Case C: Subtotal is ₹0 (Actual: ₹${cartDetails.subtotal})`);
        assert(cartDetails.couponDiscount === 0, `Case C: Coupon discount is ₹0 (Actual: ₹${cartDetails.couponDiscount})`);
        assert(cartDetails.taxableAmount === 0, `Case C: Taxable amount is ₹0 (Actual: ₹${cartDetails.taxableAmount})`);
        assert(cartDetails.taxAmount === 0, `Case C: Tax amount is ₹0 (Actual: ₹${cartDetails.taxAmount})`);
        assert(cartDetails.shippingFee === 0, `Case C: Shipping fee is ₹0 (no phantom shipping) (Actual: ₹${cartDetails.shippingFee})`);
        assert(cartDetails.totalAmount === 0, `Case C: Total amount is ₹0 (Actual: ₹${cartDetails.totalAmount})`);

        for (const item of cartDetails.items) {
            assert(item.isAvailable === false, "Case C: Item is marked unavailable");
            assert(item.lineTotal === 0, `Case C: Item lineTotal is ₹0 (Actual: ₹${item.lineTotal})`);
            assert(item.allocatedCouponDiscount === 0, `Case C: Item coupon allocation is ₹0 (Actual: ₹${item.allocatedCouponDiscount})`);
            assert(item.allocatedTax === 0, `Case C: Item tax is ₹0 (Actual: ₹${item.allocatedTax})`);
            assert(item.finalPayable === 0, `Case C: Item finalPayable is ₹0 (Actual: ₹${item.finalPayable})`);
        }

        // Checkout blocked checks
        const checkoutDetails = await orderService.getCheckoutDetails(testUser._id);
        assert(checkoutDetails.success === false, "Case C: getCheckoutDetails blocked");
        assert(checkoutDetails.reason === "UNAVAILABLE_ITEMS", `Case C: getCheckoutDetails reason is UNAVAILABLE_ITEMS (Actual: ${checkoutDetails.reason})`);

        const addressC = await Address.create({
            userId: testUser._id,
            firstName: "Bug11",
            lastName: "Tester",
            addressLine1: "123 Street",
            city: "Kochi",
            state: "Kerala",
            pinCode: "682001",
            country: "India",
            phone: "9876543210",
            isDefault: true,
        });

        // Order placement blocked check
        const createOrderRes = await orderService.placeOrder(testUser._id, addressC._id, "COD");
        assert(createOrderRes.success === false, "Case C: placeOrder blocked incomplete order");
        assert(createOrderRes.message.includes("no longer available") || createOrderRes.message.includes("exceed stock"), `Case C: placeOrder returns appropriate error (Actual: ${createOrderRes.message})`);
    }

    // =========================================================================
    // TEST CASE D: Coupon minimum spend is met only when including unavailable item
    // (Coupon must NOT qualify)
    // =========================================================================
    console.log("\n--- Test Case D: Coupon min spend met only with unavailable item ---");
    {
        const p1 = await createTestProductVariant("ItemD1", 1000, 10, true); // ₹1,000 available
        const p2 = await createTestProductVariant("ItemD2", 1000, 0, true);  // ₹1,000 unavailable
        // Coupon requires ₹1,500 min purchase
        const couponD = await createTestCoupon("BUG11MIN1500", "FLAT", 100, 1500);

        await Cart.updateOne(
            { userId: testUser._id },
            {
                $set: {
                    items: [
                        makeCartItem(p1.variant, 1),
                        makeCartItem(p2.variant, 1),
                    ],
                    appliedCoupon: {
                        couponId: couponD._id,
                        code: couponD.code,
                        discountType: couponD.discountType,
                        discountValue: couponD.discountValue,
                        discountAmount: 100,
                    },
                },
            }
        );

        const cartDetails = await cartService.getCartDetails(testUser._id);

        assert(cartDetails.subtotal === 1000, `Case D: Eligible subtotal is ₹1,000 (Actual: ₹${cartDetails.subtotal})`);
        assert(cartDetails.couponError != null && cartDetails.couponError.includes("minimum purchase of ₹1,500"), `Case D: Coupon rejected with min purchase error (Actual: ${cartDetails.couponError})`);
        assert(cartDetails.couponDiscount === 0, `Case D: Coupon discount is ₹0 (Actual: ₹${cartDetails.couponDiscount})`);
        assert(cartDetails.appliedCoupon === null, "Case D: appliedCoupon cleared from result");

        // Tax and totals reflect 0 coupon on eligible subtotal
        assert(cartDetails.taxableAmount === 1000, `Case D: Taxable amount is ₹1,000 (Actual: ₹${cartDetails.taxableAmount})`);
        assert(cartDetails.taxAmount === 50, `Case D: 5% tax is ₹50 (Actual: ₹${cartDetails.taxAmount})`);
        assert(cartDetails.totalAmount === 1050, `Case D: Total amount is ₹1,050 (Actual: ₹${cartDetails.totalAmount})`);
    }

    // =========================================================================
    // TEST CASE E: Percentage coupon, max cap, multiple quantities, paise prices
    // =========================================================================
    console.log("\n--- Test Case E: Percentage coupon, cap, multiple quantities, paise prices ---");
    {
        // Item 1: 2 units @ ₹499.50 = ₹999.00
        const p1 = await createTestProductVariant("ItemE1", 499.50, 10, true);
        // Item 2: 1 unit @ ₹349.75 = ₹349.75
        const p2 = await createTestProductVariant("ItemE2", 349.75, 10, true);
        // Item 3: 1 unit @ ₹899.00 (unavailable)
        const p3 = await createTestProductVariant("ItemE3", 899.00, 0, true);

        // 15% coupon, capped at ₹200.00 max discount
        // Eligible subtotal = 999.00 + 349.75 = 1348.75
        // 15% of 1348.75 = 202.3125, capped at 200.00
        const couponE = await createTestCoupon("BUG11PERC15", "PERCENTAGE", 15, 500, 200);

        await Cart.updateOne(
            { userId: testUser._id },
            {
                $set: {
                    items: [
                        makeCartItem(p1.variant, 2),
                        makeCartItem(p2.variant, 1),
                        makeCartItem(p3.variant, 1),
                    ],
                    appliedCoupon: {
                        couponId: couponE._id,
                        code: couponE.code,
                        discountType: couponE.discountType,
                        discountValue: couponE.discountValue,
                        discountAmount: 200,
                    },
                },
            }
        );

        const cartDetails = await cartService.getCartDetails(testUser._id);

        assert(cartDetails.subtotal === 1348.75, `Case E: Subtotal is ₹1,348.75 (Actual: ₹${cartDetails.subtotal})`);
        assert(cartDetails.couponDiscount === 200, `Case E: Coupon discount capped at ₹200.00 (Actual: ₹${cartDetails.couponDiscount})`);
        assert(cartDetails.taxableAmount === 1148.75, `Case E: Taxable merchandise is ₹1,148.75 (Actual: ₹${cartDetails.taxableAmount})`);

        // Tax 5% of 1148.75 = 57.4375 -> rounded to 57.44
        const expectedTax = Math.round(114875 * 5 / 100) / 100;
        assert(cartDetails.taxAmount === expectedTax, `Case E: 5% Tax is ₹${expectedTax} (Actual: ₹${cartDetails.taxAmount})`);
        assert(cartDetails.shippingFee === 0, `Case E: Shipping is ₹0 since subtotal >= 1000 (Actual: ₹${cartDetails.shippingFee})`);

        const expectedTotal = Math.round((1148.75 + expectedTax) * 100) / 100;
        assert(cartDetails.totalAmount === expectedTotal, `Case E: Total is ₹${expectedTotal} (Actual: ₹${cartDetails.totalAmount})`);

        const it1 = cartDetails.items.find((i) => i.variantId.toString() === p1.variant._id.toString());
        const it2 = cartDetails.items.find((i) => i.variantId.toString() === p2.variant._id.toString());
        const it3 = cartDetails.items.find((i) => i.variantId.toString() === p3.variant._id.toString());

        // Unavailable item receives 0
        assert(it3.lineTotal === 0, `Case E: Unavailable item lineTotal is 0 (Actual: ${it3.lineTotal})`);
        assert(it3.allocatedCouponDiscount === 0, `Case E: Unavailable item coupon allocation is 0 (Actual: ${it3.allocatedCouponDiscount})`);
        assert(it3.allocatedTax === 0, `Case E: Unavailable item tax is 0 (Actual: ${it3.allocatedTax})`);
        assert(it3.finalPayable === 0, `Case E: Unavailable item finalPayable is 0 (Actual: ${it3.finalPayable})`);

        // Integer-paise exact matching
        const sumCoupons = Math.round((it1.allocatedCouponDiscount + it2.allocatedCouponDiscount) * 100) / 100;
        const sumTaxes = Math.round((it1.allocatedTax + it2.allocatedTax) * 100) / 100;
        const sumPayables = Math.round((it1.finalPayable + it2.finalPayable) * 100) / 100;

        assert(sumCoupons === cartDetails.couponDiscount, `Case E: Sum of item coupons (₹${sumCoupons}) === summary couponDiscount (₹${cartDetails.couponDiscount})`);
        assert(sumTaxes === cartDetails.taxAmount, `Case E: Sum of item taxes (₹${sumTaxes}) === summary taxAmount (₹${cartDetails.taxAmount})`);
        assert(sumPayables === cartDetails.totalAmount, `Case E: Sum of item payables (₹${sumPayables}) === summary totalAmount (₹${cartDetails.totalAmount})`);
    }

    // =========================================================================
    // TEST CASE F: An item becomes unavailable after initially loading the cart
    // =========================================================================
    console.log("\n--- Test Case F: Item becomes unavailable after loading cart ---");
    {
        const p1 = await createTestProductVariant("ItemF1", 1000, 10, true);
        const p2 = await createTestProductVariant("ItemF2", 1000, 5, true); // initially available

        await Cart.updateOne(
            { userId: testUser._id },
            {
                $set: {
                    items: [
                        makeCartItem(p1.variant, 1),
                        makeCartItem(p2.variant, 1),
                    ],
                    appliedCoupon: null,
                },
            }
        );

        // First load: both are available
        const initialCart = await cartService.getCartDetails(testUser._id);
        assert(initialCart.hasUnavailableItems === false, "Case F: Initially cart has no unavailable items");
        assert(initialCart.subtotal === 2000, `Case F: Initial subtotal is ₹2,000 (Actual: ₹${initialCart.subtotal})`);

        // Stock changes to 0 in background/DB for item 2
        await Variant.updateOne({ _id: p2.variant._id }, { $set: { stock: 0 } });

        // Second load / refreshed cart pricing
        const refreshedCart = await cartService.getCartDetails(testUser._id);
        assert(refreshedCart.hasUnavailableItems === true, "Case F: Refreshed cart detects unavailable item");
        assert(refreshedCart.subtotal === 1000, `Case F: Refreshed subtotal excludes out-of-stock item (₹1,000, Actual: ₹${refreshedCart.subtotal})`);
        assert(refreshedCart.taxAmount === 50, `Case F: Refreshed tax is ₹50 on ₹1,000 (Actual: ₹${refreshedCart.taxAmount})`);
        assert(refreshedCart.totalAmount === 1050, `Case F: Refreshed total is ₹1,050 (Actual: ₹${refreshedCart.totalAmount})`);

        const p2Refreshed = refreshedCart.items.find((i) => i.variantId.toString() === p2.variant._id.toString());
        assert(p2Refreshed.isAvailable === false, "Case F: Item 2 marked unavailable");
        assert(p2Refreshed.lineTotal === 0, `Case F: Item 2 lineTotal is 0 (Actual: ${p2Refreshed.lineTotal})`);
        assert(p2Refreshed.finalPayable === 0, `Case F: Item 2 finalPayable is 0 (Actual: ${p2Refreshed.finalPayable})`);

        const addressF = await Address.create({
            userId: testUser._id,
            firstName: "Bug11",
            lastName: "Tester",
            addressLine1: "123 Street",
            city: "Kochi",
            state: "Kerala",
            pinCode: "682001",
            country: "India",
            phone: "9876543210",
            isDefault: true,
        });

        // Attempting to place order rejects unavailable stock
        const orderRes = await orderService.placeOrder(testUser._id, addressF._id, "COD");
        assert(orderRes.success === false, "Case F: placeOrder rejects order with unavailable stock");
        assert(orderRes.message.includes("no longer available") || orderRes.message.includes("exceed stock"), `Case F: placeOrder returned error message (Actual: ${orderRes.message})`);
    }

    // =========================================================================
    // TEST CASE G: No coupon (tax and totals include eligible items only)
    // =========================================================================
    console.log("\n--- Test Case G: No coupon ---");
    {
        const p1 = await createTestProductVariant("ItemG1", 1000, 10, true);
        const p2 = await createTestProductVariant("ItemG2", 1000, 0, true); // unavailable

        await Cart.updateOne(
            { userId: testUser._id },
            {
                $set: {
                    items: [
                        makeCartItem(p1.variant, 1),
                        makeCartItem(p2.variant, 1),
                    ],
                    appliedCoupon: null,
                },
            }
        );

        const cartDetails = await cartService.getCartDetails(testUser._id);

        assert(cartDetails.subtotal === 1000, `Case G: Subtotal is ₹1,000 (Actual: ₹${cartDetails.subtotal})`);
        assert(cartDetails.couponDiscount === 0, `Case G: Coupon is 0 (Actual: ₹${cartDetails.couponDiscount})`);
        assert(cartDetails.taxAmount === 50, `Case G: Tax is ₹50 (Actual: ₹${cartDetails.taxAmount})`);
        assert(cartDetails.totalAmount === 1050, `Case G: Total is ₹1,050 (Actual: ₹${cartDetails.totalAmount})`);

        const it1 = cartDetails.items.find((i) => i.variantId.toString() === p1.variant._id.toString());
        const it2 = cartDetails.items.find((i) => i.variantId.toString() === p2.variant._id.toString());

        assert(it1.finalPayable === 1050, `Case G: Available item finalPayable is ₹1,050 (Actual: ₹${it1.finalPayable})`);
        assert(it2.finalPayable === 0, `Case G: Unavailable item finalPayable is 0 (Actual: ₹${it2.finalPayable})`);
    }

    // =========================================================================
    // TEST CASE H: Removing the unavailable item (financial totals remain consistent)
    // =========================================================================
    console.log("\n--- Test Case H: Removing the unavailable item ---");
    {
        const p1 = await createTestProductVariant("ItemH1", 1000, 10, true);
        const p2 = await createTestProductVariant("ItemH2", 1000, 0, true); // unavailable
        const couponH = await createTestCoupon("BUG11REMOVE", "FLAT", 100, 500);

        await Cart.updateOne(
            { userId: testUser._id },
            {
                $set: {
                    items: [
                        makeCartItem(p1.variant, 1),
                        makeCartItem(p2.variant, 1),
                    ],
                    appliedCoupon: {
                        couponId: couponH._id,
                        code: couponH.code,
                        discountType: couponH.discountType,
                        discountValue: couponH.discountValue,
                        discountAmount: 100,
                    },
                },
            }
        );

        // Before removal:
        const beforeCart = await cartService.getCartDetails(testUser._id);
        assert(beforeCart.totalAmount === 945, `Case H: Before removal, totalAmount is ₹945 (Actual: ₹${beforeCart.totalAmount})`);
        assert(beforeCart.hasUnavailableItems === true, "Case H: Before removal, hasUnavailableItems is true");

        // Remove the unavailable item
        await cartService.removeFromCart(testUser._id, p2.variant._id.toString());

        // After removal:
        const afterCart = await cartService.getCartDetails(testUser._id);
        assert(afterCart.items.length === 1, `Case H: After removal, cart has 1 item (Actual: ${afterCart.items.length})`);
        assert(afterCart.hasUnavailableItems === false, "Case H: After removal, hasUnavailableItems is false");
        assert(afterCart.subtotal === 1000, `Case H: After removal, subtotal is ₹1,000 (Actual: ₹${afterCart.subtotal})`);
        assert(afterCart.couponDiscount === 100, `Case H: After removal, couponDiscount is ₹100 (Actual: ₹${afterCart.couponDiscount})`);
        assert(afterCart.taxAmount === 45, `Case H: After removal, taxAmount is ₹45 (Actual: ₹${afterCart.taxAmount})`);
        assert(afterCart.totalAmount === 945, `Case H: After removal, totalAmount remains ₹945 (Actual: ₹${afterCart.totalAmount})`);

        const remainingItem = afterCart.items[0];
        assert(remainingItem.finalPayable === 945, `Case H: Remaining item finalPayable remains ₹945 (Actual: ₹${remainingItem.finalPayable})`);

        // Checkout is now unblocked
        // Add test address so getCheckoutDetails can return success: true
        const address = await Address.create({
            userId: testUser._id,
            firstName: "Bug11",
            lastName: "Tester",
            addressLine1: "123 Street",
            city: "Kochi",
            state: "Kerala",
            pinCode: "682001",
            country: "India",
            phone: "9876543210",
            isDefault: true,
        });

        const checkoutRes = await orderService.getCheckoutDetails(testUser._id);
        assert(checkoutRes.success === true, "Case H: Checkout is now successfully unblocked");
        assert(checkoutRes.totalAmount === 945, `Case H: Checkout totalAmount is ₹945 (Actual: ₹${checkoutRes.totalAmount})`);
    }

    console.log("\n==========================================================================");
    console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("==========================================================================");

    if (failures.length > 0) {
        console.error("\nFailures:");
        failures.forEach((f) => console.error(`- ${f}`));
        process.exit(1);
    } else {
        console.log("\nAll Bug #11 tests passed successfully!");
        process.exit(0);
    }
};

run().catch((err) => {
    console.error("Test execution error:", err);
    process.exit(1);
});
