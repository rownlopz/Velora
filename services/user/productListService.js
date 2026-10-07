const mongoose = require("mongoose");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");


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


const listProducts = async (filters, limit = 12) => {
    const { search, categories, sizes, colors, minPrice, maxPrice, sort, page } = filters;
    const skip = (page - 1) * limit;

    const pipeline = [];

 
    // Only show ACTIVE, non-deleted products to users
    const baseMatch = { isDeleted: false, status: "ACTIVE" };
    if (search) {
        baseMatch.$or = [
            { name: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
        ];
    }
    pipeline.push({ $match: baseMatch });

  
    if (categories && categories.length > 0) {
        // Only allow filtering by active, non-deleted categories
        const catDocs = await Category.find({ slug: { $in: categories }, isDeleted: false, isActive: true });
        const catIds = catDocs.map(c => c._id);
        if (catIds.length > 0) {
            pipeline.push({ $match: { categoryId: { $in: catIds } } });
        } else {
            pipeline.push({ $match: { categoryId: new mongoose.Types.ObjectId() } });
        }
    }

    // Join the category doc — only include products with active, non-deleted categories.
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
    // Exclude products whose category is inactive or deleted
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
        // Case-insensitive color matching using regex
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

    // A product with zero active variants has no price info — exclude it.
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
            // isUnavailable is now always false since we filtered INACTIVE products above.
            // We keep the field for template compatibility.
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
                        name: 1, slug: 1, thumbnail: 1,
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
    const products = result.data;
    const totalProducts = result.totalCount[0] ? result.totalCount[0].count : 0;

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
