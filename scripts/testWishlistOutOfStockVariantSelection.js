const mongoose = require("mongoose");
const ejs = require("ejs");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const User = require("../models/user/userModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Category = require("../models/product/categoryModel");
const Wishlist = require("../models/user/wishlistModel");
const Cart = require("../models/order/cartModel");

const { addToWishlist, getWishlistDetails } = require("../services/user/wishlistService");
const { addToCart, getCartDetails } = require("../services/user/cartService");

async function runTests() {
    console.log("Connecting to test DB:", TEST_DB_URI);
    await mongoose.connect(TEST_DB_URI);
    console.log("Connected successfully.\n");

    try {
        // Setup test user
        let testUser = await User.findOne({ email: "wishlist_test@velora.test" });
        if (!testUser) {
            testUser = await User.create({
                fullName: "Wishlist Tester",
                email: "wishlist_test@velora.test",
                password: "Password123!",
                phone: "9876543299",
            });
        }

        // Setup category
        let testCat = await Category.findOne({ name: "Wishlist Test Category" });
        if (!testCat) {
            testCat = await Category.create({
                name: "Wishlist Test Category",
                slug: "wishlist-test-category",
                isActive: true,
                isDeleted: false,
            });
        }

        // Clean previous test products
        const existingProducts = await Product.find({ name: { $regex: /^TEST_WISHLIST_/ } });
        const existingProdIds = existingProducts.map(p => p._id);
        await Variant.deleteMany({ productId: { $in: existingProdIds } });
        await Product.deleteMany({ _id: { $in: existingProdIds } });
        await Wishlist.deleteOne({ userId: testUser._id });
        await Cart.deleteOne({ userId: testUser._id });

        console.log("==========================================================================");
        console.log("TEST 1: Product with Out-of-Stock Saved Variant & In-Stock Alternative Variant");
        console.log("==========================================================================");

        const productA = await Product.create({
            name: "TEST_WISHLIST_OXFORD_A",
            slug: "test-wishlist-oxford-a",
            categoryId: testCat._id,
            brand: "Velora Bespoke",
            status: "ACTIVE",
            isDeleted: false,
            thumbnail: "/images/test-thumb.jpg",
        });

        // Variant 1: Size 8 (Stock 0 - Out of stock)
        const variantA1 = await Variant.create({
            productId: productA._id,
            sku: "TEST-OX-A-8",
            size: "8",
            color: "Black",
            stock: 0,
            regularPrice: 2000,
            salePrice: 1500,
            isActive: true,
        });

        // Variant 2: Size 9 (Stock 5 - In stock)
        const variantA2 = await Variant.create({
            productId: productA._id,
            sku: "TEST-OX-A-9",
            size: "9",
            color: "Black",
            stock: 5,
            regularPrice: 2000,
            salePrice: 1500,
            isActive: true,
        });

        // Save Variant 1 (out of stock) to user's wishlist
        await addToWishlist(testUser._id, variantA1._id);
        console.log("✓ Saved out-of-stock Variant A1 (Size 8, Stock: 0) to wishlist");

        // Fetch wishlist details
        const detailsA = await getWishlistDetails(testUser._id);
        const itemA = detailsA.items.find(i => i.variantId.toString() === variantA1._id.toString());

        assert(itemA, "Wishlist item must exist");
        assert.strictEqual(itemA.isInStock, false, "itemA.isInStock should be false (saved variant stock = 0)");
        assert.strictEqual(itemA.hasInStockVariants, true, "itemA.hasInStockVariants must be true because Variant A2 has stock 5");
        assert.strictEqual(itemA.inStockVariantCount, 1, "itemA.inStockVariantCount must be 1");
        assert.strictEqual(itemA.isAvailable, true, "itemA.isAvailable must be true (product and other variant are available)");
        console.log("✓ wishlistService correctly flags isInStock: false and hasInStockVariants: true");

        console.log("\n==========================================================================");
        console.log("TEST 2: Product where ALL Variants are Out of Stock");
        console.log("==========================================================================");

        const productB = await Product.create({
            name: "TEST_WISHLIST_BOOT_B",
            slug: "test-wishlist-boot-b",
            categoryId: testCat._id,
            brand: "Velora Boots",
            status: "ACTIVE",
            isDeleted: false,
            thumbnail: "/images/test-boot.jpg",
        });

        // Variant B1: Stock 0
        const variantB1 = await Variant.create({
            productId: productB._id,
            sku: "TEST-BOOT-B-8",
            size: "8",
            color: "Brown",
            stock: 0,
            regularPrice: 3000,
            isActive: true,
        });

        // Variant B2: Stock 0
        const variantB2 = await Variant.create({
            productId: productB._id,
            sku: "TEST-BOOT-B-9",
            size: "9",
            color: "Brown",
            stock: 0,
            regularPrice: 3000,
            isActive: true,
        });

        await addToWishlist(testUser._id, variantB1._id);
        console.log("✓ Saved Variant B1 (where all variants have stock 0) to wishlist");

        const detailsB = await getWishlistDetails(testUser._id);
        const itemB = detailsB.items.find(i => i.variantId.toString() === variantB1._id.toString());

        assert(itemB, "Wishlist item B must exist");
        assert.strictEqual(itemB.isInStock, false, "itemB.isInStock should be false");
        assert.strictEqual(itemB.hasInStockVariants, false, "itemB.hasInStockVariants must be false when all variants have stock 0");
        assert.strictEqual(itemB.inStockVariantCount, 0, "itemB.inStockVariantCount must be 0");
        console.log("✓ wishlistService correctly flags hasInStockVariants: false when all variants are out of stock");

        console.log("\n==========================================================================");
        console.log("TEST 3: Product where Saved Variant IS in Stock");
        console.log("==========================================================================");

        const productC = await Product.create({
            name: "TEST_WISHLIST_LOAFER_C",
            slug: "test-wishlist-loafer-c",
            categoryId: testCat._id,
            brand: "Velora Loafers",
            status: "ACTIVE",
            isDeleted: false,
            thumbnail: "/images/test-loafer.jpg",
        });

        const variantC1 = await Variant.create({
            productId: productC._id,
            sku: "TEST-LOAF-C-8",
            size: "8",
            color: "Burgundy",
            stock: 4,
            regularPrice: 2500,
            isActive: true,
        });

        await addToWishlist(testUser._id, variantC1._id);
        const detailsC = await getWishlistDetails(testUser._id);
        const itemC = detailsC.items.find(i => i.variantId.toString() === variantC1._id.toString());

        assert(itemC, "Wishlist item C must exist");
        assert.strictEqual(itemC.isInStock, true, "itemC.isInStock must be true");
        assert.strictEqual(itemC.hasInStockVariants, true, "itemC.hasInStockVariants must be true");
        console.log("✓ wishlistService correctly flags isInStock: true for in-stock variant");

        console.log("\n==========================================================================");
        console.log("TEST 4: Wishlist EJS View Template Rendering Verification");
        console.log("==========================================================================");

        const wishlistEjsPath = path.join(__dirname, "../views/user/wishlist.ejs");
        const ejsTemplate = fs.readFileSync(wishlistEjsPath, "utf-8");

        // Render with itemA, itemB, itemC (stub includes to avoid loading full layout dependencies)
        // Extract the main grid portion from wishlist.ejs to test the exact rendering logic
        const renderedHtml = ejs.render(ejsTemplate, {
            title: "My Wishlist",
            items: [itemA, itemB, itemC],
            totalItems: 3,
            totalPages: 1,
            currentPage: 1,
        }, {
            filename: wishlistEjsPath,
            root: path.join(__dirname, "../views"),
        });

        // 4.1 Verify Item A (out-of-stock saved variant, but other variant available):
        // Must contain "Select Variant" button with data-in-stock="false"
        assert(renderedHtml.includes("Select Variant"), "View must render 'Select Variant' button when another variant is available!");
        assert(renderedHtml.includes(`data-variant-id="${variantA1._id}"`), "Must attach variantId to Select Variant button");
        assert(renderedHtml.includes('data-in-stock="false"'), "Must flag data-in-stock='false' for out-of-stock saved variant");
        assert(renderedHtml.includes("Option Out of Stock"), "Badge should indicate Option Out of Stock");
        console.log("✓ Item A rendered with enabled 'Select Variant' button and 'Option Out of Stock' badge");

        // 4.2 Verify Item B (all variants out of stock):
        // Must contain disabled "Out of Stock" span
        assert(renderedHtml.includes("cursor-not-allowed"), "View must contain cursor-not-allowed for genuinely out of stock item");
        console.log("✓ Item B rendered with disabled 'Out of Stock' state");

        // 4.3 Verify Item C (saved variant in stock):
        // Must contain "Move to Cart" button with data-in-stock="true"
        assert(renderedHtml.includes("Move to Cart"), "View must render 'Move to Cart' button for in-stock item");
        assert(renderedHtml.includes('data-in-stock="true"'), "Must flag data-in-stock='true' for in-stock variant");
        console.log("✓ Item C rendered with enabled 'Move to Cart' button");

        console.log("\n==========================================================================");
        console.log("TEST 5: Moving Available Alternative Variant to Cart & Wishlist Auto-Removal");
        console.log("==========================================================================");

        // Add Variant A2 (in-stock) to cart, passing sourceVariantId = variantA1._id (the out-of-stock saved variant)
        const addCartRes = await addToCart(testUser._id, variantA2._id.toString(), 1, variantA1._id.toString());
        assert(addCartRes.success, "addToCart should succeed for available variant A2: " + addCartRes.message);

        // Check cart contains Variant A2
        const cartDetails = await getCartDetails(testUser._id);
        const cartItemA2 = cartDetails.items.find(i => i.variantId.toString() === variantA2._id.toString());
        assert(cartItemA2, "Cart must contain Variant A2");
        assert.strictEqual(cartItemA2.quantity, 1, "Cart item quantity should be 1");
        console.log("✓ Alternative in-stock Variant A2 successfully added to user cart");

        // Check wishlist NO LONGER contains Variant A1
        const updatedWishlist = await getWishlistDetails(testUser._id);
        const remainingA1 = updatedWishlist.items.find(i => i.variantId.toString() === variantA1._id.toString());
        assert(!remainingA1, "Original out-of-stock Variant A1 must be cleanly removed from wishlist");
        console.log("✓ Original out-of-stock Variant A1 was cleanly removed from user wishlist");

        // Cleanup
        await Variant.deleteMany({ productId: { $in: [productA._id, productB._id, productC._id] } });
        await Product.deleteMany({ _id: { $in: [productA._id, productB._id, productC._id] } });
        await Category.deleteOne({ _id: testCat._id });
        await Wishlist.deleteOne({ userId: testUser._id });
        await Cart.deleteOne({ userId: testUser._id });

        console.log("\n==========================================================================");
        console.log("ALL 5 WISHLIST VARIANT SELECTION TESTS PASSED PERFECTLY!");
        console.log("==========================================================================\n");
    } finally {
        await mongoose.disconnect();
    }
}

runTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
