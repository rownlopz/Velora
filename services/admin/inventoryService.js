const mongoose = require("mongoose");
const Variant = require("../../models/product/variantModel");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");

const getInventory = async ({
    search = "",
    status = "all",
    categoryId = "all",
    sort = "stock_asc",
    page = 1,
    limit = 10,
}) => {
    const categories = await Category.find({ isDeleted: false }).sort({ name: 1 }).lean();

    const allVariants = await Variant.find({ isActive: true }).lean();
    const stats = {
        totalVariants: allVariants.length,
        totalStockUnits: allVariants.reduce((sum, v) => sum + (v.stock || 0), 0),
        lowStockCount: allVariants.filter((v) => v.stock > 0 && v.stock <= 10).length,
        outOfStockCount: allVariants.filter((v) => v.stock === 0).length,
    };

    const query = { isActive: true };
    if (status === "low" || status === "low_stock") query.stock = { $gt: 0, $lte: 10 };
    else if (status === "out" || status === "out_of_stock") query.stock = 0;
    else if (status === "in" || status === "in_stock") query.stock = { $gt: 10 };

    if (search && search.trim()) {
        const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const matchedProducts = await Product.find({
            isDeleted: false,
            $or: [{ name: regex }, { brand: regex }],
        }).select("_id").lean();
        const matchingProductIds = matchedProducts.map((p) => p._id);

        query.$or = [
            { sku: regex },
            { color: regex },
            { size: regex },
            ...(matchingProductIds.length > 0 ? [{ productId: { $in: matchingProductIds } }] : []),
        ];
    }

    const sortOption = sort === "stock_desc" ? { stock: -1 }
        : sort === "price_desc" ? { regularPrice: -1 }
        : sort === "price_asc" ? { regularPrice: 1 }
        : { stock: 1 };

    let variants = await Variant.find(query)
        .populate("productId", "name thumbnail brand slug categoryId isDeleted")
        .sort(sortOption)
        .lean();

    variants = variants.filter((v) => v.productId && !v.productId.isDeleted);
    if (categoryId && categoryId !== "all" && mongoose.Types.ObjectId.isValid(categoryId)) {
        variants = variants.filter((v) => String(v.productId.categoryId) === String(categoryId));
    }

    if (sort === "name_asc") {
        variants.sort((a, b) => (a.productId?.name || "").localeCompare(b.productId?.name || ""));
    } else if (sort === "name_desc") {
        variants.sort((a, b) => (b.productId?.name || "").localeCompare(a.productId?.name || ""));
    }

    const totalVariants = variants.length;
    const totalPages = Math.ceil(totalVariants / limit) || 1;
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const paginated = variants.slice((currentPage - 1) * limit, currentPage * limit);

    const items = paginated.map((v) => {
        const prod = v.productId || {};
        const cat = categories.find((c) => String(c._id) === String(prod.categoryId)) || {};
        return {
            ...v,
            product: {
                _id: prod._id,
                name: prod.name || "Unnamed Product",
                thumbnail: prod.thumbnail || (v.images && v.images[0]) || "",
                brand: prod.brand || "",
                slug: prod.slug || "",
            },
            category: {
                _id: cat._id,
                name: cat.name || "General",
            },
            productName: prod.name || "Unnamed Product",
            thumbnail: prod.thumbnail || (v.images && v.images[0]) || "",
            categoryName: cat.name || "General",
        };
    });

    return {
        items,
        totalVariants,
        totalPages,
        currentPage,
        stats,
        categories,
        search,
        status,
        categoryId,
        sort,
    };
};

const updateVariantStock = async (variantId, newStock) => {
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        return { success: false, message: "Invalid variant ID." };
    }
    const stockNum = parseInt(newStock, 10);
    if (isNaN(stockNum) || stockNum < 0) {
        return { success: false, message: "Stock quantity must be a non-negative whole number." };
    }

    const updated = await Variant.findByIdAndUpdate(variantId, { $set: { stock: stockNum } }, { new: true });
    if (!updated) return { success: false, message: "Variant not found." };

    return {
        success: true,
        message: `Stock updated to ${stockNum} units.`,
        newStock: updated.stock,
        variantId,
    };
};

const adjustVariantStock = async (variantId, delta) => {
    if (!variantId || !mongoose.Types.ObjectId.isValid(variantId)) {
        return { success: false, message: "Invalid variant ID." };
    }
    const deltaNum = parseInt(delta, 10);
    if (isNaN(deltaNum) || deltaNum === 0) {
        return { success: false, message: "Invalid adjustment amount." };
    }

    const variant = await Variant.findById(variantId);
    if (!variant) return { success: false, message: "Variant not found." };

    if (variant.stock + deltaNum < 0) {
        return { success: false, message: `Cannot reduce stock below zero. Current stock is ${variant.stock}.` };
    }

    variant.stock += deltaNum;
    await variant.save();

    return {
        success: true,
        message: `Stock adjusted by ${deltaNum > 0 ? "+" : ""}${deltaNum}. New stock: ${variant.stock}.`,
        newStock: variant.stock,
        variantId,
    };
};

module.exports = {
    getInventory,
    updateVariantStock,
    adjustVariantStock,
};
