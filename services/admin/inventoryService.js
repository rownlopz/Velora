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

    // 3. Overall Inventory KPI Statistics across all active products (Finding 12)
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
                activeVariants: { $sum: { $cond: [{ $eq: ["$isActive", true] }, 1, 0] } },
                inactiveVariants: { $sum: { $cond: [{ $eq: ["$isActive", false] }, 1, 0] } },
                totalStockUnits: { $sum: { $cond: [{ $eq: ["$isActive", true] }, "$stock", 0] } },
                outOfStockCount: {
                    $sum: {
                        $cond: [
                            { $and: [{ $eq: ["$isActive", true] }, { $eq: ["$stock", 0] }] },
                            1,
                            0,
                        ],
                    },
                },
                lowStockCount: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $eq: ["$isActive", true] },
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
        activeVariants: 0,
        inactiveVariants: 0,
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

    // Filter by Stock Status (Finding 12: accurately filter active / inactive / stock levels)
    if (status === "out_of_stock") {
        pipeline.push({ $match: { isActive: true, stock: 0 } });
    } else if (status === "low_stock") {
        pipeline.push({ $match: { isActive: true, stock: { $gt: 0, $lte: 10 } } });
    } else if (status === "in_stock") {
        pipeline.push({ $match: { isActive: true, stock: { $gt: 10 } } });
    } else if (status === "inactive") {
        pipeline.push({ $match: { isActive: false } });
    } else if (status === "active") {
        pipeline.push({ $match: { isActive: true } });
    }

    // Filter by Search (Product Name, Brand, SKU, Color, Size)
    if (typeof search === "string" && search.trim()) {
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
 * Strict integer parser: rejects floats, non-finite values, and trailing characters.
 * E.g. "12abc" -> null, "1.5" -> null, 1.5 -> null, "12" -> 12.
 */
const parseStrictInteger = (val) => {
    if (typeof val === "number") {
        if (!Number.isFinite(val) || !Number.isInteger(val)) return null;
        return val;
    }
    if (typeof val === "string") {
        const trimmed = val.trim();
        if (!/^-?\d+$/.test(trimmed)) return null;
        const num = Number(trimmed);
        if (!Number.isSafeInteger(num)) return null;
        return num;
    }
    return null;
};

/**
 * Update stock count for a specific variant using conditional atomic updates.
 * If expectedStock is provided, guards against stale overwrites of concurrent checkouts/restocks.
 */
const updateVariantStock = async (variantId, newStock, expectedStock = undefined) => {
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        return { success: false, message: "Invalid variant ID." };
    }

    const stockNumber = parseStrictInteger(newStock);
    if (stockNumber === null || stockNumber < 0) {
        return { success: false, message: "Stock quantity must be a non-negative whole number." };
    }

    // If expectedStock was supplied (e.g. from UI with optimistic concurrency control),
    // ensure the current DB stock matches expectedStock to prevent stale overwrites.
    if (expectedStock !== undefined && expectedStock !== null && expectedStock !== "") {
        const expectedNum = parseStrictInteger(expectedStock);
        if (expectedNum !== null) {
            const updated = await Variant.findOneAndUpdate(
                { _id: variantId, stock: expectedNum },
                { $set: { stock: stockNumber } },
                { new: true }
            );

            if (!updated) {
                const currentVariant = await Variant.findById(variantId);
                if (!currentVariant) {
                    return { success: false, message: "Variant not found." };
                }
                return {
                    success: false,
                    message: `Stock conflict: current stock (${currentVariant.stock}) changed from expected (${expectedNum}). Please refresh before editing.`,
                    currentStock: currentVariant.stock,
                };
            }

            return {
                success: true,
                message: `Stock updated to ${stockNumber} units.`,
                newStock: updated.stock,
                variantId,
            };
        }
    }

    // Atomic update without read-modify-save race
    const updated = await Variant.findOneAndUpdate(
        { _id: variantId },
        { $set: { stock: stockNumber } },
        { new: true }
    );

    if (!updated) {
        return { success: false, message: "Variant not found." };
    }

    return {
        success: true,
        message: `Stock updated to ${stockNumber} units.`,
        newStock: updated.stock,
        variantId,
    };
};

/**
 * Increment or decrement variant stock by delta using atomic operations.
 * Enforces stock never drops below 0 and avoids read-modify-save overwrites.
 */
const adjustVariantStock = async (variantId, delta) => {
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        return { success: false, message: "Invalid variant ID." };
    }

    const deltaNum = parseStrictInteger(delta);
    if (deltaNum === null || deltaNum === 0) {
        return { success: false, message: "Invalid stock adjustment value. Must be a non-zero whole integer." };
    }

    if (deltaNum > 0) {
        // Atomic increment
        const updated = await Variant.findOneAndUpdate(
            { _id: variantId },
            { $inc: { stock: deltaNum } },
            { new: true }
        );

        if (!updated) {
            return { success: false, message: "Variant not found." };
        }

        return {
            success: true,
            message: `Stock adjusted by +${deltaNum}. New stock: ${updated.stock}.`,
            newStock: updated.stock,
            variantId,
        };
    } else {
        // Atomic decrement with condition that stock >= decrementAmount
        const decrementAmount = Math.abs(deltaNum);
        const updated = await Variant.findOneAndUpdate(
            { _id: variantId, stock: { $gte: decrementAmount } },
            { $inc: { stock: deltaNum } },
            { new: true }
        );

        if (!updated) {
            const variantExists = await Variant.findById(variantId);
            if (!variantExists) {
                return { success: false, message: "Variant not found." };
            }
            return {
                success: false,
                message: `Cannot reduce stock below zero. Current stock is ${variantExists.stock}.`,
            };
        }

        return {
            success: true,
            message: `Stock adjusted by ${deltaNum}. New stock: ${updated.stock}.`,
            newStock: updated.stock,
            variantId,
        };
    }
};

module.exports = {
    getInventory,
    updateVariantStock,
    adjustVariantStock,
    parseStrictInteger,
};
