const mongoose = require("mongoose");
const Product = require("../../models/product/productModel");
const Variant = require("../../models/product/variantModel");
const Category = require("../../models/product/categoryModel");
const slugify = require("../../utils/slugify");

const getProducts = async ({ search = "", page = 1, limit = 10 }) => {
    const skip = (page - 1) * limit;

    const query = { isDeleted: false };

    if (search.trim()) {
        query.name = { $regex: search.trim(), $options: "i" };
    }

    const [products, totalProducts] = await Promise.all([
        Product.find(query)
            .populate("categoryId", "name")
            .sort({ name: 1 })
            .skip(skip)
            .limit(limit),

        Product.countDocuments(query),
    ]);


    const productIds = products.map((p) => p._id);
    const variantAggregates = await Variant.aggregate([
        { $match: { productId: { $in: productIds } } },
        {
            $group: {
                _id: "$productId",
                totalStock: { $sum: "$stock" },
                minPrice: { $min: "$regularPrice" },
                maxPrice: { $max: "$regularPrice" },
            },
        },
    ]);
    const summaryByProduct = {};
    variantAggregates.forEach((v) => { summaryByProduct[v._id.toString()] = v; });

    const productsWithSummary = products.map((p) => {
        const summary = summaryByProduct[p._id.toString()];
        return {
            ...p.toObject(),
            totalStock: summary ? summary.totalStock : 0,
            minPrice: summary ? summary.minPrice : null,
            maxPrice: summary ? summary.maxPrice : null,
        };
    });

    return {
        products: productsWithSummary,
        totalProducts,
        totalPages: Math.ceil(totalProducts / limit),
        currentPage: page,
    };
};

const getProductById = async (productId) => {
    const product = await Product.findOne({ _id: productId, isDeleted: false }).populate("categoryId", "name");
    if (!product) {
        return { success: false, message: "Product not found" };
    }

    const variants = await Variant.find({ productId, isActive: true });

    return { success: true, product, variants };
};

const findDuplicateProduct = async (name, excludeId = null) => {
    const query = {
        isDeleted: false,
        name: { $regex: `^${name.trim()}$`, $options: "i" },
    };
    if (excludeId) query._id = { $ne: excludeId };
    return Product.findOne(query);
};


const validateVariants = (variants) => {
    if (!Array.isArray(variants) || variants.length === 0) {
        return "At least one product variant is required";
    }

    const seenSkus = new Set();
    const seenCombos = new Set();
    const seenIds = new Set();

    for (const v of variants) {
        if (v._id) {
            const idStr = String(v._id).trim();
            if (idStr) {
                if (seenIds.has(idStr)) return `Duplicate variant ID submitted: ${idStr}`;
                seenIds.add(idStr);
            }
        }

        if (!v.sku || !v.sku.trim()) return "Every variant needs a SKU";

        const sku = v.sku.trim().toUpperCase();
        if (seenSkus.has(sku)) return `Duplicate SKU in this product: ${sku}`;
        seenSkus.add(sku);

        const color = (v.color || "").trim().toLowerCase();
        const size = (v.size || "").trim().toLowerCase();
        const comboKey = `${color}:::${size}`;
        if (seenCombos.has(comboKey)) {
            return `Duplicate color and size combination: "${v.color || 'Default'}" / "${v.size || 'Default'}"`;
        }
        seenCombos.add(comboKey);

        const regularPrice = Number(v.regularPrice);
        if (!regularPrice || regularPrice <= 0) return `Variant ${sku}: a valid regular price is required`;

        const stock = Number(v.stock);
        if (!Number.isInteger(stock) || stock < 0) return `Variant ${sku}: stock must be a non-negative whole integer`;

        if (v.salePrice !== undefined && v.salePrice !== "" && v.salePrice !== null) {
            const salePrice = Number(v.salePrice);
            if (Number.isNaN(salePrice) || salePrice < 0) return `Variant ${sku}: invalid sale price`;
            if (salePrice > regularPrice) return `Variant ${sku}: sale price cannot exceed regular price`;
        }
    }

    return null;
};

const addProduct = async ({ name, description, brand, categoryId, tags, imagePaths, variants }) => {
    const trimmedName = (name || "").trim();

    if (!trimmedName) return { success: false, message: "Product name is required" };

    const category = await Category.findOne({ _id: categoryId, isDeleted: false });
    if (!category) return { success: false, message: "Please select a valid category" };

    if (!imagePaths || imagePaths.length < 3) {
        return { success: false, message: "At least 3 product images are required" };
    }

    const duplicate = await findDuplicateProduct(trimmedName);
    if (duplicate) return { success: false, message: "A product with this name already exists" };

    const variantError = validateVariants(variants);
    if (variantError) return { success: false, message: variantError };

    const skus = variants.map((v) => v.sku.trim().toUpperCase());
    const existingSkuVariant = await Variant.findOne({ sku: { $in: skus } });
    if (existingSkuVariant) {
        return { success: false, message: `SKU already in use: ${existingSkuVariant.sku}` };
    }

    const product = await Product.create({
        name: trimmedName,
        slug: slugify(trimmedName),
        description: description || "",
        brand: brand || "",
        categoryId,
        thumbnail: imagePaths[0],
        images: imagePaths,
        tags: tags || [],
    });

    await Variant.insertMany(
        variants.map((v) => ({
            productId: product._id,
            sku: v.sku.trim().toUpperCase(),
            color: (v.color || "").trim(),
            size: (v.size || "").trim(),
            stock: Number(v.stock),
            regularPrice: Number(v.regularPrice),
            salePrice: v.salePrice !== undefined && v.salePrice !== "" && v.salePrice !== null ? Number(v.salePrice) : null,
            isActive: true,
        }))
    );

    return { success: true, product };
};

const updateProduct = async (productId, { name, description, brand, categoryId, tags, imagePaths, variants }) => {
    const trimmedName = (name || "").trim();

    if (!trimmedName) return { success: false, message: "Product name is required" };

    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) return { success: false, message: "Product not found" };

    const category = await Category.findOne({ _id: categoryId, isDeleted: false });
    if (!category) return { success: false, message: "Please select a valid category" };

    if (!imagePaths || imagePaths.length < 3) {
        return { success: false, message: "At least 3 product images are required" };
    }

    const duplicate = await findDuplicateProduct(trimmedName, productId);
    if (duplicate) return { success: false, message: "A product with this name already exists" };

    const variantError = validateVariants(variants);
    if (variantError) return { success: false, message: variantError };

    // Fetch existing variants belonging to this product
    const currentProductVariants = await Variant.find({ productId });
    const currentVariantMap = new Map(currentProductVariants.map((v) => [v._id.toString(), v]));

    // Validate that all submitted IDs belong to this product
    for (const v of variants) {
        if (v._id) {
            const idStr = String(v._id).trim();
            if (idStr) {
                if (!mongoose.Types.ObjectId.isValid(idStr)) {
                    return { success: false, message: "Invalid variant ID format" };
                }
                if (!currentVariantMap.has(idStr)) {
                    return { success: false, message: `Submitted variant ID does not belong to this product: ${idStr}` };
                }
            }
        }
    }

    const skus = variants.map((v) => v.sku.trim().toUpperCase());
    const existingSkuVariant = await Variant.findOne({
        sku: { $in: skus },
        productId: { $ne: productId }, // allow this product's own SKUs to "match themselves"
    });
    if (existingSkuVariant) {
        return { success: false, message: `SKU already in use: ${existingSkuVariant.sku}` };
    }

    product.name = trimmedName;
    product.slug = slugify(trimmedName);
    product.description = description || "";
    product.brand = brand || "";
    product.categoryId = categoryId;
    product.thumbnail = imagePaths[0];
    product.images = imagePaths;
    product.tags = tags || [];
    await product.save();

    // Preserve existing variant IDs and update in place; create new ones only for new rows
    const submittedIds = new Set();

    for (const v of variants) {
        const idStr = v._id ? String(v._id).trim() : "";
        const sku = v.sku.trim().toUpperCase();
        const color = (v.color || "").trim();
        const size = (v.size || "").trim();
        const stock = Number(v.stock);
        const regularPrice = Number(v.regularPrice);
        const salePrice = v.salePrice !== undefined && v.salePrice !== "" && v.salePrice !== null ? Number(v.salePrice) : null;

        if (idStr && currentVariantMap.has(idStr)) {
            // Update existing variant in place
            await Variant.findByIdAndUpdate(idStr, {
                sku,
                color,
                size,
                stock,
                regularPrice,
                salePrice,
                isActive: true,
            });
            submittedIds.add(idStr);
        } else {
            // Create new variant
            const newVar = await Variant.create({
                productId: product._id,
                sku,
                color,
                size,
                stock,
                regularPrice,
                salePrice,
                isActive: true,
            });
            submittedIds.add(newVar._id.toString());
        }
    }

    // Deactivate removed variants instead of deleting them to preserve order and history references
    const removedVariantIds = currentProductVariants
        .filter((v) => !submittedIds.has(v._id.toString()))
        .map((v) => v._id);

    if (removedVariantIds.length > 0) {
        await Variant.updateMany(
            { _id: { $in: removedVariantIds } },
            { $set: { isActive: false } }
        );
    }

    return { success: true, product };
};

const toggleProductStatus = async (productId) => {
    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) return { success: false, message: "Product not found" };

    product.status = product.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    await product.save();

    return { success: true, product };
};

const softDeleteProduct = async (productId) => {
    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) return { success: false, message: "Product not found" };

    product.isDeleted = true;
    product.deletedAt = new Date();
    product.status = "INACTIVE";
    await product.save();

    return { success: true };
};

module.exports = {
    getProducts,
    getProductById,
    addProduct,
    updateProduct,
    toggleProductStatus,
    softDeleteProduct,
};
