const mongoose = require("mongoose");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");

/**
 * Pure function: turns raw query-string values into a clean, typed
 * filter object. Kept separate from the database logic below so it can
 * be unit-tested without a database connection.
 */
const parseListingQuery = (query) => {
    const search = (query.search || "").trim();
    
    const categories = (Array.isArray(query.category) ? query.category : (query.category || "").split(","))
        .map(s => s.trim()).filter(Boolean);
        
    const sizes = (Array.isArray(query.size) ? query.size : (query.size || "").split(","))
        .map(s => s.trim()).filter(Boolean);
        
    const colors = (Array.isArray(query.color) ? query.color : (query.color || "").split(","))
        .map(s => s.trim()).filter(Boolean);

    const minPrice = query.minPrice !== undefined && query.minPrice !== "" ? Number(query.minPrice) : undefined;
    const maxPrice = query.maxPrice !== undefined && query.maxPrice !== "" ? Number(query.maxPrice) : undefined;

    const allowedSorts = ["price-asc", "price-desc", "name-asc", "name-desc"];
    const sort = allowedSorts.includes(query.sort) ? query.sort : "newest";

    let page = Number(query.page);
    if (!Number.isInteger(page) || page < 1) page = 1;

    return {
        search,
        categories,
        sizes,
        colors,
        minPrice: Number.isFinite(minPrice) && minPrice >= 0 ? minPrice : undefined,
        maxPrice: Number.isFinite(maxPrice) && maxPrice >= 0 ? maxPrice : undefined,
        sort,
        page,
    };
};

const SORT_STAGES = {
    "price-asc": { displayPrice: 1 },
    "price-desc": { displayPrice: -1 },
    "name-asc": { name: 1 },
    "name-desc": { name: -1 },
    "newest": { createdAt: -1 },
};

/**
 * Builds and runs ONE aggregation pipeline combining search + category +
 * price range + sort + pagination. Price lives on Variant, not
 * Product, so a $lookup is required to filter/sort by it — this is why a
 * plain Product.find() can't do this alone.
 */
const listProducts = async (filters, limit = 12) => {
    const { search, categories, sizes, colors, minPrice, maxPrice, sort, page } = filters;
    const skip = (page - 1) * limit;

    const pipeline = [];

    // Stage 1: base visibility — only listed, non-deleted products ever
    // reach the storefront, no matter what else is filtered.
    const baseMatch = { isDeleted: false, status: "ACTIVE" };
    if (search) baseMatch.name = { $regex: search, $options: "i" };
    pipeline.push({ $match: baseMatch });

    if (categories && categories.length > 0) {
        const catDocs = await Category.find({ slug: { $in: categories }, isDeleted: false });
        const catIds = catDocs.map(c => c._id);
        if (catIds.length > 0) {
            pipeline.push({ $match: { categoryId: { $in: catIds } } });
        } else {
            pipeline.push({ $match: { categoryId: new mongoose.Types.ObjectId() } });
        }
    }

    // Stage 3: join active (non-blocked) variants to compute price + stock
    const variantMatch = { $expr: { $eq: ["$productId", "$$productId"] }, isActive: true };
    if (sizes && sizes.length > 0) {
        variantMatch.size = { $in: sizes };
    }
    if (colors && colors.length > 0) {
        variantMatch.color = { $in: colors };
    }

    pipeline.push({
        $lookup: {
            from: "variants",
            let: { productId: "$_id" },
            pipeline: [
                { $match: variantMatch },
            ],
            as: "activeVariants",
        },
    });

    // A product with zero active variants has nothing purchasable —
    // exclude it rather than showing a broken "no price" card.
    pipeline.push({ $match: { "activeVariants.0": { $exists: true } } });

    pipeline.push({
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
            totalStock: { $sum: "$activeVariants.stock" },
        },
    });

    // Stage 4: price range, only possible AFTER displayPrice exists
    if (minPrice !== undefined || maxPrice !== undefined) {
        const priceMatch = {};
        if (minPrice !== undefined) priceMatch.$gte = minPrice;
        if (maxPrice !== undefined) priceMatch.$lte = maxPrice;
        pipeline.push({ $match: { displayPrice: priceMatch } });
    }

    pipeline.push({ $sort: SORT_STAGES[sort] || SORT_STAGES.newest });

    // Stage 5: get the paginated page AND the total count in the SAME
    // query via $facet — avoids a second round trip and avoids ever
    // loading the full result set into memory.
    pipeline.push({
        $facet: {
            data: [
                { $skip: skip },
                { $limit: limit },
                {
                    $project: {
                        name: 1, slug: 1, thumbnail: 1, brand: 1,
                        displayPrice: 1, totalStock: 1, averageRating: 1, totalReviews: 1,
                    },
                },
            ],
            totalCount: [{ $count: "count" }],
        },
    });

    const [result] = await Product.aggregate(pipeline);
    const products = result.data;
    const totalProducts = result.totalCount[0] ? result.totalCount[0].count : 0;

    return {
        products,
        totalProducts,
        totalPages: Math.ceil(totalProducts / limit),
        currentPage: page,
    };
};

/**
 * Sidebar data: active categories (for the filter list) and the overall
 * min/max price across all listed products (to bound the price filter).
 */
const getListingFilterOptions = async () => {
    const categories = await Category.find({ isDeleted: false, isActive: true }).sort({ name: 1 });

    const [priceBounds] = await Product.aggregate([
        { $match: { isDeleted: false, status: "ACTIVE" } },
        {
            $lookup: {
                from: "variants",
                let: { productId: "$_id" },
                pipeline: [{ $match: { $expr: { $eq: ["$productId", "$$productId"] }, isActive: true } }],
                as: "activeVariants",
            },
        },
        { $unwind: "$activeVariants" },
        {
            $group: {
                _id: null,
                minPrice: { $min: { $ifNull: ["$activeVariants.salePrice", "$activeVariants.regularPrice"] } },
                maxPrice: { $max: { $ifNull: ["$activeVariants.salePrice", "$activeVariants.regularPrice"] } },
            },
        },
    ]);

    const [variantAttributes] = await Product.aggregate([
        { $match: { isDeleted: false, status: "ACTIVE" } },
        {
            $lookup: {
                from: "variants",
                let: { productId: "$_id" },
                pipeline: [{ $match: { $expr: { $eq: ["$productId", "$$productId"] }, isActive: true } }],
                as: "activeVariants",
            },
        },
        { $unwind: "$activeVariants" },
        {
            $group: {
                _id: null,
                sizes: { $addToSet: "$activeVariants.size" },
                colors: { $addToSet: "$activeVariants.color" },
            },
        },
    ]);

    return {
        categories,
        priceMin: priceBounds ? priceBounds.minPrice : 0,
        priceMax: priceBounds ? priceBounds.maxPrice : 0,
        availableSizes: variantAttributes ? variantAttributes.sizes.filter(Boolean).sort() : [],
        availableColors: variantAttributes ? variantAttributes.colors.filter(Boolean).sort() : [],
    };
};

module.exports = { parseListingQuery, listProducts, getListingFilterOptions };
