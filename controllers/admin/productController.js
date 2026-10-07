const {
    getProducts,
    getProductById,
    addProduct,
    updateProduct,
    toggleProductStatus,
    softDeleteProduct,
} = require("../../services/admin/productService");

const { getCategories } = require("../../services/admin/categoryService");


const parseVariants = (body) => {
    if (!body.variants) return [];
    return Array.isArray(body.variants) ? body.variants : Object.values(body.variants);
};

const parseTags = (tagsInput) => {
    if (!tagsInput) return [];
    return tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
};

const loadProducts = async (req, res) => {
    try {
        const search = req.query.search || "";
        const page = Number(req.query.page) || 1;

        const result = await getProducts({ search, page, limit: 10 });

        res.render("admin/products", {
            products: result.products,
            search,
            currentPage: result.currentPage,
            totalPages: result.totalPages,
            totalProducts: result.totalProducts,
        });
    } catch (error) {
        console.error("Load Products Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadAddProduct = async (req, res) => {
    try {
        const categoryResult = await getCategories({ search: "", page: 1, limit: 100 });
        const uploadError = req.session.productUploadError || null;
        delete req.session.productUploadError;

        res.render("admin/product-form", {
            title: "Add Product",
            isEdit: false,
            product: {},
            variants: [{}],
            categories: categoryResult.categories,
            error: uploadError,
        });
    } catch (error) {
        console.error("Load Add Product Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadEditProduct = async (req, res) => {
    try {
        const result = await getProductById(req.params.productId);
        if (!result.success) return res.redirect("/admin/products");

        const categoryResult = await getCategories({ search: "", page: 1, limit: 100 });
        const uploadError = req.session.productUploadError || null;
        delete req.session.productUploadError;

        res.render("admin/product-form", {
            title: "Edit Product",
            isEdit: true,
            product: result.product,
            variants: result.variants,
            categories: categoryResult.categories,
            error: uploadError,
        });
    } catch (error) {
        console.error("Load Edit Product Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const addProductController = async (req, res) => {
    try {
        const { name, description, brand, categoryId, tags } = req.body;
        const variants = parseVariants(req.body);

        const keptExisting = req.body.existingImages
            ? (Array.isArray(req.body.existingImages) ? req.body.existingImages : [req.body.existingImages])
            : [];
        const newlyUploaded = (req.files || []).map((f) => f.savedPath);
        const imagePaths = [...keptExisting, ...newlyUploaded];

        const result = await addProduct({
            name, description, brand, categoryId,
            tags: parseTags(tags),
            imagePaths,
            variants,
        });

        if (!result.success) {
            const categoryResult = await getCategories({ search: "", page: 1, limit: 100 });
            return res.status(400).render("admin/product-form", {
                title: "Add Product",
                isEdit: false,
                product: { name, description, brand, categoryId, tags, images: imagePaths },
                variants: variants.length ? variants : [{}],
                categories: categoryResult.categories,
                error: result.message,
            });
        }

        res.redirect("/admin/products");
    } catch (error) {
        console.error("Add Product Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const updateProductController = async (req, res) => {
    try {
        const { productId } = req.params;
        const { name, description, brand, categoryId, tags } = req.body;
        const variants = parseVariants(req.body);

        const keptExisting = req.body.existingImages
            ? (Array.isArray(req.body.existingImages) ? req.body.existingImages : [req.body.existingImages])
            : [];
        const newlyUploaded = (req.files || []).map((f) => f.savedPath);
        const imagePaths = [...keptExisting, ...newlyUploaded];

        const result = await updateProduct(productId, {
            name, description, brand, categoryId,
            tags: parseTags(tags),
            imagePaths,
            variants,
        });

        if (!result.success) {
            const categoryResult = await getCategories({ search: "", page: 1, limit: 100 });
            return res.status(400).render("admin/product-form", {
                title: "Edit Product",
                isEdit: true,
                product: { _id: productId, name, description, brand, categoryId, tags, images: imagePaths },
                variants: variants.length ? variants : [{}],
                categories: categoryResult.categories,
                error: result.message,
            });
        }

        res.redirect("/admin/products");
    } catch (error) {
        console.error("Update Product Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const toggleProductStatusController = async (req, res) => {
    try {
        const { productId } = req.params;
        const { search = "", page = 1 } = req.body;

        const result = await toggleProductStatus(productId);
        if (!result.success) return res.status(404).send(result.message);

        const params = new URLSearchParams({ search, page });
        res.redirect(`/admin/products?${params.toString()}`);
    } catch (error) {
        console.error("Toggle Product Status Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const deleteProductController = async (req, res) => {
    try {
        const { productId } = req.params;
        const { search = "", page = 1 } = req.body;

        const result = await softDeleteProduct(productId);
        if (!result.success) return res.status(404).send(result.message);

        const params = new URLSearchParams({ search, page });
        res.redirect(`/admin/products?${params.toString()}`);
    } catch (error) {
        console.error("Delete Product Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = {
    loadProducts,
    loadAddProduct,
    loadEditProduct,
    addProductController,
    updateProductController,
    toggleProductStatusController,
    deleteProductController,
};
