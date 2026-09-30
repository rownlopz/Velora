const Product = require("../../models/product/productModel");
const Variant = require("../../models/product/variantModel");
const Category = require("../../models/product/categoryModel");
const Review = require("../../models/product/reviewModel");


const getProductDetail = async (slug) => {
    const product = await Product.findOne({ slug, isDeleted: false }).populate("categoryId", "name slug isActive isDeleted");

    if (!product) {
        return { success: false, reason: "NOT_FOUND", message: "This product could not be found." };
    }

    // Determine if the product itself or its category is unavailable.
    const categoryInactive =
        !product.categoryId ||
        product.categoryId.isDeleted === true ||
        product.categoryId.isActive === false;

    const isUnavailable = product.status !== "ACTIVE" || categoryInactive;

    const variants = await Variant.find({ productId: product._id, isActive: true }).sort({ createdAt: 1 });

    if (variants.length === 0) {
        // No purchasable variants at all — nothing to show.
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
                categoryId: product.categoryId._id || product.categoryId,
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
        isUnavailable,
        reviews,
        averageRating: reviewStats[0] ? Number(reviewStats[0].avgRating.toFixed(1)) : 0,
        totalReviews: reviewStats[0] ? reviewStats[0].count : 0,
        relatedProducts,
    };
};


const checkVariantAvailability = async (variantId) => {
    const variant = await Variant.findById(variantId);
    if (!variant || !variant.isActive) {
        return { available: false, reason: "This item is no longer available." };
    }

    const product = await Product.findOne({ _id: variant.productId, isDeleted: false, status: "ACTIVE" });
    if (!product) {
        return { available: false, reason: "This product is no longer available." };
    }

    // Also check the category is active.
    const category = await Category.findOne({ _id: product.categoryId, isDeleted: false, isActive: true });
    if (!category) {
        return { available: false, reason: "This product is currently unavailable." };
    }

    if (variant.stock <= 0) {
        return { available: false, reason: "This item is out of stock.", variant, product };
    }

    return { available: true, variant, product };
};

module.exports = { getProductDetail, checkVariantAvailability };
