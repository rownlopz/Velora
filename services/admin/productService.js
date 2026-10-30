const Product = require("../../models/product/productModel");
const Variant = require("../../models/product/variantModel");
const Category = require("../../models/product/categoryModel");
const slugify = require("../../utils/slugify");

/**
 * Generate unique product slug
 */
const generateUniqueProductSlug = async (name, currentProductId = null) => {
    let baseSlug = slugify(name) || "product";
    let candidate = baseSlug;
    let count = 1;
    while (await Product.findOne({ slug: candidate, _id: { $ne: currentProductId } })) {
        count++;
        candidate = `${baseSlug}-${count}`;
    }
    return candidate;
};

/**
 * List products with variant count, total stock, and min/max prices
 */
const getProducts = async ({ search = "", page = 1, limit = 10 }) => {
    const skip = (Math.max(1, page) - 1) * limit;
    const query = { isDeleted: false };
    if (search && search.trim()) {
        query.name = { $regex: search.trim(), $options: "i" };
    }

    const [products, totalProducts] = await Promise.all([
        Product.find(query).populate("categoryId", "name").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Product.countDocuments(query),
    ]);

    const productIds = products.map((p) => p._id);
    const variants = await Variant.find({ productId: { $in: productIds } }).lean();

    const productsWithSummary = products.map((p) => {
        const pVariants = variants.filter((v) => String(v.productId) === String(p._id));
        const totalStock = pVariants.reduce((sum, v) => sum + (v.stock || 0), 0);
        const prices = pVariants.map((v) => v.regularPrice).filter((pr) => pr != null);
        return {
            ...p,
            totalStock,
            minPrice: prices.length ? Math.min(...prices) : null,
            maxPrice: prices.length ? Math.max(...prices) : null,
        };
    });

    return {
        products: productsWithSummary,
        totalProducts,
        totalPages: Math.ceil(totalProducts / limit) || 1,
        currentPage: page,
    };
};

/**
 * Get product by ID with its variants
 */
const getProductById = async (productId) => {
    const product = await Product.findOne({ _id: productId, isDeleted: false }).populate("categoryId", "name");
    if (!product) return { success: false, message: "Product not found" };

    const variants = await Variant.find({ productId, isActive: true });
    return { success: true, product, variants };
};

/**
 * Common validation for add/update
 */
const validateProduct = (name, categoryId, imagePaths, variants) => {
    if (!name || !name.trim()) return "Product name is required";
    if (!categoryId) return "Please select a valid category";
    if (!imagePaths || imagePaths.length < 3) return "At least 3 product images are required";
    if (!Array.isArray(variants) || variants.length === 0) return "At least one product variant is required";

    const seenSkus = new Set();
    for (const v of variants) {
        if (!v.sku || !v.sku.trim()) return "Every variant needs a SKU";
        const sku = v.sku.trim().toUpperCase();
        if (seenSkus.has(sku)) return `Duplicate SKU in this product: ${sku}`;
        seenSkus.add(sku);

        const regularPrice = Number(v.regularPrice);
        if (!regularPrice || regularPrice <= 0) return `Variant ${sku}: valid regular price required`;
        const stock = Number(v.stock);
        if (isNaN(stock) || stock < 0) return `Variant ${sku}: stock must be 0 or greater`;
    }
    return null;
};

/**
 * Add a new product with variants
 */
const addProduct = async ({ name, description, brand, categoryId, tags, imagePaths, variants }) => {
    const trimmedName = (name || "").trim();
    const validationError = validateProduct(trimmedName, categoryId, imagePaths, variants);
    if (validationError) return { success: false, message: validationError };

    // Check duplicate name
    const existing = await Product.findOne({ isDeleted: false, name: { $regex: `^${trimmedName}$`, $options: "i" } });
    if (existing) return { success: false, message: "A product with this name already exists" };

    // Check duplicate SKUs
    const skus = variants.map((v) => v.sku.trim().toUpperCase());
    const existingSku = await Variant.findOne({ sku: { $in: skus } });
    if (existingSku) return { success: false, message: `SKU already in use: ${existingSku.sku}` };

    const slug = await generateUniqueProductSlug(trimmedName);
    const product = await Product.create({
        name: trimmedName,
        slug,
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
            salePrice: v.salePrice ? Number(v.salePrice) : null,
            isActive: true,
        }))
    );

    return { success: true, product };
};

/**
 * Update an existing product and its variants
 */
const updateProduct = async (productId, { name, description, brand, categoryId, tags, imagePaths, variants }) => {
    const trimmedName = (name || "").trim();
    const validationError = validateProduct(trimmedName, categoryId, imagePaths, variants);
    if (validationError) return { success: false, message: validationError };

    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) return { success: false, message: "Product not found" };

    // Check duplicate name excluding self
    const duplicate = await Product.findOne({ _id: { $ne: productId }, isDeleted: false, name: { $regex: `^${trimmedName}$`, $options: "i" } });
    if (duplicate) return { success: false, message: "A product with this name already exists" };

    product.name = trimmedName;
    product.slug = await generateUniqueProductSlug(trimmedName, productId);
    product.description = description || "";
    product.brand = brand || "";
    product.categoryId = categoryId;
    product.thumbnail = imagePaths[0];
    product.images = imagePaths;
    product.tags = tags || [];
    await product.save();

    // Update existing variants and create new ones
    const submittedIds = new Set();
    for (const v of variants) {
        const sku = v.sku.trim().toUpperCase();
        if (v._id) {
            await Variant.findByIdAndUpdate(v._id, {
                $set: {
                    sku,
                    color: (v.color || "").trim(),
                    size: (v.size || "").trim(),
                    regularPrice: Number(v.regularPrice),
                    salePrice: v.salePrice ? Number(v.salePrice) : null,
                    isActive: true,
                },
            });
            submittedIds.add(String(v._id));
        } else {
            const newVar = await Variant.create({
                productId: product._id,
                sku,
                color: (v.color || "").trim(),
                size: (v.size || "").trim(),
                stock: Number(v.stock),
                regularPrice: Number(v.regularPrice),
                salePrice: v.salePrice ? Number(v.salePrice) : null,
                isActive: true,
            });
            submittedIds.add(String(newVar._id));
        }
    }

    // Deactivate variants removed from form
    await Variant.updateMany({ productId, _id: { $nin: Array.from(submittedIds) } }, { $set: { isActive: false } });

    return { success: true, product };
};

/**
 * Toggle product active status
 */
const toggleProductStatus = async (productId) => {
    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) return { success: false, message: "Product not found" };

    product.isActive = !product.isActive;
    await product.save();
    await Variant.updateMany({ productId }, { $set: { isActive: product.isActive } });
    return { success: true, product };
};

/**
 * Soft delete product
 */
const softDeleteProduct = async (productId) => {
    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) return { success: false, message: "Product not found" };

    product.isDeleted = true;
    product.isActive = false;
    await product.save();
    await Variant.updateMany({ productId }, { $set: { isActive: false } });
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
