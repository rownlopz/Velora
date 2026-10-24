const mongoose = require("mongoose");
const Coupon = require("../models/order/couponModel");
const Offer = require("../models/product/offerModel");
const Product = require("../models/product/productModel");
const Category = require("../models/product/categoryModel");
const couponService = require("../services/admin/couponService");
const offerService = require("../services/admin/offerService");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

async function runTests() {
    console.log("Connecting to test DB:", TEST_DB_URI);
    await mongoose.connect(TEST_DB_URI);
    console.log("Connected successfully.");

    try {
        // Cleanup old test data
        await Coupon.deleteMany({ code: { $in: ["EDITTEST1", "EDITTEST2", "EDITTEST_RENAMED", "EXISTING_CPN"] } });
        await Offer.deleteMany({ name: { $regex: /^TEST_EDIT_OFFER/ } });

        console.log("\n==================== 1. COUPON EDITING SERVICE TESTS ====================");
        
        // 1.1 Create initial coupon
        const createRes = await couponService.createCoupon({
            code: "EDITTEST1",
            description: "Initial description",
            discountType: "PERCENTAGE",
            discountValue: 10,
            minPurchase: 500,
            maxDiscount: 200,
            usageLimit: 50,
            perUserLimit: 1,
            startDate: "2026-10-24",
            endDate: "2026-11-24",
        });
        if (!createRes.success) throw new Error("Failed to create initial coupon: " + createRes.message);
        const couponId = createRes.coupon._id.toString();
        console.log("✓ Initial coupon created:", couponId);

        // 1.2 Get coupon by ID
        const getRes = await couponService.getCouponById(couponId);
        if (!getRes.success || getRes.coupon.code !== "EDITTEST1") {
            throw new Error("getCouponById failed or wrong code returned.");
        }
        console.log("✓ getCouponById successfully fetched coupon");

        // 1.3 Update coupon: update fields, same code
        const updateRes1 = await couponService.updateCoupon(couponId, {
            code: "EDITTEST1",
            description: "Updated description",
            discountType: "PERCENTAGE",
            discountValue: 25,
            minPurchase: 1000,
            maxDiscount: 400,
            usageLimit: 100,
            perUserLimit: 2,
            startDate: "2026-10-25",
            endDate: "2026-12-01",
        });
        if (!updateRes1.success) throw new Error("Update 1 failed: " + updateRes1.message);
        if (updateRes1.coupon.discountValue !== 25 || updateRes1.coupon.perUserLimit !== 2) {
            throw new Error("Update 1 did not set expected values.");
        }
        console.log("✓ Coupon successfully updated with same code and modified fields");

        // 1.4 Update coupon: rename code
        const updateRes2 = await couponService.updateCoupon(couponId, {
            code: "EDITTEST_RENAMED",
        });
        if (!updateRes2.success || updateRes2.coupon.code !== "EDITTEST_RENAMED") {
            throw new Error("Update 2 failed to rename code: " + updateRes2.message);
        }
        console.log("✓ Coupon successfully renamed to EDITTEST_RENAMED");

        // 1.5 Update coupon: duplicate code check against another existing coupon
        await couponService.createCoupon({
            code: "EXISTING_CPN",
            discountType: "FLAT",
            discountValue: 50,
            minPurchase: 0,
            startDate: "2026-10-24",
            endDate: "2026-11-24",
        });

        const duplicateUpdateRes = await couponService.updateCoupon(couponId, {
            code: "EXISTING_CPN",
        });
        if (duplicateUpdateRes.success) {
            throw new Error("Update should have failed due to duplicate code with another coupon!");
        }
        console.log("✓ Duplicate coupon code correctly rejected:", duplicateUpdateRes.message);

        // 1.6 Update coupon: FLAT type clears maxDiscount
        const updateResFlat = await couponService.updateCoupon(couponId, {
            discountType: "FLAT",
            discountValue: 150,
            maxDiscount: null,
        });
        if (!updateResFlat.success || updateResFlat.coupon.discountType !== "FLAT" || updateResFlat.coupon.maxDiscount !== null) {
            throw new Error("Update to FLAT failed or did not clear maxDiscount.");
        }
        console.log("✓ Coupon updated to FLAT discount type successfully");

        // 1.7 Validation checks on coupon update
        const invalidPct = await couponService.updateCoupon(couponId, {
            discountType: "PERCENTAGE",
            discountValue: 120, // > 100%
        });
        if (invalidPct.success) throw new Error("Should have rejected percentage discount > 100%");
        console.log("✓ Percentage > 100% correctly rejected:", invalidPct.message);

        const invalidDates = await couponService.updateCoupon(couponId, {
            startDate: "2026-12-01",
            endDate: "2026-10-01",
        });
        if (invalidDates.success) throw new Error("Should have rejected start > end date");
        console.log("✓ Start date after end date correctly rejected:", invalidDates.message);


        console.log("\n==================== 2. OFFER EDITING SERVICE TESTS ====================");
        
        // Find or create a test product and test category
        let testCat1 = await Category.findOne({ isDeleted: false });
        if (!testCat1) {
            testCat1 = await Category.create({ name: "Test Category 1", slug: "test-category-1", isActive: true, isDeleted: false });
        }
        let testCat2 = await Category.create({ name: "Test Category 2", slug: "test-category-2", isActive: true, isDeleted: false });

        let testProd = await Product.findOne({ isDeleted: false });
        if (!testProd) {
            testProd = await Product.create({
                name: "Test Oxford Shoes",
                category: testCat1._id,
                brand: "Velora Classic",
                isDeleted: false,
                status: "ACTIVE",
            });
        }

        // 2.1 Create initial Product Offer
        const createOfferRes = await offerService.createOffer({
            name: "TEST_EDIT_OFFER_INITIAL",
            offerType: "PRODUCT",
            productId: testProd._id.toString(),
            discountType: "PERCENTAGE",
            discountValue: 15,
            maxDiscount: 300,
            startDate: "2026-10-24",
            endDate: "2026-11-24",
        });
        if (!createOfferRes.success) throw new Error("Failed to create initial offer: " + createOfferRes.message);
        const offerId = createOfferRes.offer._id.toString();
        console.log("✓ Initial product offer created:", offerId);

        // 2.2 Get offer by ID
        const getOfferRes = await offerService.getOfferById(offerId);
        if (!getOfferRes.success || getOfferRes.offer.name !== "TEST_EDIT_OFFER_INITIAL") {
            throw new Error("getOfferById failed or returned wrong offer.");
        }
        console.log("✓ getOfferById successfully fetched offer with populated fields");

        // 2.3 Update offer: switch from PRODUCT to CATEGORY
        const updateOfferRes1 = await offerService.updateOffer(offerId, {
            name: "TEST_EDIT_OFFER_UPDATED_CAT",
            offerType: "CATEGORY",
            categoryId: testCat2._id.toString(),
            discountType: "PERCENTAGE",
            discountValue: 20,
            maxDiscount: 500,
            startDate: "2026-10-25",
            endDate: "2026-12-15",
        });
        if (!updateOfferRes1.success) throw new Error("Failed to update offer to CATEGORY: " + updateOfferRes1.message);
        if (updateOfferRes1.offer.offerType !== "CATEGORY" || String(updateOfferRes1.offer.categoryId) !== String(testCat2._id)) {
            throw new Error("Offer type or categoryId not updated properly.");
        }
        if (updateOfferRes1.offer.productId !== null) {
            throw new Error("Offer productId was not nulled when switched to CATEGORY.");
        }
        console.log("✓ Offer successfully switched from PRODUCT to CATEGORY with updated discount and validity");

        // 2.4 Update offer: switch back to PRODUCT
        const updateOfferRes2 = await offerService.updateOffer(offerId, {
            offerType: "PRODUCT",
            productId: testProd._id.toString(),
            discountType: "FLAT",
            discountValue: 250,
            maxDiscount: null,
        });
        if (!updateOfferRes2.success) throw new Error("Failed to switch offer back to PRODUCT: " + updateOfferRes2.message);
        if (updateOfferRes2.offer.offerType !== "PRODUCT" || String(updateOfferRes2.offer.productId) !== String(testProd._id)) {
            throw new Error("Offer was not switched back to PRODUCT.");
        }
        if (updateOfferRes2.offer.categoryId !== null) {
            throw new Error("Offer categoryId was not nulled when switched to PRODUCT.");
        }
        console.log("✓ Offer successfully switched back from CATEGORY to PRODUCT");

        // 2.5 Validation checks on offer update
        const invalidOfferPct = await offerService.updateOffer(offerId, {
            discountType: "PERCENTAGE",
            discountValue: 95, // Max allowed is 90%
        });
        if (invalidOfferPct.success) throw new Error("Should have rejected offer discount > 90%");
        console.log("✓ Percentage > 90% correctly rejected:", invalidOfferPct.message);

        const invalidOfferDates = await offerService.updateOffer(offerId, {
            startDate: "2026-12-25",
            endDate: "2026-10-25",
        });
        if (invalidOfferDates.success) throw new Error("Should have rejected offer start > end date");
        console.log("✓ Offer start date after end date correctly rejected:", invalidOfferDates.message);

        console.log("\n==================== 3. CONTROLLER & HTTP RESPONSE TESTS ====================");
        const couponController = require("../controllers/admin/couponController");
        const offerController = require("../controllers/admin/offerController");

        function createMockReqRes({ params = {}, body = {}, query = {}, isAjax = true }) {
            let statusCode = 200;
            let jsonBody = null;
            let redirectUrl = null;

            const req = {
                params,
                body,
                query,
                xhr: isAjax,
                headers: {
                    accept: isAjax ? "application/json" : "text/html",
                    "x-requested-with": isAjax ? "XMLHttpRequest" : "",
                },
                is: (type) => isAjax && type === "json",
            };

            const res = {
                status(code) {
                    statusCode = code;
                    return this;
                },
                json(data) {
                    jsonBody = data;
                    return this;
                },
                redirect(url) {
                    redirectUrl = url;
                    return this;
                },
                getStatusCode: () => statusCode,
                getJsonBody: () => jsonBody,
                getRedirectUrl: () => redirectUrl,
            };

            return { req, res };
        }

        // 3.1 Test getCouponController
        {
            const { req, res } = createMockReqRes({ params: { couponId } });
            await couponController.getCouponController(req, res);
            if (res.getStatusCode() !== 200 || !res.getJsonBody().success) {
                throw new Error("getCouponController failed: " + JSON.stringify(res.getJsonBody()));
            }
            console.log("✓ getCouponController returned HTTP 200 with coupon details");
        }

        // 3.2 Test updateCouponController via AJAX
        {
            const { req, res } = createMockReqRes({
                params: { couponId },
                body: { code: "AJAX_EDITED", discountType: "FLAT", discountValue: 120 },
                isAjax: true,
            });
            await couponController.updateCouponController(req, res);
            if (res.getStatusCode() !== 200 || !res.getJsonBody().success) {
                throw new Error("updateCouponController (AJAX) failed: " + JSON.stringify(res.getJsonBody()));
            }
            console.log("✓ updateCouponController returned HTTP 200 JSON on AJAX update");
        }

        // 3.3 Test updateCouponController via Form Redirect
        {
            const { req, res } = createMockReqRes({
                params: { couponId },
                body: { code: "REDIRECT_EDIT", discountType: "FLAT", discountValue: 130 },
                isAjax: false,
            });
            await couponController.updateCouponController(req, res);
            if (!res.getRedirectUrl() || !res.getRedirectUrl().includes("success=")) {
                throw new Error("updateCouponController (Redirect) failed: " + res.getRedirectUrl());
            }
            console.log("✓ updateCouponController redirected with success query param on form submit");
        }

        // 3.4 Test getOfferController
        {
            const { req, res } = createMockReqRes({ params: { offerId } });
            await offerController.getOfferController(req, res);
            if (res.getStatusCode() !== 200 || !res.getJsonBody().success) {
                throw new Error("getOfferController failed: " + JSON.stringify(res.getJsonBody()));
            }
            console.log("✓ getOfferController returned HTTP 200 with offer details");
        }

        // 3.5 Test updateOfferController via AJAX
        {
            const { req, res } = createMockReqRes({
                params: { offerId },
                body: { name: "AJAX_OFFER_EDIT", discountType: "PERCENTAGE", discountValue: 30 },
                isAjax: true,
            });
            await offerController.updateOfferController(req, res);
            if (res.getStatusCode() !== 200 || !res.getJsonBody().success) {
                throw new Error("updateOfferController (AJAX) failed: " + JSON.stringify(res.getJsonBody()));
            }
            console.log("✓ updateOfferController returned HTTP 200 JSON on AJAX update");
        }

        // 3.6 Test updateOfferController via Form Redirect
        {
            const { req, res } = createMockReqRes({
                params: { offerId },
                body: { name: "REDIRECT_OFFER_EDIT", discountType: "PERCENTAGE", discountValue: 35 },
                isAjax: false,
            });
            await offerController.updateOfferController(req, res);
            if (!res.getRedirectUrl() || !res.getRedirectUrl().includes("success=")) {
                throw new Error("updateOfferController (Redirect) failed: " + res.getRedirectUrl());
            }
            console.log("✓ updateOfferController redirected with success query param on form submit");
        }

        // Cleanup
        await Coupon.deleteMany({ code: { $in: ["EDITTEST1", "EDITTEST2", "EDITTEST_RENAMED", "EXISTING_CPN", "AJAX_EDITED", "REDIRECT_EDIT"] } });
        await Offer.deleteMany({ _id: offerId });
        await Category.deleteOne({ _id: testCat2._id });

        console.log("\n==================== ALL EDITING & CONTROLLER TESTS PASSED ====================\n");
    } finally {
        await mongoose.disconnect();
    }
}

runTests().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
