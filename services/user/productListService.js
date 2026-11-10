const mongoose = require("mongoose");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");
const escapeRegex = require("../../utils/escapeRegex");

const parseListingQuery = (query = {}) => {
    const search = typeof query.search === "string" ? query.search.trim() : "";

    const parseArrayOrCsv = (val) => {
        if (Array.isArray(val)) {
            return val.map(s => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
        }
        if (typeof val === "string") {
            return val.split(",").map(s => s.trim()).filter(Boolean);
        }
        return [];
    };

    const categories = parseArrayOrCsv(query.category);
    const sizes = parseArrayOrCsv(query.size);
    const colors = parseArrayOrCsv(query.color);

    const minPrice = query.minPrice !== undefined && query.minPrice !== "" ? Number(query.minPrice) : undefined;
    const maxPrice = query.maxPrice !== undefined && query.maxPrice !== "" ? Number(query.maxPrice) : undefined;

    const allowedSorts = ["price-asc", "price-desc", "name-asc", "name-desc"];
    const sort = typeof query.sort === "string" && allowedSorts.includes(query.sort) ? query.sort : "newest";

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

const listProducts = async (filters, limit = 12) => {
    const { search, categories, sizes, colors, minPrice, maxPrice, sort, page } = filters;
    const skip = (page - 1) * limit;

    const pipeline = [];

    const baseMatch = { isDeleted: false, status: "ACTIVE" };
    if (search) {
        const escaped = escapeRegex(search);
        baseMatch.$or = [
            { name: { $regex: escaped, $options: "i" } },
            { description: { $regex: escaped, $options: "i" } },
        ];
    }
    pipeline.push({ $match: baseMatch });

    if (categories && categories.length > 0) {

        const catDocs = await Category.find({ slug: { $in: categories }, isDeleted: false, isActive: true });
        const catIds = catDocs.map(c => c._id);
        if (catIds.length > 0) {
            pipeline.push({ $match: { categoryId: { $in: catIds } } });
        } else {
            pipeline.push({ $match: { categoryId: new mongoose.Types.ObjectId() } });
        }
    }

    pipeline.push({
        $lookup: {
            from: "categories",
            localField: "categoryId",
            foreignField: "_id",
            as: "categoryDoc",
        },
    });
    pipeline.push({
        $addFields: {
            categoryDoc: { $arrayElemAt: ["$categoryDoc", 0] },
        },
    });

    pipeline.push({
        $match: {
            "categoryDoc.isActive": true,
            "categoryDoc.isDeleted": false,
        },
    });

    const variantPipeline = [
        { $match: { $expr: { $eq: ["$productId", "$$productId"] }, isActive: true } },
    ];
    if (sizes && sizes.length > 0) {
        variantPipeline.push({ $match: { size: { $in: sizes } } });
    }
    if (colors && colors.length > 0) {

        const colorRegexes = colors.map(c => new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
        variantPipeline.push({ $match: { color: { $in: colorRegexes } } });
    }

    pipeline.push({
        $lookup: {
            from: "variants",
            let: { productId: "$_id" },
            pipeline: variantPipeline,
            as: "activeVariants",
        },
    });

    pipeline.push({ $match: { "activeVariants.0": { $exists: true } } });

    const now = new Date();
    pipeline.push({
        $lookup: {
            from: "offers",
            let: { pId: "$_id", cId: "$categoryId" },
            pipeline: [
                {
                    $match: {
                        $expr: {
                            $and: [
                                { $eq: ["$isActive", true] },
                                { $lte: ["$startDate", now] },
                                { $gte: ["$endDate", now] },
                                {
                                    $or: [
                                        {
                                            $and: [
                                                { $eq: ["$offerType", "PRODUCT"] },
                                                {
                                                    $or: [
                                                        { $eq: ["$productId", "$$pId"] },
                                                        { $in: ["$$pId", { $ifNull: ["$productIds", []] }] },
                                                    ],
                                                },
                                            ],
                                        },
                                        { $and: [{ $eq: ["$offerType", "CATEGORY"] }, { $eq: ["$categoryId", "$$cId"] }] },
                                    ],
                                },
                            ],
                        },
                    },
                },
            ],
            as: "matchedOffers",
        },
    });

    pipeline.push({
        $addFields: {
            displayPrice: {
                $min: {
                    $map: {
                        input: "$activeVariants",
                        as: "v",
                        in: {
                            $let: {
                                vars: {
                                    basePrice: { $ifNull: ["$$v.salePrice", "$$v.regularPrice"] },
                                    regPrice: "$$v.regularPrice",
                                },
                                in: {
                                    $cond: [
                                        { $gt: [{ $size: "$matchedOffers" }, 0] },
                                        {
                                            $let: {
                                                vars: {
                                                    maxSavings: {
                                                        $max: {
                                                            $map: {
                                                                input: "$matchedOffers",
                                                                as: "off",
                                                                in: {
                                                                    $cond: [
                                                                        { $eq: ["$$off.discountType", "PERCENTAGE"] },
                                                                        {
                                                                            $let: {
                                                                                vars: {
                                                                                    pctDiscount: {
                                                                                        $round: [
                                                                                            {
                                                                                                $divide: [
                                                                                                    { $multiply: ["$$regPrice", "$$off.discountValue"] },
                                                                                                    100,
                                                                                                ],
                                                                                            },
                                                                                            2,
                                                                                        ],
                                                                                    },
                                                                                },
                                                                                in: {
                                                                                    $cond: [
                                                                                        {
                                                                                            $and: [
                                                                                                { $ne: ["$$off.maxDiscount", null] },
                                                                                                { $gt: ["$$off.maxDiscount", 0] },
                                                                                            ],
                                                                                        },
                                                                                        { $min: ["$$pctDiscount", "$$off.maxDiscount"] },
                                                                                        "$$pctDiscount",
                                                                                    ],
                                                                                },
                                                                            },
                                                                        },
                                                                        { $min: ["$$regPrice", "$$off.discountValue"] },
                                                                    ],
                                                                },
                                                            },
                                                        },
                                                    },
                                                },
                                                in: {
                                                    $min: [
                                                        "$$basePrice",
                                                        {
                                                            $round: [
                                                                { $max: [0, { $subtract: ["$$regPrice", "$$maxSavings"] }] },
                                                                2,
                                                            ],
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                        "$$basePrice",
                                    ],
                                },
                            },
                        },
                    },
                },
            },
            totalStock: { $sum: "$activeVariants.stock" },
            isUnavailable: false,
        },
    });

    if (minPrice !== undefined || maxPrice !== undefined) {
        const priceMatch = {};
        if (minPrice !== undefined) priceMatch.$gte = minPrice;
        if (maxPrice !== undefined) priceMatch.$lte = maxPrice;
        pipeline.push({ $match: { displayPrice: priceMatch } });
    }

    pipeline.push({ $sort: SORT_STAGES[sort] || SORT_STAGES.newest });

    pipeline.push({
        $facet: {
            data: [
                { $skip: skip },
                { $limit: limit },
                {
                    $project: {
                        name: 1, slug: 1, thumbnail: 1, categoryId: 1,
                        displayPrice: 1, totalStock: 1, averageRating: 1,
                        totalReviews: 1, isUnavailable: 1, status: 1,
                        defaultVariantId: { $arrayElemAt: ["$activeVariants._id", 0] },
                        variantIds: "$activeVariants._id",
                    },
                },
            ],
            totalCount: [{ $count: "count" }],
        },
    });

    const [result] = await Product.aggregate(pipeline);
    const rawProducts = result.data || [];
    const totalProducts = result.totalCount[0] ? result.totalCount[0].count : 0;

    const { getAuthoritativeItemPrice } = require("../common/pricingService");
    const Variant = require("../../models/product/variantModel");

    const products = await Promise.all(
        rawProducts.map(async (p) => {
            if (p.variantIds && p.variantIds.length > 0) {
                const variants = await Variant.find({ _id: { $in: p.variantIds }, isActive: true });
                let cheapestPrice = Infinity;
                for (const v of variants) {
                    const priceInfo = await getAuthoritativeItemPrice(v, p);
                    if (priceInfo.displayPrice > 0 && priceInfo.displayPrice < cheapestPrice) {
                        cheapestPrice = priceInfo.displayPrice;
                    }
                }
                if (Number.isFinite(cheapestPrice) && cheapestPrice > 0) {
                    return { ...p, displayPrice: cheapestPrice };
                }
            }
            return p;
        })
    );

    return {
        products,
        totalProducts,
        totalPages: Math.ceil(totalProducts / limit),
        currentPage: page,
    };
};

const getListingFilterOptions = async () => {
    const categories = await Category.find({ isDeleted: false, isActive: true }).sort({ name: 1 });
    const activeCatIds = categories.map(c => c._id);

    const [priceBounds] = await Product.aggregate([
        { $match: { isDeleted: false, status: "ACTIVE", categoryId: { $in: activeCatIds } } },
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
        { $match: { isDeleted: false, status: "ACTIVE", categoryId: { $in: activeCatIds } } },
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
