const Product = require("../../models/product/productModel");
const Variant = require("../../models/product/variantModel");
const Category = require("../../models/product/categoryModel");
const Review = require("../../models/product/reviewModel");


const { getAuthoritativeItemPrice } = require("../common/pricingService");

const getProductDetail = async (slug) => {
    const product = await Product.findOne({ slug, isDeleted: false }).populate("categoryId", "name slug isActive isDeleted");

    if (!product) {
        return { success: false, reason: "NOT_FOUND", message: "This product could not be found." };
    }

    // Block access to INACTIVE products — treat them as if they don't exist for users.
    if (product.status !== "ACTIVE") {
        return { success: false, reason: "NOT_FOUND", message: "This product could not be found." };
    }

    // Also block if the category is inactive/deleted.
    const categoryInactive =
        !product.categoryId ||
        product.categoryId.isDeleted === true ||
        product.categoryId.isActive === false;

    if (categoryInactive) {
        return { success: false, reason: "NOT_FOUND", message: "This product could not be found." };
    }

    const isUnavailable = false; // Only active products in active categories reach here

    const rawVariants = await Variant.find({ productId: product._id, isActive: true }).sort({ createdAt: 1 });

    if (rawVariants.length === 0) {
        // No purchasable variants at all — nothing to show.
        return { success: false, reason: "UNAVAILABLE", message: "This product is currently unavailable." };
    }

    const variants = await Promise.all(
        rawVariants.map(async (v) => {
            const pricing = await getAuthoritativeItemPrice(v, product);
            const obj = v.toObject ? v.toObject() : v;
            return {
                ...obj,
                effectivePrice: pricing.effectiveUnitPrice,
                appliedOffer: pricing.appliedOffer,
                displayPrice: pricing.displayPrice,
                salePrice: pricing.effectiveUnitPrice < pricing.regularPrice ? pricing.effectiveUnitPrice : obj.salePrice,
            };
        })
    );

    const [reviews, reviewStats] = await Promise.all([
        Review.find({ productId: product._id }).sort({ createdAt: -1 }).limit(10),
        Review.aggregate([
            { $match: { productId: product._id } },
            { $group: { _id: null, avgRating: { $avg: "$rating" }, count: { $sum: 1 } } },
        ]),
    ]);

    const rawRelated = await Product.find({
        _id: { $ne: product._id },
        categoryId: product.categoryId._id || product.categoryId,
        isDeleted: false,
        status: "ACTIVE",
    }).limit(4).lean();

    const relatedProducts = (
        await Promise.all(
            rawRelated.map(async (rp) => {
                const relVariants = await Variant.find({ productId: rp._id, isActive: true });
                if (!relVariants || relVariants.length === 0) return null;
                let minPrice = Infinity;
                for (const v of relVariants) {
                    const priceInfo = await getAuthoritativeItemPrice(v, rp);
                    if (priceInfo.displayPrice > 0 && priceInfo.displayPrice < minPrice) {
                        minPrice = priceInfo.displayPrice;
                    }
                }
                return {
                    _id: rp._id,
                    name: rp.name,
                    slug: rp.slug,
                    thumbnail: rp.thumbnail,
                    displayPrice: Number.isFinite(minPrice) ? minPrice : 0,
                };
            })
        )
    ).filter(Boolean);

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
