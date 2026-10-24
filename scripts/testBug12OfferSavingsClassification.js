const mongoose = require("mongoose");
const path = require("path");
const ejs = require("ejs");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const Category = require("../models/product/categoryModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Cart = require("../models/order/cartModel");
const Coupon = require("../models/order/couponModel");
const Offer = require("../models/product/offerModel");
const User = require("../models/user/userModel");
const Address = require("../models/user/addressModel");
const Order = require("../models/order/orderModel");

const pricingService = require("../services/common/pricingService");
const cartService = require("../services/user/cartService");
const orderService = require("../services/user/orderService");

const ISOLATED_TEST_DB = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const run = async () => {
    console.log("==========================================================================");
    console.log("RUNNING ISOLATED DATABASE TESTS FOR BUG #12: OFFER SAVINGS CLASSIFICATION");
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
    await User.deleteMany({ email: /^bug12_.*@example\.com$/ });
    await Category.deleteMany({ name: /^Bug12_/ });
    await Product.deleteMany({ name: /^Bug12_/ });
    await Variant.deleteMany({ sku: /^BUG12-/ });
    await Cart.deleteMany({});
    await Coupon.deleteMany({ code: /^BUG12/ });
    await Offer.deleteMany({ name: /^Bug12_/ });
    await Address.deleteMany({});
    await Order.deleteMany({ orderNumber: /^BUG12-/ });

    const testUser = await User.create({
        fullName: "Bug12 Tester",
        email: `bug12_${Date.now()}@example.com`,
        password: "Password123!",
    });

    const testCategory = await Category.create({
        name: `Bug12_Category_${Date.now()}`,
        slug: `bug12-cat-${Date.now()}`,
        isActive: true,
        isDeleted: false,
    });

    const createProductAndVariant = async (name, regularPrice, salePrice = null, stock = 10, isActive = true) => {
        const prod = await Product.create({
            name: `Bug12_${name}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            slug: `bug12-${name}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            categoryId: testCategory._id,
            brand: "Bug12Brand",
            description: "Bug12 Description",
            isActive: true,
            isDeleted: false,
        });

        const variant = await Variant.create({
            productId: prod._id,
            sku: `BUG12-${Math.random().toString(36).substring(2, 9).toUpperCase()}`,
            color: "Charcoal",
            size: "M",
            regularPrice,
            salePrice,
            stock,
            isActive,
            images: ["https://example.com/bug12.jpg"],
        });

        return { product: prod, variant };
    };

    const checkoutEjsPath = path.join(__dirname, "../views/user/checkout.ejs");
    const checkoutTemplate = fs.readFileSync(checkoutEjsPath, "utf-8");

    const renderCheckoutHtml = (data) => {
        return ejs.render(checkoutTemplate, {
            title: "Checkout",
            items: data.items || [],
            rawSubtotal: data.rawSubtotal,
            subtotal: data.subtotal,
            totalOfferDiscount: data.totalOfferDiscount,
            totalSaleDiscount: data.totalSaleDiscount,
            couponDiscount: data.couponDiscount || 0,
            appliedCoupon: data.appliedCoupon || null,
            couponError: data.couponError || null,
            shippingFee: data.shippingFee || 0,
            taxRate: data.taxRate || 0.05,
            taxableAmount: data.taxableAmount || 0,
            taxAmount: data.taxAmount || 0,
            totalAmount: data.totalAmount || 0,
            addresses: [],
            selectedAddress: null,
            walletBalance: 0,
            shippingThreshold: 500,
            shippingFlatFee: 50,
            checkoutToken: "tok_123",
            razorpayKeyId: "",
            notice: null,
            user: { fullName: "Bug12 Tester" },
        }, { filename: checkoutEjsPath });
    };

    console.log("--------------------------------------------------------------------------");
    console.log("TEST SCENARIO A: Regular ₹3,000, sale price ₹1,000, no active offer");
    console.log("--------------------------------------------------------------------------");
    {
        const { product, variant } = await createProductAndVariant("ItemA", 3000, 1000);

        // Calculate item price directly
        const itemPricing = pricingService.calculateItemPrice(variant, product, null);
        assert(itemPricing.regularPrice === 3000, "Scenario A item: regularPrice is 3000");
        assert(itemPricing.effectiveUnitPrice === 1000, "Scenario A item: effectiveUnitPrice is 1000 (sale price)");
        assert(itemPricing.unitOfferDiscount === 0, "Scenario A item: unitOfferDiscount is 0 (no promotional offer)");
        assert(itemPricing.unitSaleDiscount === 2000, "Scenario A item: unitSaleDiscount is 2000 (catalogue sale reduction)");
        assert(itemPricing.appliedOffer === null, "Scenario A item: appliedOffer is null");

        // Cart pricing calculation
        const cartItems = [{ variant, product, quantity: 1 }];
        const cartPricing = await pricingService.calculateCartPricing(cartItems, null, testUser._id);

        assert(cartPricing.rawSubtotal === 3000, "Scenario A cart: rawSubtotal is 3000");
        assert(cartPricing.subtotal === 1000, "Scenario A cart: subtotal is 1000 (selling price)");
        assert(cartPricing.totalOfferDiscount === 0, "Scenario A cart: totalOfferDiscount is strictly 0");
        assert(cartPricing.totalSaleDiscount === 2000, "Scenario A cart: totalSaleDiscount is 2000");

        // Render Checkout HTML
        const html = renderCheckoutHtml(cartPricing);
        assert(!html.includes('id="offerSavingsRow"'), "Scenario A checkout: offerSavingsRow is NOT rendered");
        assert(!html.includes('Offer Savings'), "Scenario A checkout: 'Offer Savings' text is NOT rendered");
        assert(html.includes('id="saleSavingsRow"'), "Scenario A checkout: saleSavingsRow IS rendered");
        assert(html.includes('Sale Savings'), "Scenario A checkout: 'Sale Savings' text IS rendered");
        assert(html.includes('id="summarySaleDiscount">-&#8377;2,000</span>'), "Scenario A checkout: Sale Savings shows -₹2,000");
        assert(html.includes('id="summarySubtotal">&#8377;1,000</span>'), "Scenario A checkout: Subtotal displays ₹1,000");
    }

    console.log("\n--------------------------------------------------------------------------");
    console.log("TEST SCENARIO B: Regular ₹1,000, no lower sale price, active 20% offer");
    console.log("--------------------------------------------------------------------------");
    {
        const { product, variant } = await createProductAndVariant("ItemB", 1000, null);

        const now = new Date();
        const activeOffer = await Offer.create({
            name: "Bug12_Promo_20Pct",
            offerType: "PRODUCT",
            productId: product._id,
            discountType: "PERCENTAGE",
            discountValue: 20,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        const itemPricing = pricingService.calculateItemPrice(variant, product, activeOffer);
        assert(itemPricing.regularPrice === 1000, "Scenario B item: regularPrice is 1000");
        assert(itemPricing.effectiveUnitPrice === 800, "Scenario B item: effectiveUnitPrice is 800 (1000 - 20%)");
        assert(itemPricing.unitOfferDiscount === 200, "Scenario B item: unitOfferDiscount is 200 (promotional savings)");
        assert(itemPricing.unitSaleDiscount === 0, "Scenario B item: unitSaleDiscount is 0");
        assert(itemPricing.appliedOffer !== null && itemPricing.appliedOffer.name === "Bug12_Promo_20Pct", "Scenario B item: appliedOffer is populated");

        const cartItems = [{ variant, product, quantity: 1 }];
        const cartPricing = await pricingService.calculateCartPricing(cartItems, null, testUser._id);

        assert(cartPricing.rawSubtotal === 1000, "Scenario B cart: rawSubtotal is 1000");
        assert(cartPricing.subtotal === 800, "Scenario B cart: subtotal is 800");
        assert(cartPricing.totalOfferDiscount === 200, "Scenario B cart: totalOfferDiscount is 200");
        assert(cartPricing.totalSaleDiscount === 0, "Scenario B cart: totalSaleDiscount is 0");

        const html = renderCheckoutHtml(cartPricing);
        assert(html.includes('id="offerSavingsRow"'), "Scenario B checkout: offerSavingsRow IS rendered");
        assert(html.includes('Offer Savings'), "Scenario B checkout: 'Offer Savings' text IS rendered");
        assert(html.includes('id="summaryOfferDiscount">-&#8377;200</span>'), "Scenario B checkout: shows Offer Savings -₹200");
        assert(!html.includes('id="saleSavingsRow"'), "Scenario B checkout: saleSavingsRow is NOT rendered");
    }

    console.log("\n--------------------------------------------------------------------------");
    console.log("TEST SCENARIO C: Regular ₹1,000, sale price ₹700, offer price ₹800 (20% off)");
    console.log("--------------------------------------------------------------------------");
    {
        const { product, variant } = await createProductAndVariant("ItemC", 1000, 700);

        const now = new Date();
        const activeOffer = await Offer.create({
            name: "Bug12_Promo_C_20Pct",
            offerType: "PRODUCT",
            productId: product._id,
            discountType: "PERCENTAGE",
            discountValue: 20,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        // 20% off 1000 = 800. But salePrice is 700 (< 800). Normal sale price wins!
        const itemPricing = pricingService.calculateItemPrice(variant, product, activeOffer);
        assert(itemPricing.effectiveUnitPrice === 700, "Scenario C item: effectiveUnitPrice is 700 (sale price beats offer)");
        assert(itemPricing.appliedOffer === null, "Scenario C item: appliedOffer is null because sale price won");
        assert(itemPricing.unitOfferDiscount === 0, "Scenario C item: unitOfferDiscount is 0");
        assert(itemPricing.unitSaleDiscount === 300, "Scenario C item: unitSaleDiscount is 300 (1000 - 700)");

        const cartItems = [{ variant, product, quantity: 1 }];
        const cartPricing = await pricingService.calculateCartPricing(cartItems, null, testUser._id);

        assert(cartPricing.subtotal === 700, "Scenario C cart: subtotal is 700");
        assert(cartPricing.totalOfferDiscount === 0, "Scenario C cart: totalOfferDiscount is 0");
        assert(cartPricing.totalSaleDiscount === 300, "Scenario C cart: totalSaleDiscount is 300");

        const html = renderCheckoutHtml(cartPricing);
        assert(!html.includes('id="offerSavingsRow"'), "Scenario C checkout: offerSavingsRow is NOT rendered");
        assert(html.includes('id="saleSavingsRow"'), "Scenario C checkout: saleSavingsRow IS rendered");
        assert(html.includes('id="summarySaleDiscount">-&#8377;300</span>'), "Scenario C checkout: Sale Savings shows -₹300");
    }

    console.log("\n--------------------------------------------------------------------------");
    console.log("TEST SCENARIO D: Product and Category offers both eligible (best price + caps)");
    console.log("--------------------------------------------------------------------------");
    {
        const { product, variant } = await createProductAndVariant("ItemD", 2000, null);

        const now = new Date();
        // Product offer: 30% capped at 250 -> discount = 250 -> price = 1750
        await Offer.create({
            name: "Bug12_Prod_30Pct_Cap250",
            offerType: "PRODUCT",
            productId: product._id,
            discountType: "PERCENTAGE",
            discountValue: 30,
            maxDiscount: 250,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        // Category offer: 20% capped at 500 -> discount = 400 -> price = 1600. Category offer wins!
        await Offer.create({
            name: "Bug12_Cat_20Pct_Cap500",
            offerType: "CATEGORY",
            categoryId: testCategory._id,
            discountType: "PERCENTAGE",
            discountValue: 20,
            maxDiscount: 500,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        const bestOffer = await pricingService.getBestActiveOffer(product._id, testCategory._id, now, 2000);
        assert(bestOffer.name === "Bug12_Cat_20Pct_Cap500", "Scenario D: Category offer wins due to higher discount under cap (400 vs 250)");

        const cartItems = [{ variant, product, quantity: 1 }];
        const cartPricing = await pricingService.calculateCartPricing(cartItems, null, testUser._id);

        assert(cartPricing.subtotal === 1600, "Scenario D: subtotal is 1600");
        assert(cartPricing.totalOfferDiscount === 400, "Scenario D: totalOfferDiscount is 400");
        assert(cartPricing.totalSaleDiscount === 0, "Scenario D: totalSaleDiscount is 0");
    }

    console.log("\n--------------------------------------------------------------------------");
    console.log("TEST SCENARIO E: Inactive, Expired, Future-dated, and Unrelated Offers");
    console.log("--------------------------------------------------------------------------");
    {
        const { product, variant } = await createProductAndVariant("ItemE", 1500, 1200);
        const now = new Date();

        // 1. Expired offer
        await Offer.create({
            name: "Bug12_Expired_Offer",
            offerType: "PRODUCT",
            productId: product._id,
            discountType: "PERCENTAGE",
            discountValue: 50,
            startDate: new Date(now.getTime() - 172800000),
            endDate: new Date(now.getTime() - 86400000),
            isActive: true,
        });

        // 2. Future offer
        await Offer.create({
            name: "Bug12_Future_Offer",
            offerType: "PRODUCT",
            productId: product._id,
            discountType: "PERCENTAGE",
            discountValue: 50,
            startDate: new Date(now.getTime() + 86400000),
            endDate: new Date(now.getTime() + 172800000),
            isActive: true,
        });

        // 3. Inactive offer
        await Offer.create({
            name: "Bug12_Inactive_Offer",
            offerType: "PRODUCT",
            productId: product._id,
            discountType: "PERCENTAGE",
            discountValue: 50,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: false,
        });

        // 4. Unrelated product offer
        const otherProduct = await Product.create({
            name: `Bug12_OtherProd_${Date.now()}`,
            slug: `bug12-other-${Date.now()}`,
            categoryId: testCategory._id,
            brand: "Bug12Other",
            isActive: true,
            isDeleted: false,
        });
        await Offer.create({
            name: "Bug12_Unrelated_Offer",
            offerType: "PRODUCT",
            productId: otherProduct._id,
            discountType: "PERCENTAGE",
            discountValue: 50,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        const bestOffer = await pricingService.getBestActiveOffer(product._id, testCategory._id, now, 1500);
        // Note: other tests created category offers on testCategory, but let's check product specific
        // Let's create an isolated category for scenario E to avoid cross-offer contamination
        const isoCat = await Category.create({ name: `Bug12_IsoCat_${Date.now()}`, slug: `bug12-isocat-${Date.now()}`, isActive: true, isDeleted: false });
        product.categoryId = isoCat._id;
        await product.save();

        const isoBestOffer = await pricingService.getBestActiveOffer(product._id, isoCat._id, now, 1500);
        assert(isoBestOffer === null, "Scenario E: None of the expired, future, inactive, or unrelated offers match");

        const cartItems = [{ variant, product, quantity: 1 }];
        const cartPricing = await pricingService.calculateCartPricing(cartItems, null, testUser._id);

        assert(cartPricing.totalOfferDiscount === 0, "Scenario E: totalOfferDiscount is 0");
        assert(cartPricing.totalSaleDiscount === 300, "Scenario E: totalSaleDiscount is 300 (1500 - 1200)");
        assert(cartPricing.subtotal === 1200, "Scenario E: subtotal is 1200");

        const html = renderCheckoutHtml(cartPricing);
        assert(!html.includes('id="offerSavingsRow"'), "Scenario E checkout: offerSavingsRow is NOT rendered");
    }

    console.log("\n--------------------------------------------------------------------------");
    console.log("TEST SCENARIO F: Multiple Items & Quantities Without Double Subtraction");
    console.log("--------------------------------------------------------------------------");
    {
        const isoCatF = await Category.create({ name: `Bug12_IsoCatF_${Date.now()}`, slug: `bug12-isocat-f-${Date.now()}`, isActive: true, isDeleted: false });

        // Item 1: Qty 2, Regular 2000, Sale 1500, no offer (unitSaleDiscount = 500, lineSaleDiscount = 1000)
        const item1 = await createProductAndVariant("ItemF1", 2000, 1500);
        item1.product.categoryId = isoCatF._id;
        await item1.product.save();

        // Item 2: Qty 3, Regular 1000, no sale price, 10% offer (unitOfferDiscount = 100, lineOfferDiscount = 300)
        const item2 = await createProductAndVariant("ItemF2", 1000, null);
        item2.product.categoryId = isoCatF._id;
        await item2.product.save();

        const now = new Date();
        await Offer.create({
            name: "Bug12_Offer_F2",
            offerType: "PRODUCT",
            productId: item2.product._id,
            discountType: "PERCENTAGE",
            discountValue: 10,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        // Item 3: Qty 1, Regular 500, no sale price, no offer
        const item3 = await createProductAndVariant("ItemF3", 500, null);
        item3.product.categoryId = isoCatF._id;
        await item3.product.save();

        const cartItems = [
            { variant: item1.variant, product: item1.product, quantity: 2 },
            { variant: item2.variant, product: item2.product, quantity: 3 },
            { variant: item3.variant, product: item3.product, quantity: 1 },
        ];

        const cartPricing = await pricingService.calculateCartPricing(cartItems, null, testUser._id);

        // Raw subtotal: (2000 * 2) + (1000 * 3) + 500 = 4000 + 3000 + 500 = 7500
        assert(cartPricing.rawSubtotal === 7500, `Scenario F: rawSubtotal is 7500 (observed: ${cartPricing.rawSubtotal})`);
        // Total Sale Discount: 500 * 2 = 1000
        assert(cartPricing.totalSaleDiscount === 1000, `Scenario F: totalSaleDiscount is 1000 (observed: ${cartPricing.totalSaleDiscount})`);
        // Total Offer Discount: 100 * 3 = 300
        assert(cartPricing.totalOfferDiscount === 300, `Scenario F: totalOfferDiscount is 300 (observed: ${cartPricing.totalOfferDiscount})`);
        // Effective Subtotal: (1500 * 2) + (900 * 3) + 500 = 3000 + 2700 + 500 = 6200
        assert(cartPricing.subtotal === 6200, `Scenario F: subtotal is 6200 (observed: ${cartPricing.subtotal})`);
        // Verification of consistency: rawSubtotal - totalSaleDiscount - totalOfferDiscount === subtotal
        assert(cartPricing.rawSubtotal - cartPricing.totalSaleDiscount - cartPricing.totalOfferDiscount === cartPricing.subtotal,
            "Scenario F: rawSubtotal - totalSaleDiscount - totalOfferDiscount === subtotal (no double counting)");

        const html = renderCheckoutHtml(cartPricing);
        assert(html.includes('id="saleSavingsRow"'), "Scenario F checkout: saleSavingsRow is rendered");
        assert(html.includes('id="summarySaleDiscount">-&#8377;1,000</span>'), "Scenario F checkout: Sale Savings shows -₹1,000");
        assert(html.includes('id="offerSavingsRow"'), "Scenario F checkout: offerSavingsRow is rendered");
        assert(html.includes('id="summaryOfferDiscount">-&#8377;300</span>'), "Scenario F checkout: Offer Savings shows -₹300");
        assert(html.includes('id="summarySubtotal">&#8377;6,200</span>'), "Scenario F checkout: Subtotal shows ₹6,200");
    }

    console.log("\n--------------------------------------------------------------------------");
    console.log("TEST SCENARIO G: Apply/Remove Coupon & Reconcile Tax, Shipping, Totals");
    console.log("--------------------------------------------------------------------------");
    {
        const isoCatG = await Category.create({ name: `Bug12_IsoCatG_${Date.now()}`, slug: `bug12-isocat-g-${Date.now()}`, isActive: true, isDeleted: false });

        // Item with sale price: Regular 2000, Sale 1000 (Sale discount 1000)
        const item1 = await createProductAndVariant("ItemG1", 2000, 1000);
        item1.product.categoryId = isoCatG._id;
        await item1.product.save();

        // Item with offer: Regular 1000, 20% offer (Offer discount 200)
        const item2 = await createProductAndVariant("ItemG2", 1000, null);
        item2.product.categoryId = isoCatG._id;
        await item2.product.save();

        const now = new Date();
        await Offer.create({
            name: "Bug12_Offer_G2",
            offerType: "PRODUCT",
            productId: item2.product._id,
            discountType: "PERCENTAGE",
            discountValue: 20,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        // Create Coupon: Flat 100 off
        const coupon = await Coupon.create({
            code: `BUG12_CPN_${Date.now()}`,
            discountType: "FLAT",
            discountValue: 100,
            minPurchaseAmount: 500,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        const cartItems = [
            { variant: item1.variant, product: item1.product, quantity: 1 },
            { variant: item2.variant, product: item2.product, quantity: 1 },
        ];

        // 1. Without Coupon
        const pricingBeforeCoupon = await pricingService.calculateCartPricing(cartItems, null, testUser._id);
        assert(pricingBeforeCoupon.subtotal === 1800, "Scenario G before coupon: subtotal is 1800 (1000 + 800)");
        assert(pricingBeforeCoupon.totalSaleDiscount === 1000, "Scenario G before coupon: totalSaleDiscount is 1000");
        assert(pricingBeforeCoupon.totalOfferDiscount === 200, "Scenario G before coupon: totalOfferDiscount is 200");
        assert(pricingBeforeCoupon.couponDiscount === 0, "Scenario G before coupon: couponDiscount is 0");
        assert(pricingBeforeCoupon.taxableAmount === 1800, "Scenario G before coupon: taxableAmount is 1800");
        assert(pricingBeforeCoupon.taxAmount === 90, "Scenario G before coupon: 5% tax is 90");
        assert(pricingBeforeCoupon.shippingFee === 0, "Scenario G before coupon: shipping is FREE (> 500)");
        assert(pricingBeforeCoupon.totalAmount === 1890, "Scenario G before coupon: total is 1890");

        // 2. With Coupon Applied
        const pricingWithCoupon = await pricingService.calculateCartPricing(cartItems, coupon.code, testUser._id);
        assert(pricingWithCoupon.subtotal === 1800, "Scenario G with coupon: subtotal remains 1800");
        assert(pricingWithCoupon.totalSaleDiscount === 1000, "Scenario G with coupon: totalSaleDiscount is STILL 1000 (unchanged)");
        assert(pricingWithCoupon.totalOfferDiscount === 200, "Scenario G with coupon: totalOfferDiscount is STILL 200 (unchanged)");
        assert(pricingWithCoupon.couponDiscount === 100, "Scenario G with coupon: couponDiscount is 100");
        assert(pricingWithCoupon.taxableAmount === 1700, "Scenario G with coupon: taxableAmount is 1700 (1800 - 100)");
        assert(pricingWithCoupon.taxAmount === 85, "Scenario G with coupon: 5% tax on 1700 is 85");
        assert(pricingWithCoupon.shippingFee === 0, "Scenario G with coupon: shipping is FREE");
        assert(pricingWithCoupon.totalAmount === 1785, "Scenario G with coupon: totalAmount is 1785 (1700 + 85)");

        // 3. Remove Coupon (evaluate without coupon code)
        const pricingAfterRemoval = await pricingService.calculateCartPricing(cartItems, "", testUser._id);
        assert(pricingAfterRemoval.totalSaleDiscount === 1000, "Scenario G after coupon removed: totalSaleDiscount remains 1000");
        assert(pricingAfterRemoval.totalOfferDiscount === 200, "Scenario G after coupon removed: totalOfferDiscount remains 200");
        assert(pricingAfterRemoval.couponDiscount === 0, "Scenario G after coupon removed: couponDiscount is 0");
        assert(pricingAfterRemoval.totalAmount === 1890, "Scenario G after coupon removed: total reconciles back to 1890");
    }

    console.log("\n--------------------------------------------------------------------------");
    console.log("TEST SCENARIO H: Unavailable Cart Items Excluded from Savings & Totals");
    console.log("--------------------------------------------------------------------------");
    {
        const isoCatH = await Category.create({ name: `Bug12_IsoCatH_${Date.now()}`, slug: `bug12-isocat-h-${Date.now()}`, isActive: true, isDeleted: false });

        // Available item: Regular 1000, Sale 800 (Sale discount 200)
        const availItem = await createProductAndVariant("AvailH", 1000, 800, 5, true);
        availItem.product.categoryId = isoCatH._id;
        await availItem.product.save();

        // Unavailable item 1: out of stock (Regular 3000, Sale 1000)
        const oosItem = await createProductAndVariant("OOSH", 3000, 1000, 0, true);
        oosItem.product.categoryId = isoCatH._id;
        await oosItem.product.save();

        // Unavailable item 2: inactive variant (Regular 2000, 20% active offer)
        const inactiveItem = await createProductAndVariant("InactiveH", 2000, null, 10, false);
        inactiveItem.product.categoryId = isoCatH._id;
        await inactiveItem.product.save();

        const now = new Date();
        await Offer.create({
            name: "Bug12_Offer_InactiveH",
            offerType: "PRODUCT",
            productId: inactiveItem.product._id,
            discountType: "PERCENTAGE",
            discountValue: 20,
            startDate: new Date(now.getTime() - 86400000),
            endDate: new Date(now.getTime() + 86400000),
            isActive: true,
        });

        const cartItems = [
            { variant: availItem.variant, product: availItem.product, quantity: 1, isAvailable: true },
            { variant: oosItem.variant, product: oosItem.product, quantity: 1, isAvailable: false },
            { variant: inactiveItem.variant, product: inactiveItem.product, quantity: 1, isAvailable: false },
        ];

        const cartPricing = await pricingService.calculateCartPricing(cartItems, null, testUser._id);

        assert(cartPricing.subtotal === 800, `Scenario H: subtotal includes ONLY available item = 800 (observed: ${cartPricing.subtotal})`);
        assert(cartPricing.totalSaleDiscount === 200, `Scenario H: totalSaleDiscount includes ONLY available item = 200 (observed: ${cartPricing.totalSaleDiscount})`);
        assert(cartPricing.totalOfferDiscount === 0, `Scenario H: totalOfferDiscount is 0 (inactive item offer excluded)`);
        assert(cartPricing.taxAmount === 40, "Scenario H: tax is 5% of 800 = 40");
        assert(cartPricing.shippingFee === 100, "Scenario H: shipping is flat fee 100 (< 1000)");
        assert(cartPricing.totalAmount === 940, "Scenario H: totalAmount is 940 (800 + 40 + 100)");
    }

    console.log("\n--------------------------------------------------------------------------");
    console.log("TEST SCENARIO I: Order Document Snapshot & Consistency");
    console.log("--------------------------------------------------------------------------");
    {
        const isoCatI = await Category.create({ name: `Bug12_IsoCatI_${Date.now()}`, slug: `bug12-isocat-i-${Date.now()}`, isActive: true, isDeleted: false });

        // Item with sale price ₹1,000 from ₹3,000
        const { product, variant } = await createProductAndVariant("OrderSnapItem", 3000, 1000);
        product.categoryId = isoCatI._id;
        await product.save();

        // User setup
        const user = await User.create({
            fullName: "Bug12 Order Tester",
            email: `bug12_order_${Date.now()}@example.com`,
            password: "Password123!",
        });

        const address = await Address.create({
            userId: user._id,
            firstName: "Bug12",
            lastName: "Tester",
            addressLine1: "123 Bug12 Street",
            phone: "9876543210",
            city: "Mumbai",
            state: "Maharashtra",
            pinCode: 400001,
            country: "India",
            isDefault: true,
        });

        await Cart.create({
            userId: user._id,
            items: [{ variantId: variant._id, quantity: 1, priceSnapshot: variant.salePrice || variant.regularPrice }],
        });

        // Place COD order
        const placeResult = await orderService.placeOrder(user._id, address._id, "COD");
        assert(placeResult.success === true, "Scenario I: Order placed successfully");

        const order = await Order.findById(placeResult.order._id);
        assert(order !== null, "Scenario I: Order retrieved from database");
        assert(order.pricing.subtotal === 1000, "Scenario I: order.pricing.subtotal is 1000");
        assert(order.pricing.offerDiscount === 0, `Scenario I: order.pricing.offerDiscount is strictly 0 (observed: ${order.pricing.offerDiscount})`);
        assert(order.pricing.saleDiscount === 2000, `Scenario I: order.pricing.saleDiscount is 2000 (observed: ${order.pricing.saleDiscount})`);
        assert(order.items[0].offerDiscount === 0, "Scenario I: item.offerDiscount is strictly 0");
        assert(order.items[0].saleDiscount === 2000, "Scenario I: item.saleDiscount is 2000");
        assert(order.items[0].effectiveUnitPrice === 1000, "Scenario I: item.effectiveUnitPrice is 1000");
    }

    console.log("\n==========================================================================");
    console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
    if (failures.length > 0) {
        console.log("FAILURES:");
        failures.forEach((f) => console.log(" - " + f));
    }
    console.log("==========================================================================");

    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
