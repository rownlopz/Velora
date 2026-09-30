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
            .sort({ createdAt: -1 })
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

    const variants = await Variant.find({ productId });

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

    for (const v of variants) {
        if (!v.sku || !v.sku.trim()) return "Every variant needs a SKU";

        const sku = v.sku.trim().toUpperCase();
        if (seenSkus.has(sku)) return `Duplicate SKU in this product: ${sku}`;
        seenSkus.add(sku);

        const regularPrice = Number(v.regularPrice);
        if (!regularPrice || regularPrice <= 0) return `Variant ${sku}: a valid regular price is required`;

        const stock = Number(v.stock);
        if (Number.isNaN(stock) || stock < 0) return `Variant ${sku}: stock cannot be negative`;

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
            color: v.color || "",
            size: v.size || "",
            stock: Number(v.stock),
            regularPrice: Number(v.regularPrice),
            salePrice: v.salePrice ? Number(v.salePrice) : null,
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

  
    await Variant.deleteMany({ productId });
    await Variant.insertMany(
        variants.map((v) => ({
            productId: product._id,
            sku: v.sku.trim().toUpperCase(),
            color: v.color || "",
            size: v.size || "",
            stock: Number(v.stock),
            regularPrice: Number(v.regularPrice),
            salePrice: v.salePrice ? Number(v.salePrice) : null,
        }))
    );

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
