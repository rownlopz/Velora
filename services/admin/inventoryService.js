const mongoose = require("mongoose");
const Variant = require("../../models/product/variantModel");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");

/**
 * Fetch inventory items across products and variants with search, status filters, category filter, and sorting
 */
const getInventory = async ({
    search = "",
    status = "all",
    categoryId = "all",
    sort = "stock_asc",
    page = 1,
    limit = 10,
}) => {
    // 1. Base product query: exclude soft-deleted products
    const productMatch = { isDeleted: false };
    if (categoryId && categoryId !== "all" && mongoose.Types.ObjectId.isValid(categoryId)) {
        productMatch.categoryId = new mongoose.Types.ObjectId(categoryId);
    }

    // 2. Fetch categories for filter dropdown
    const categories = await Category.find({ isDeleted: false }).sort({ name: 1 }).lean();

    // 3. Overall Inventory KPI Statistics across all active products
    const [overallStats] = await Variant.aggregate([
        {
            $lookup: {
                from: "products",
                localField: "productId",
                foreignField: "_id",
                as: "product",
            },
        },
        { $unwind: "$product" },
        { $match: { "product.isDeleted": false } },
        {
            $group: {
                _id: null,
                totalVariants: { $sum: 1 },
                totalStockUnits: { $sum: "$stock" },
                outOfStockCount: {
                    $sum: { $cond: [{ $eq: ["$stock", 0] }, 1, 0] },
                },
                lowStockCount: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $gt: ["$stock", 0] },
                                    { $lte: ["$stock", 10] },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
    ]);

    const stats = overallStats || {
        totalVariants: 0,
        totalStockUnits: 0,
        outOfStockCount: 0,
        lowStockCount: 0,
    };

    // 4. Build aggregation pipeline for paginated results
    const pipeline = [
        {
            $lookup: {
                from: "products",
                localField: "productId",
                foreignField: "_id",
                as: "product",
            },
        },
        { $unwind: "$product" },
        { $match: { "product.isDeleted": false } },
        {
            $lookup: {
                from: "categories",
                localField: "product.categoryId",
                foreignField: "_id",
                as: "category",
            },
        },
        {
            $unwind: {
                path: "$category",
                preserveNullAndEmptyArrays: true,
            },
        },
    ];

    // Filter by Category
    if (categoryId && categoryId !== "all" && mongoose.Types.ObjectId.isValid(categoryId)) {
        pipeline.push({
            $match: { "product.categoryId": new mongoose.Types.ObjectId(categoryId) },
        });
    }

    // Filter by Stock Status
    if (status === "out_of_stock") {
        pipeline.push({ $match: { stock: 0 } });
    } else if (status === "low_stock") {
        pipeline.push({ $match: { stock: { $gt: 0, $lte: 10 } } });
    } else if (status === "in_stock") {
        pipeline.push({ $match: { stock: { $gt: 10 } } });
    }

    // Filter by Search (Product Name, Brand, SKU, Color, Size)
    if (search && search.trim()) {
        const escapedTerm = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escapedTerm, "i");
        pipeline.push({
            $match: {
                $or: [
                    { "product.name": regex },
                    { "product.brand": regex },
                    { sku: regex },
                    { color: regex },
                    { size: regex },
                ],
            },
        });
    }

    // Count matching items
    const countPipeline = [...pipeline, { $count: "total" }];
    const countResult = await Variant.aggregate(countPipeline);
    const totalVariants = countResult.length > 0 ? countResult[0].total : 0;

    // Sorting
    let sortStage = { stock: 1 }; // default: low stock first
    if (sort === "stock_desc") {
        sortStage = { stock: -1 };
    } else if (sort === "name_asc") {
        sortStage = { "product.name": 1, sku: 1 };
    } else if (sort === "name_desc") {
        sortStage = { "product.name": -1, sku: 1 };
    }
    pipeline.push({ $sort: sortStage });

    // Pagination
    const currentPage = Math.max(1, Number(page) || 1);
    const skip = (currentPage - 1) * limit;

    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limit });

    const items = await Variant.aggregate(pipeline);

    return {
        items,
        totalVariants,
        totalPages: Math.ceil(totalVariants / limit) || 1,
        currentPage,
        stats,
        categories,
        search,
        status,
        categoryId,
        sort,
    };
};

/**
 * Update stock count for a specific variant
 */
const updateVariantStock = async (variantId, newStock) => {
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        return { success: false, message: "Invalid variant ID." };
    }

    const stockNumber = parseInt(newStock, 10);
    if (isNaN(stockNumber) || stockNumber < 0) {
        return { success: false, message: "Stock quantity must be a non-negative whole number." };
    }

    const variant = await Variant.findById(variantId);
    if (!variant) {
        return { success: false, message: "Variant not found." };
    }

    variant.stock = stockNumber;
    await variant.save();

    return {
        success: true,
        message: `Stock updated to ${stockNumber} units.`,
        newStock: stockNumber,
        variantId,
    };
};

/**
 * Increment or decrement variant stock by delta
 */
const adjustVariantStock = async (variantId, delta) => {
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        return { success: false, message: "Invalid variant ID." };
    }

    const deltaNum = parseInt(delta, 10);
    if (isNaN(deltaNum) || deltaNum === 0) {
        return { success: false, message: "Invalid stock adjustment value." };
    }

    const variant = await Variant.findById(variantId);
    if (!variant) {
        return { success: false, message: "Variant not found." };
    }

    const nextStock = Math.max(0, variant.stock + deltaNum);
    variant.stock = nextStock;
    await variant.save();

    return {
        success: true,
        message: `Stock adjusted by ${deltaNum > 0 ? "+" : ""}${deltaNum}. New stock: ${nextStock}.`,
        newStock: nextStock,
        variantId,
    };
};

module.exports = {
    getInventory,
    updateVariantStock,
    adjustVariantStock,
};
