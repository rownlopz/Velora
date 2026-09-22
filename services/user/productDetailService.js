const Product = require("../../models/product/productModel");
const Variant = require("../../models/product/variantModel");
const Review = require("../../models/product/reviewModel");

/**
 * Fetches everything the product detail page needs in one place, and is
 * the single source of truth for whether a product is actually viewable
 * right now. This same function is called on every page load AND every
 * refresh — there is no client-side caching of availability, so a
 * product that becomes blocked/deleted after the page was first opened
 * will correctly stop being viewable the moment the page is reloaded.
 */
const getProductDetail = async (slug) => {
    const product = await Product.findOne({ slug, isDeleted: false }).populate("categoryId", "name slug");

    if (!product) {
        return { success: false, reason: "NOT_FOUND", message: "This product could not be found." };
    }

    if (product.status !== "ACTIVE") {
        return { success: false, reason: "UNAVAILABLE", message: "This product is currently unavailable." };
    }

    const variants = await Variant.find({ productId: product._id, isActive: true }).sort({ createdAt: 1 });

    if (variants.length === 0) {
        // A product with no purchasable variants at all shouldn't be
        // treated as a normal viewable product either.
        return { success: false, reason: "UNAVAILABLE", message: "This product is currently unavailable." };
    }

    const [reviews, reviewStats] = await Promise.all([
        Review.find({ productId: product._id }).sort({ createdAt: -1 }).limit(10),
        Review.aggregate([
            { $match: { productId: product._id } },
            { $group: { _id: null, avgRating: { $avg: "$rating" }, count: { $sum: 1 } } },
        ]),
    ]);

    const relatedProducts = await Product.aggregate([
        {
            $match: {
                _id: { $ne: product._id },
                categoryId: product.categoryId,
                isDeleted: false,
                status: "ACTIVE",
            },
        },
        { $limit: 4 },
        {
            $lookup: {
                from: "variants",
                let: { productId: "$_id" },
                pipeline: [{ $match: { $expr: { $eq: ["$productId", "$$productId"] }, isActive: true } }],
                as: "activeVariants",
            },
        },
        { $match: { "activeVariants.0": { $exists: true } } },
        {
            $addFields: {
                displayPrice: {
                    $min: {
                        $map: {
                            input: "$activeVariants",
                            as: "v",
                            in: { $ifNull: ["$$v.salePrice", "$$v.regularPrice"] },
                        },
                    },
                },
            },
        },
        { $project: { name: 1, slug: 1, thumbnail: 1, displayPrice: 1 } },
    ]);

    const totalStock = variants.reduce((sum, v) => sum + v.stock, 0);

    return {
        success: true,
        product,
        variants,
        totalStock,
        reviews,
        averageRating: reviewStats[0] ? Number(reviewStats[0].avgRating.toFixed(1)) : 0,
        totalReviews: reviewStats[0] ? reviewStats[0].count : 0,
        relatedProducts,
    };
};

/**
 * Cheap re-check used right before an action (e.g. add to cart) — does
 * NOT fetch reviews/related products, just the availability truth.
 * Cart Management (next phase) calls this before trusting any
 * browser-submitted product/variant data.
 */
const checkVariantAvailability = async (variantId) => {
    const variant = await Variant.findById(variantId);
    if (!variant || !variant.isActive) {
        return { available: false, reason: "This item is no longer available." };
    }

    const product = await Product.findOne({ _id: variant.productId, isDeleted: false, status: "ACTIVE" });
    if (!product) {
        return { available: false, reason: "This product is no longer available." };
    }

    if (variant.stock <= 0) {
        return { available: false, reason: "This item is out of stock.", variant, product };
    }

    return { available: true, variant, product };
};

module.exports = { getProductDetail, checkVariantAvailability };
